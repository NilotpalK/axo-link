'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVIDERS,
  emptyState,
  hydrateConnections,
  reduceProviders,
  providerRows,
  normalizeConnection,
} = require('../src/helpers/provider-state');

test('catalog lists the six setup seats', () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.id),
    ['claude', 'openai', 'grok', 'codex', 'hermes', 'layer'],
  );
});

test('emptyState starts every seat disconnected', () => {
  const state = emptyState();
  for (const id of PROVIDERS.map((p) => p.id)) {
    assert.equal(state[id].status, 'disconnected');
    assert.equal(state[id].manual, false);
  }
});

test('hydrateConnections ignores junk and unknown ids', () => {
  const state = hydrateConnections({
    claude: { status: 'connected', method: 'cli', at: 1 },
    nope: { status: 'connected' },
    openai: { status: 'bogus' },
  });
  assert.equal(state.claude.status, 'connected');
  assert.equal(state.claude.method, 'cli');
  assert.equal(state.openai.status, 'disconnected');
  assert.equal(state.nope, undefined);
});

test('CONNECT marks connected + manual', () => {
  const next = reduceProviders(emptyState(), {
    type: 'CONNECT',
    id: 'openai',
    method: 'env',
    detail: 'OPENAI_API_KEY set',
    at: 42,
  });
  assert.equal(next.openai.status, 'connected');
  assert.equal(next.openai.method, 'env');
  assert.equal(next.openai.detail, 'OPENAI_API_KEY set');
  assert.equal(next.openai.at, 42);
  assert.equal(next.openai.manual, true);
});

test('CONNECT can mark pending for SSO TODO seats', () => {
  const next = reduceProviders(emptyState(), {
    type: 'CONNECT',
    id: 'grok',
    status: 'pending',
    method: 'todo',
    detail: 'TODO(sso)',
  });
  assert.equal(next.grok.status, 'pending');
  assert.equal(next.grok.method, 'todo');
});

test('DISCONNECT sticks against later APPLY_DETECT unless force', () => {
  let state = reduceProviders(emptyState(), {
    type: 'CONNECT',
    id: 'claude',
    method: 'cli',
  });
  state = reduceProviders(state, { type: 'DISCONNECT', id: 'claude' });
  assert.equal(state.claude.status, 'disconnected');
  assert.equal(state.claude.manual, true);

  state = reduceProviders(state, {
    type: 'APPLY_DETECT',
    detections: { claude: { found: true, method: 'cli', detail: 'on PATH' } },
  });
  assert.equal(state.claude.status, 'disconnected');
  assert.equal(state.claude.detail, 'on PATH');

  state = reduceProviders(state, {
    type: 'APPLY_DETECT',
    force: true,
    detections: { claude: { found: true, method: 'cli', detail: 'forced' } },
  });
  assert.equal(state.claude.status, 'connected');
  assert.equal(state.claude.detail, 'forced');
});

test('APPLY_DETECT connects when found and not manually disconnected', () => {
  const next = reduceProviders(emptyState(), {
    type: 'APPLY_DETECT',
    detections: {
      openai: { found: true, method: 'env', detail: 'OPENAI_API_KEY set', at: 7 },
      hermes: { found: false, detail: 'TODO(sso)' },
    },
  });
  assert.equal(next.openai.status, 'connected');
  assert.equal(next.openai.method, 'env');
  assert.equal(next.openai.at, 7);
  assert.equal(next.hermes.status, 'disconnected');
  assert.equal(next.hermes.detail, 'TODO(sso)');
});

test('providerRows merges catalog with connection state', () => {
  const state = reduceProviders(emptyState(), {
    type: 'CONNECT',
    id: 'layer',
    method: 'env',
    detail: 'hub up',
  });
  const rows = providerRows(state);
  assert.equal(rows.length, 6);
  const layer = rows.find((r) => r.id === 'layer');
  assert.equal(layer.label, 'Layer hub');
  assert.equal(layer.connected, true);
  assert.equal(layer.statusDetail, 'hub up');
  assert.equal(rows.find((r) => r.id === 'codex').connected, false);
});

test('normalizeConnection clamps bad status', () => {
  assert.equal(normalizeConnection({ status: 'weird' }).status, 'disconnected');
  assert.equal(normalizeConnection(null).status, 'disconnected');
});

test('unknown action / id is a no-op', () => {
  const state = emptyState();
  assert.equal(reduceProviders(state, { type: 'NOPE' }), state);
  assert.equal(reduceProviders(state, { type: 'CONNECT', id: 'nope' }), state);
});
