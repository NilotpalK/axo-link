import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initials,
  snippetOf,
  toolsOf,
  seatFromSession,
  needsAsherSeats,
  statusOf,
} from '../src/renderer/utils/seat.js';

test('initials from seat name', () => {
  assert.equal(initials('Dealfinder'), 'DE');
  assert.equal(initials('Grubbrr Ads'), 'GA');
  assert.equal(initials(''), 'AX');
});

test('snippet prefers summary, requires real text', () => {
  assert.equal(snippetOf({ summary: ' Look here. ' }), 'Look here.');
  assert.equal(snippetOf({ last: 'fallback' }), 'fallback');
  assert.equal(snippetOf({ pending: ['Bash(rm)'] }), 'wants: Bash(rm)');
  assert.equal(snippetOf({}), '');
});

test('seatFromSession skips empty snippets', () => {
  assert.equal(seatFromSession({ id: '1', label: 'Voss', state: 'waiting' }), null);
  const seat = seatFromSession({
    id: '2',
    label: 'Voss',
    state: 'waiting',
    summary: 'Ping Reddy',
    vendor: 'layer-hub',
    hub: true,
    deepLink: 'https://example.test/x',
    since: 10,
  });
  assert.equal(seat.name, 'Voss');
  assert.equal(seat.character, 'VO');
  assert.equal(seat.status, 'WAITING');
  assert.equal(seat.snippet, 'Ping Reddy');
  assert.equal(seat.deepLink, 'https://example.test/x');
  assert.deepEqual(seat.tools, ['Layer']);
});

test('needsAsherSeats: waiting + snippet, skip held/decided', () => {
  const list = [
    { id: 'a', label: 'A', state: 'waiting', summary: 'one', since: 2 },
    { id: 'b', label: 'B', state: 'waiting', summary: 'two', since: 1, held: true },
    { id: 'c', label: 'C', state: 'running', summary: 'go', since: 0 },
    { id: 'd', label: 'D', state: 'waiting', summary: 'three', since: 3 },
    { id: 'e', label: 'E', state: 'waiting', summary: '', since: 4 },
  ];
  const queue = needsAsherSeats(list, { d: 'held' });
  assert.deepEqual(queue.map((s) => s.id), ['a']);
});

test('statusOf maps session.state', () => {
  assert.equal(statusOf({ state: 'waiting' }), 'WAITING');
  assert.equal(statusOf({ state: 'running' }), 'RUNNING');
  assert.equal(statusOf({ state: 'idle' }), 'DONE');
});

test('toolsOf falls back through did / vendor', () => {
  assert.deepEqual(toolsOf({ tools: ['Bash', 'Edit'] }), ['Bash', 'Edit']);
  assert.deepEqual(toolsOf({ did: 'Edit x3, Bash' }), ['Edit x3', 'Bash']);
  assert.deepEqual(toolsOf({ vendor: 'claude' }), ['claude']);
});
