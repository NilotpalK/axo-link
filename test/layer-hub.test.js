'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  mapWhisperToPill,
  hubUrl,
  DEFAULT_HUB_URL,
} = require('../src/helpers/layer-hub');
const { Sessions } = require('../src/helpers/agent');

test('mapWhisperToPill: summary=text, waiting_kind=finished when not urgent', () => {
  const pill = mapWhisperToPill({
    id: 'w1',
    agent: 'Voss',
    text: 'Need a look at the outreach list.',
  });
  assert.equal(pill.id, 'w1');
  assert.equal(pill.label, 'Voss');
  assert.equal(pill.summary, 'Need a look at the outreach list.');
  assert.equal(pill.did, '');
  assert.equal(pill.waiting_kind, 'finished');
  assert.equal(pill.state, 'waiting');
  assert.equal(pill.vendor, 'layer-hub');
  assert.equal(pill.hub, true);
});

test('mapWhisperToPill: urgent or interrupt → waiting_kind=question', () => {
  assert.equal(
    mapWhisperToPill({ id: 'a', agent: 'Coding', text: 'Blocked?', urgent: true }).waiting_kind,
    'question',
  );
  assert.equal(
    mapWhisperToPill({ id: 'b', agent: 'Coding', text: 'Blocked?', interrupt: true }).waiting_kind,
    'question',
  );
  assert.equal(
    mapWhisperToPill({ id: 'c', agent: 'Coding', text: 'FYI', interrupt: false }).waiting_kind,
    'finished',
  );
});

test('hubUrl defaults to the Vercel hub; empty LAYER_HUB_URL disables', () => {
  const prev = process.env.LAYER_HUB_URL;
  try {
    delete process.env.LAYER_HUB_URL;
    assert.equal(hubUrl(), DEFAULT_HUB_URL);
    process.env.LAYER_HUB_URL = '';
    assert.equal(hubUrl(), '');
    process.env.LAYER_HUB_URL = 'https://example.test/hub/';
    assert.equal(hubUrl(), 'https://example.test/hub');
  } finally {
    if (prev === undefined) delete process.env.LAYER_HUB_URL;
    else process.env.LAYER_HUB_URL = prev;
  }
});

test('Sessions.upsertExternal emits waiting so the pill / speak path fires', async () => {
  const s = new Sessions(() => { throw new Error('no spawn'); });
  const waiting = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no waiting')), 500);
    s.once('waiting', (rec) => { clearTimeout(t); resolve(rec); });
  });
  const mapped = mapWhisperToPill({
    id: 'hub-1',
    agent: 'Dealfinder',
    text: 'Found three leads in Texas.',
    urgent: false,
  });
  s.upsertExternal(mapped);
  const rec = await waiting;
  assert.equal(rec.label, 'Dealfinder');
  assert.equal(rec.summary, 'Found three leads in Texas.');
  assert.equal(rec.waiting_kind, 'finished');
  assert.equal(s.isHub('hub-1'), true);
  assert.equal(s.list().length, 1);
});

test('mapWhisperToPill: deepLink, tools, character pass through', () => {
  const pill = mapWhisperToPill({
    id: 'w2',
    agent: 'Coding',
    text: 'Diff ready for review.',
    deepLink: 'https://example.test/pr/1',
    tools: ['Edit', 'Bash'],
    character: 'CD',
  });
  assert.equal(pill.deepLink, 'https://example.test/pr/1');
  assert.deepEqual(pill.tools, ['Edit', 'Bash']);
  assert.equal(pill.character, 'CD');
  assert.equal(pill.summary, 'Diff ready for review.');
});

test('mapWhisperToPill: empty text still maps but focused card will skip', () => {
  const pill = mapWhisperToPill({ id: 'empty', agent: 'Voss', text: '  ' });
  assert.equal(pill.summary, '');
  assert.equal(pill.character, 'VO');
  assert.deepEqual(pill.tools, ['Layer']);
});
