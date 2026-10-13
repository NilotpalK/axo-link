'use strict';
// What axo is allowed to do when Gemini calls a tool. The model picks the
// call; these checks decide whether it lands.
const test = require('node:test');
const assert = require('node:assert');
const { toolRunner, update } = require('./voice');

const roster = [
  { id: 'a1', label: 'axo-link', device: 'HOME', alive: true, state: 'waiting',
    waiting_kind: 'approval_request', pending: ['Bash(rm -rf x)'], summary: 'Cleaning up.' },
  { id: 'b1', label: 'api', device: 'OFFICE', alive: true, state: 'running', waiting_kind: null, pending: [] },
  { id: 'c1', label: 'old', device: 'HOME', alive: false, state: 'exited', pending: [] },
];

test('tools act on the right agent and refuse what makes no sense', () => {
  const sent = [];
  let mode = 'desk';
  const run = toolRunner({
    link: { do: (op, id, text) => sent.push([op, id, text]) },
    roster: () => roster,
    setMode: (m) => (m === 'desk' || m === 'away') && (mode = m),
  });

  assert.equal(run('agents', {}).agents.length, 3);
  assert.deepEqual(run('approve', { id: 'a1' }), { ok: true });
  assert.deepEqual(run('reply', { id: 'b1', text: 'run the tests' }), { ok: true });
  assert.match(run('approve', { id: 'b1' }).error, /not waiting/);
  assert.match(run('stop', { id: 'c1' }).error, /ended/);
  assert.match(run('reply', { id: 'zz', text: 'x' }).error, /no agent/);
  assert.match(run('format_disk', {}).error, /no tool/);
  assert.deepEqual(sent, [['approve', 'a1', undefined], ['send', 'b1', 'run the tests']]);

  assert.deepEqual(run('set_mode', { mode: 'away' }), { ok: true });
  assert.equal(mode, 'away');
  assert.match(run('set_mode', { mode: 'party' }).error, /desk or away/);
});

test('an update says who, where, and exactly what it wants', () => {
  assert.equal(update(roster[0]), '[update] axo-link on HOME wants approval to run: Bash(rm -rf x).');
});
