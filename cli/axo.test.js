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
// Code does, then for each line typed in fires the hooks a real turn would.
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
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (d) => {
  const line = d.trim();
  console.log('GOT<' + line + '>');
  await post('UserPromptSubmit', { prompt: line });
  await post('PostToolUse', { tool_name: 'Edit', tool_input: {} });
  await post('PostToolUse', { tool_name: 'Edit', tool_input: {} });
  await post('Stop', { last_assistant_message: 'Done with "' + line + '". All 3 tests pass.' });
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

    pill.do('send', s.id, 'hello   there');
    await until(() => screen.includes('GOT<hello there>'), 15000);   // typed, then submitted with Enter

    const done = await until(() => latest()?.state === 'waiting' && latest(), 15000);
    assert.equal(done.waiting_kind, 'finished');
    assert.equal(done.last, 'Done with "hello there". All 3 tests pass.', "Claude's words, whole");
    assert.equal(done.prompt, 'hello there');
    assert.equal(done.did, 'Edit ×2');
    assert.equal(done.claude_session, 'S1', "Claude's own session id, taken from its events");
    assert.ok(seen.some((m) => m.t === 'hand'), 'a finished turn raises its hand');

    // asked from another machine, through the hub
    const shot = await pill.ask({ t: 'query', op: 'screen', id: s.id });
    assert.match(shot.text, /GOT<hello there>/);

    pill.do('stop', s.id);
    await exited;
    await until(() => !latest(), 5000);
  } finally {
    launcher.kill();
    pill.close();
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
