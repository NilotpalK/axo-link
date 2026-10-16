'use strict';
// `axo claude` end to end, with a stand-in for claude that fires the same hook
// requests Claude Code does: the session reaches the roster, words sent from
// the pill land in the terminal and get submitted, the hooks move its state
// (with Claude's last message kept word for word), the screen can be read from
// another machine, strangers are kept off the hook listener, and Stop ends it.
// The launcher runs as its own process, as it does in a terminal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { startHub } = require('../hub/hub');
const { connect } = require('../shared/link');
const { stateMachine } = require('./axo');

const until = (pred, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    const v = pred();
    if (v) return resolve(v);
    if (Date.now() - t0 > ms) return reject(new Error('timed out'));
    setTimeout(poll, 20);
  })();
});

// Stands in for claude: reads its hook address from --settings, the way Claude
// Code does, reads keys raw like a TUI (Enter submits, Ctrl+J is a new line),
// and for each prompt submitted fires the hooks a real turn would. "ask" stops
// at a permission prompt; "fail" ends on an API error.
const FAKE = `
const http = require('node:http');
const fs = require('node:fs');
const settings = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--settings') + 1], 'utf8'));
const url = new URL(settings.hooks.Stop[0].hooks[0].url);
const post = (event, extra = {}, { path = url.pathname, origin } = {}) => new Promise((done) => {
  const req = http.request({ host: url.hostname, port: url.port, path, method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) } }, (res) => { res.resume(); done(res.statusCode); });
  req.end(JSON.stringify({ hook_event_name: event, session_id: 'S1', ...extra }));
});
(async () => {
  await post('SessionStart', { source: 'startup' });
  console.log('BAD<' + await post('Stop', {}, { path: url.pathname + 'x' }) + '>');
  console.log('ORIGIN<' + await post('Stop', {}, { origin: 'https://example.com' }) + '>');
  console.log('fake ready');
})();
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let line = '';
process.stdin.on('data', async (d) => {
  console.log('KEYS<' + [...d].map((c) => c.charCodeAt(0)).join(',') + '>');
  if (d.startsWith('\\x1b')) return;   // arrows, Esc
  for (const ch of d) {
    if (ch === '\\x7f' || ch === '\\b') { line = line.slice(0, -1); continue; }
    if (ch !== '\\r') { line += ch; continue; }
    const said = line;
    line = '';
    console.log('GOT<' + JSON.stringify(said) + '>');
    await post('UserPromptSubmit', { prompt: said });
    if (said === 'ask') { await post('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }); continue; }
    if (said === 'fail') { await post('StopFailure', { error: 'rate_limit', error_details: '429 Too Many Requests' }); continue; }
    await post('PostToolUse', { tool_name: 'Edit', tool_input: {} });
    await post('PostToolUse', { tool_name: 'Edit', tool_input: {} });
    await post('Stop', { last_assistant_message: 'Done with "' + said + '". All 3 tests pass.' });
  }
});
`;

