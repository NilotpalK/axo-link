'use strict';
// What axo is allowed to do when Gemini calls a tool. The model picks the
// call; these checks decide whether it lands.
const test = require('node:test');
const assert = require('node:assert');
const { toolRunner, update, speakable } = require('./voice');

const roster = [
  { id: 'a1', label: 'axo-link', device: 'HOME', alive: true, state: 'waiting',
    waiting_kind: 'approval_request', pending: ['Bash(rm -rf x)'], pending_ids: ['r1'], summary: 'Cleaning up.' },
  { id: 'b1', label: 'api', device: 'OFFICE', alive: true, state: 'running', waiting_kind: null, pending: [] },
  { id: 'c1', label: 'old', device: 'HOME', alive: false, state: 'exited', pending: [] },
];

test('tools act on the right agent, say ok only once it happened, and refuse what makes no sense', async () => {
  const sent = [];
  let mode = 'desk';
  const halfTyped = "something is half-typed in api's terminal, so nothing was sent";
  const run = toolRunner({
    // the agent's machine carries it out, or says why not
    link: { do: async (op, id, text, asks) => { sent.push([op, id, text, asks]); if (text === 'wait') throw new Error(halfTyped); } },
    roster: () => roster,
    setMode: (m) => (m === 'desk' || m === 'away') && (mode = m),
  });

  assert.equal(run('agents', {}).agents[0].request_ids[0], 'r1', 'axo sees which request it would approve');
  assert.match(run('approve', { id: 'a1' }).error, /changed/, 'a yes must name the requests it was for');
  assert.match(run('approve', { id: 'a1', requests: ['r9'] }).error, /changed/);
  assert.deepEqual(await run('approve', { id: 'a1', requests: ['r1'] }), { ok: true });
  assert.deepEqual(await run('reply', { id: 'b1', text: 'run the tests' }), { ok: true });
  assert.deepEqual(await run('reply', { id: 'b1', text: 'wait' }), { error: halfTyped }, "not ok: the machine's reason, as is");
  assert.match(run('press', { id: 'b1', keys: ['down'] }).error, /no screen/, 'keys are for terminals');
  assert.match(run('approve', { id: 'b1', requests: [] }).error, /not waiting/);
  assert.match(run('stop', { id: 'c1' }).error, /ended/);
  assert.match(run('reply', { id: 'zz', text: 'x' }).error, /no agent/);
  assert.match(run('format_disk', {}).error, /no tool/);
  assert.deepEqual(sent, [['approve', 'a1', undefined, ['r1']], ['send', 'b1', 'run the tests', undefined], ['send', 'b1', 'wait', undefined]]);

  assert.deepEqual(run('set_mode', { mode: 'away' }), { ok: true });
  assert.equal(mode, 'away');
  assert.match(run('set_mode', { mode: 'party' }).error, /desk or away/);
});

test('a terminal session: its screen is read from its machine, its prompts are answered there', async () => {
  const term = { id: 't1', label: 'daedalus', kind: 'terminal', device: 'HOME', alive: true, state: 'waiting',
    waiting_kind: 'approval_request', pending: ['Bash(npm test)'], pending_ids: [], last: 'Here is where things stand.', prompt: 'status?' };
  const asked = [], done = [];
  const run = toolRunner({
    link: { do: async (...a) => { done.push(a); }, ask: async (q) => { asked.push(q); return { text: 'Resume session\n> daedalus' }; } },
    roster: () => [term],
    setMode: () => true,
  });
  assert.deepEqual(await run('screen', { id: 't1' }), { screen: 'Resume session\n> daedalus' });
  assert.deepEqual(asked, [{ t: 'query', op: 'screen', id: 't1' }]);
  assert.deepEqual(await run('press', { id: 't1', keys: ['down', 'enter'] }), { ok: true });
  assert.deepEqual(done, [['press', 't1', ['down', 'enter']]], 'the keys go to its machine, which decides if they may be pressed');
  assert.match(run('approve', { id: 't1', requests: [] }).error, /answered there/);
  const seen = run('agents', {}).agents[0];
  assert.equal(seen.last_message, 'Here is where things stand.', "the agent's own words");
  assert.equal(seen.you_sent, 'status?', 'kept apart from what was sent to it');
});

test('read out in full: Markdown marks go, every word stays, and the first part is short', () => {
  const message = [
    'The branch `feat/phase2-workbook-fill` carries six commits ahead of main, all in PR #411. It touches 12 files.',
    '',
    '**What the branch does**',
    'A phase-2 takeoff used to end at "Takeoff complete" on the [bid page](https://x.dev/bid).',
    '',
    '- Fill the bid\'s workbook from a takeoff drawn in Revu.',
    '- Check each assembly\'s rules against the workbook it fills.',
  ].join('\n');
  const parts = speakable(message, 120);
  const words = (s) => s.replace(/\*\*|`|\[|\]\([^)]*\)|^- /gm, '').split(/\s+/).filter(Boolean);
  assert.deepEqual(parts.join(' ').split(/\s+/), words(message), 'the same words, in the same order');
  assert.equal(parts[0], 'The branch feat/phase2-workbook-fill carries six commits ahead of main, all in PR #411.');
  assert.ok(parts.slice(1).every((p) => p.length <= 120 || !p.includes('. ')), 'later parts stay small');
});

test('read_aloud reads the whole last message, or a terminal screen, through the reader', async () => {
  const term = { id: 't1', label: 'daedalus', kind: 'terminal', device: 'HOME', alive: true, state: 'waiting',
    last: 'First line.\n\nSecond paragraph, word for word.' };
  const pill = { id: 'p1', label: 'api', device: 'HOME', alive: true, state: 'idle', last: '' };
  const read = [];
  const run = toolRunner({
    link: { do: async () => {}, ask: async () => ({ text: 'Resume session\n> daedalus' }) },
    roster: () => [term, pill],
    setMode: () => true,
    readAloud: (text) => { read.push(text); return { ok: true }; },
  });
  assert.deepEqual(run('read_aloud', { id: 't1', what: 'last_message' }), { ok: true });
  assert.deepEqual(await run('read_aloud', { id: 't1', what: 'screen' }), { ok: true });
  assert.deepEqual(read, ['First line.\n\nSecond paragraph, word for word.', 'Resume session\n> daedalus'], 'whole, unchanged');
  assert.match(run('read_aloud', { id: 'p1', what: 'last_message' }).error, /hasn't said anything/);
  assert.match(run('read_aloud', { id: 'p1', what: 'screen' }).error, /no screen/);
});

test('an update says who, where, and exactly what it wants', () => {
  assert.equal(update(roster[0]), '[update] axo-link on HOME wants approval to run: Bash(rm -rf x).');
  assert.equal(update({ label: 'api', device: 'OFFICE', state: 'error', summary: 'the turn failed (rate_limit)' }),
    '[update] api on OFFICE stopped with an error: the turn failed (rate_limit)');
});
