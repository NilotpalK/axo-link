'use strict';
// The checks that matter: a `result` line must settle the session, classify why
// it is waiting, and say what the agent did. If these break, the pill lies and
// the voice layer reads out the wrong thing.
const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { Sessions, brief } = require('../sessions');

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.written = [];
  child.stdin.on('data', (d) => child.written.push(String(d)));
  child.kill = () => child.emit('exit', 0);
  fakeSpawn.last = child;
  return child;
}
const line = (o) => JSON.stringify(o) + '\n';

// PassThrough writes don't keep node alive on their own; the timer does, and
// it doubles as the failure deadline.
const nextEvent = (em, name, ms = 500) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no "${name}" within ${ms}ms`)), ms);
  em.once(name, (payload) => { clearTimeout(t); resolve(payload); });
});

/** start a session, run one turn, feed it `lines`, resolve the settled record */
async function turn(lines, sendText = 'do the thing') {
  const s = new Sessions(fakeSpawn);
  const id = s.start({ label: 'test' });
  const child = fakeSpawn.last;
  const settled = nextEvent(s, 'waiting');
  s.send(id, sendText);
  for (const l of lines) child.stdout.write(l);
  return { rec: await settled, s, id, child };
}

const assistant = (text, tools = []) => line({
  type: 'assistant',
  message: { content: [...tools.map((n) => ({ type: 'tool_use', id: n, name: n })), { type: 'text', text }] },
});

test('turn end settles to waiting, with what it did and a spoken-length brief', async () => {
  const { rec, child } = await turn([
    line({ type: 'system', subtype: 'init', model: 'claude-opus-5' }),
    'not json at all\n',                                    // must not crash
    assistant('Reading the config.', ['Read']),
    assistant('Patched it.', ['Edit', 'Edit', 'Bash']),
    line({
      type: 'result', is_error: false,
      result: 'Fixed the timeout bug in the retry loop. Tests pass. I also noticed the logger is unused, want me to strip it?',
    }),
  ]);

  assert.equal(rec.state, 'waiting');
  assert.equal(rec.model, 'claude-opus-5');
  assert.equal(rec.did, 'Read, Edit \u00d72, Bash');
  assert.equal(rec.summary, 'Fixed the timeout bug in the retry loop. Tests pass.');
  assert.equal(rec.waiting_kind, 'finished');
  assert.match(child.written.join(''), /"content":"do the thing"/);
});

test('a reply sent mid-task joins the running turn; the next turn counts afresh', async () => {
  const s = new Sessions(fakeSpawn);
  const id = s.start({ label: 'test' });
  const child = fakeSpawn.last;
  s.send(id, 'run sleep 6, then echo one');
  const seen = nextEvent(s, 'update');
  child.stdout.write(assistant('Sleeping.', ['Bash']));
  await seen;                                      // the first tool is counted before the reply
  s.send(id, 'also say SECOND');
  let settled = nextEvent(s, 'waiting');
  child.stdout.write(assistant('Echoing.', ['Bash']));
  child.stdout.write(line({ type: 'result', is_error: false, result: 'FIRST\nSECOND' }));
  assert.equal((await settled).did, 'Bash ×2', 'one result covers both, as claude 2.1.301 does');

  s.send(id, 'now read the readme');
  settled = nextEvent(s, 'waiting');
  child.stdout.write(assistant('Read it.', ['Read']));
  child.stdout.write(line({ type: 'result', is_error: false, result: 'Done.' }));
  assert.equal((await settled).did, 'Read');
});

const ask = (id, tool, input) => line({
  type: 'control_request', request_id: id,
  request: { subtype: 'can_use_tool', tool_name: tool, input },
});
const answered = (child) => child.written.splice(0).join('').trim().split('\n').map((l) => JSON.parse(l).response);

test('a permission prompt pauses the turn as an approval, and approve answers it in place', async () => {
  const { rec, s, id, child } = await turn([
    assistant('I need to remove the old migration.', ['Bash']),
    ask('r1', 'Bash', { command: 'rm -rf ./migrations/old' }),
  ]);
  assert.equal(rec.waiting_kind, 'approval_request');
  assert.deepEqual(rec.pending, ['Bash(rm -rf ./migrations/old)']);
  assert.deepEqual(rec.pending_ids, ['r1']);
  assert.equal(rec.summary, 'I need to remove the old migration.');

  child.written.length = 0;
  assert.equal(s.approve(id, ['r1']), true);
  assert.deepEqual(answered(child), [{
    subtype: 'success', request_id: 'r1',
    response: { behavior: 'allow', updatedInput: { command: 'rm -rf ./migrations/old' } },
  }]);
  const after = s.list()[0];
  assert.equal(after.state, 'running', 'same turn carries on, no new turn sent');
  assert.deepEqual(after.pending, []);
  assert.equal(s.approve(id, ['r1']), false, 'nothing left to approve');
});

test('approve only allows the exact requests you were shown, and shows them in full', async () => {
  const long = 'npm run build && ' + 'node scripts/migrate.js --step '.repeat(4) + '--force';
  const { s, id, child } = await turn([ask('r1', 'Bash', { command: long })]);
  assert.equal(s.list()[0].pending[0], `Bash(${long})`, 'the whole command, not a 60-character preview');

  // a second request arrives after you read the first: a yes to r1 alone allows nothing
  const second = nextEvent(s, 'update');
  child.stdout.write(ask('r2', 'Bash', { command: 'rm -rf build' }));
  await second;
  child.written.length = 0;
  assert.equal(s.approve(id, ['r1']), false);
  assert.equal(s.approve(id), false, 'no ids, no approval');
  assert.equal(child.written.length, 0, 'nothing was sent to the agent');
  assert.equal(s.approve(id, ['r2', 'r1']), true, 'naming both, in any order');
});

test('typing back during an approval denies it with your words; deny alone says no', async () => {
  const { s, id, child } = await turn([ask('r1', 'Bash', { command: 'rm x' })]);
  child.written.length = 0;
  assert.equal(s.send(id, 'use git rm instead'), true);
  const [r] = answered(child);
  assert.equal(r.request_id, 'r1');
  assert.deepEqual(r.response, { behavior: 'deny', message: 'use git rm instead' });

  const again = nextEvent(s, 'waiting');
  child.stdout.write(ask('r2', 'Bash', { command: 'rm y' }));
  await again;
  s.deny(id);
  const [d] = answered(child);
  assert.equal(d.request_id, 'r2');
  assert.match(d.response.message, /Denied/);
});

test('cancelled prompts clear, and unknown control requests are refused, not left hanging', async () => {
  const { s, child } = await turn([ask('r1', 'Bash', { command: 'x' })]);
  const cleared = nextEvent(s, 'update');
  child.stdout.write(line({ type: 'control_cancel_request', request_id: 'r1' }));
  await cleared;
  assert.equal(s.list()[0].state, 'running');
  assert.deepEqual(s.list()[0].pending, []);

  child.written.length = 0;
  const replied = new Promise((r) => child.stdin.once('data', r));
  child.stdout.write(line({ type: 'control_request', request_id: 'q9', request: { subtype: 'mcp_message' } }));
  await replied;
  const [r] = answered(child);
  assert.equal(r.subtype, 'error');
  assert.equal(r.request_id, 'q9');
});

test('a trailing question mark makes it a question, not a finished turn', async () => {
  const { rec } = await turn([
    line({ type: 'result', is_error: false, result: 'Should I apply the migration to staging?' }),
  ]);
  assert.equal(rec.waiting_kind, 'question');
});

test('a failed turn lands in error, not waiting', async () => {
  const s = new Sessions(fakeSpawn);
  const id = s.start({ label: 'test' });
  s.send(id, 'x');
  const settled = nextEvent(s, 'update');
  fakeSpawn.last.stdout.write(line({ type: 'result', is_error: true }));
  await settled;
  assert.equal(s.list()[0].state, 'error');
});

test('a crash surfaces stderr instead of a silent idle dot', async () => {
  const s = new Sessions(fakeSpawn);
  const id = s.start({ label: 'test' });
  const child = fakeSpawn.last;
  child.stderr.write("'claude' is not recognized");
  const settled = nextEvent(s, 'update');
  setImmediate(() => child.emit('exit', 127));
  await settled;
  const rec = s.list()[0];
  assert.equal(rec.state, 'error');
  assert.equal(rec.alive, false);
  assert.match(rec.last, /not recognized/);
  assert.equal(s.send(id, 'hello'), false, 'dead session refuses input');
});

test('stop ends the session as ended, not as a crash, and it shows as dead', async () => {
  const s = new Sessions(fakeSpawn);
  const id = s.start({ label: 'test' });
  const child = fakeSpawn.last;
  child.kill = () => child.emit('exit', 1);   // a killed tree exits nonzero on Windows
  assert.equal(await s.stop(id), true, 'resolves once the process has exited');
  const rec = s.list()[0];
  assert.equal(rec.state, 'exited');
  assert.equal(rec.alive, false);
  assert.equal(s.send(id, 'hello'), false);
});

test('stop says so when the process is still running, instead of reporting it stopped', async () => {
  const s = new Sessions(fakeSpawn, { stopWait: 50 });
  const id = s.start({ label: 'stubborn' });
  fakeSpawn.last.kill = () => {};   // the kill didn't take
  await assert.rejects(s.stop(id), /stubborn didn't stop/);
  assert.equal(s.list()[0].alive, true, 'still shown as running, because it is');
});

test("a CLI that can't start shows as dead with the reason, not as a live ghost", async () => {
  const s = new Sessions(fakeSpawn);
  const id = s.start({ label: 'test' });
  const child = fakeSpawn.last;   // no pid: the spawn itself failed
  child.emit('error', new Error('spawn claude ENOENT'));
  let rec = s.list()[0];
  assert.equal(rec.state, 'error');
  assert.equal(rec.alive, false);
  assert.match(rec.last, /ENOENT/);
  assert.equal(s.send(id, 'hello'), false, 'nothing to send to');
  child.emit('exit', null);   // if an exit does follow, it doesn't relabel it
  rec = s.list()[0];
  assert.equal(rec.state, 'error');
  assert.match(rec.last, /ENOENT/);
});

test('brief() stops at two sentences and never runs on forever', () => {
  assert.equal(brief('One. Two. Three. Four.'), 'One. Two.');
  assert.equal(brief('No terminator here'), 'No terminator here');
  assert.equal(brief(''), '');
  assert.ok(brief('x'.repeat(500)).length <= 200);
});