test('a session moves through its states as the hooks report them', () => {
  const states = [];
  const on = stateMachine((patch) => states.push(patch));
  on({ hook_event_name: 'UserPromptSubmit', prompt: 'clean up' });
  on({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf ./build && npm run build -- --production' } });
  on({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  on({ hook_event_name: 'Stop', last_assistant_message: 'Rebuilt. Want me to deploy it?' });
  assert.equal(states[0].state, 'running');
  assert.deepEqual(states[1].pending, ['Bash(rm -rf ./build && npm run build -- --production)'], 'the whole command');
  assert.equal(states[1].waiting_kind, 'approval_request');
  assert.equal(states[2].state, 'running', 'the tool ran, so the prompt was answered');
  assert.equal(states[3].last, 'Rebuilt. Want me to deploy it?');
  assert.equal(states[3].waiting_kind, 'question');
  assert.equal(states[3].did, 'Bash');

  // an API error ends the turn with StopFailure instead of Stop
  on({ hook_event_name: 'UserPromptSubmit', prompt: 'again' });
  on({ hook_event_name: 'StopFailure', error: 'overloaded', error_details: '529 Overloaded' });
  assert.equal(states[5].state, 'error');
  assert.equal(states[5].summary, 'the turn failed (overloaded: 529 Overloaded)');
  assert.equal(states[5].last, undefined, "its last words aren't wiped when the error carries none");
});

test('axo claude: listed, typed into, followed through its hooks, its screen read, stopped', async () => {
  const hub = startHub({ port: 0, token: 'secret' });
  await once(hub, 'listening');
  const url = `ws://127.0.0.1:${hub.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axo-'));
  const hubFile = path.join(dir, 'hub.json');
  fs.writeFileSync(hubFile, JSON.stringify({ url, token: 'secret' }));
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, FAKE);

  const launcher = spawn(process.execPath, [path.join(__dirname, 'axo.js'), 'claude', fake], {
    cwd: dir, env: { ...process.env, AXO_HUB_FILE: hubFile, AXO_CLAUDE: process.execPath },
  });
  let screen = '';
  launcher.stdout.on('data', (d) => { screen += d; });
  const exited = once(launcher, 'exit');

  const seen = [];
  const pill = connect({
    url, token: 'secret', device: 'pill',
    sessions: Object.assign(new EventEmitter(), { list: () => [] }),
    onMessage: (m) => seen.push(m),
  });
  const latest = () => seen.findLast((m) => m.t === 'roster')?.agents.find((a) => a.kind === 'terminal');
  try {
    const s = await until(latest, 15000);
    assert.equal(s.label, path.basename(dir), 'named after the folder it was started in');
    await until(() => screen.includes('fake ready'), 15000);
    assert.ok(screen.includes('BAD<404>'), 'wrong secret: turned away');
    assert.ok(screen.includes('ORIGIN<404>'), 'a browser: turned away');

    // you've half-typed something in the terminal: axo doesn't type on top of it
    launcher.stdin.write('ab');
    await until(() => /KEYS<[\d,]*98>/.test(screen), 15000);
    await assert.rejects(pill.do('send', s.id, 'hello'), /half-typed/);
    launcher.stdin.write('\x7f\x7f');   // and rubbed it out
    await until(() => /KEYS<(8|127)\b/.test(screen), 15000);

    assert.equal((await pill.do('send', s.id, 'hello   there')).ok, true, 'ok once it is typed in');
    await until(() => screen.includes('GOT<"hello there">'), 15000);   // typed, then submitted with Enter

    const done = await until(() => latest()?.state === 'waiting' && latest(), 15000);
    assert.equal(done.waiting_kind, 'finished');
    assert.equal(done.last, 'Done with "hello there". All 3 tests pass.', "Claude's words, whole");
    assert.equal(done.prompt, 'hello there');
    assert.equal(done.did, 'Edit ×2');
    assert.equal(done.claude_session, 'S1', "Claude's own session id, taken from its events");
    assert.ok(seen.some((m) => m.t === 'hand'), 'a finished turn raises its hand');

    // more than one line goes in as one prompt, lines kept
    await pill.do('send', s.id, 'line one\n  line two');
    await until(() => screen.includes('GOT<"line one\\nline two">'), 15000);
    await until(() => latest()?.last === 'Done with "line one\nline two". All 3 tests pass.', 15000);

    // a permission prompt is up: typed words or keys could answer it, so neither goes in
    await pill.do('send', s.id, 'ask');
    await until(() => latest()?.waiting_kind === 'approval_request', 15000);
    await assert.rejects(pill.do('send', s.id, 'yes'), /permission prompt/);
    await assert.rejects(pill.do('press', s.id, ['enter']), /permission prompt/);
    launcher.stdin.write('\x1b');   // you press Esc to decline it, and no hook says so
    await until(() => latest()?.state === 'idle', 15000);

    // keys for a menu, one at a time, and only the ones axo may press
    await pill.do('press', s.id, ['down', 'up']);
    await until(() => screen.includes('KEYS<27,91,66>') && screen.includes('KEYS<27,91,65>'), 15000);
    await assert.rejects(pill.do('press', s.id, ['ctrl+c']), /no key called/);

    // an API error ends the turn: it shows as failed, and raises its hand
    await pill.do('send', s.id, 'fail');
    const failed = await until(() => latest()?.state === 'error' && latest(), 15000);
    assert.equal(failed.summary, 'the turn failed (rate_limit: 429 Too Many Requests)');
    assert.ok(seen.some((m) => m.t === 'hand' && m.agent.state === 'error'));

    // asked from another machine, through the hub
    const shot = await pill.ask({ t: 'query', op: 'screen', id: s.id });
    assert.match(shot.text, /GOT<"fail">/);

    await pill.do('stop', s.id);
    await exited;
    await until(() => !latest(), 5000);
  } finally {
    launcher.kill();
    pill.close();
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
