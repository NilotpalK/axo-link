'use strict';
// The checks that matter: a `result` line must settle the session, classify why
// it is waiting, and say what the agent did. If these break, the pill lies and
// the voice layer reads out the wrong thing.
const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { Sessions, brief } = require('./agent');

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

test('permission_denials mark the session as needing approval, and say for what', async () => {
  const { rec } = await turn([
    assistant('I need to remove the old migration.', ['Bash']),
    line({
      type: 'result', is_error: false,
      result: 'I could not delete the migration without permission.',
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'rm -rf ./migrations/old' } },
      ],
    }),
  ]);

  assert.equal(rec.waiting_kind, 'approval_request');
  assert.deepEqual(rec.pending, ['Bash(rm -rf ./migrations/old)']);
});

test('a trailing question mark makes it a question, not a finished turn', async () => {
  const { rec } = await turn([
    line({ type: 'result', is_error: false, result: 'Should I apply the migration to staging?' }),
  ]);
  assert.equal(rec.waiting_kind, 'question');
});

test('approve continues the same session instead of starting a new one', async () => {
  const { rec, s, id, child } = await turn([
    line({
      type: 'result', is_error: false, result: 'Blocked.',
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'rm x' } }],
    }),
  ]);
  assert.equal(rec.waiting_kind, 'approval_request');

  assert.equal(s.approve(id), true);
  const after = s.list()[0];
  assert.equal(after.state, 'running');
  assert.equal(after.waiting_kind, null, 'stale approval must not linger');
  assert.deepEqual(after.pending, []);
  assert.match(child.written.join(''), /Approved/);
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
  assert.match(rec.last, /not recognized/);
  assert.equal(s.send(id, 'hello'), false, 'dead session refuses input');
});

test('brief() stops at two sentences and never runs on forever', () => {
  assert.equal(brief('One. Two. Three. Four.'), 'One. Two.');
  assert.equal(brief('No terminator here'), 'No terminator here');
  assert.equal(brief(''), '');
  assert.ok(brief('x'.repeat(500)).length <= 200);
});
