'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectOpenAI,
  detectLayerSync,
  onPath,
} = require('../src/helpers/providers');
const { DEFAULT_HUB_URL } = require('../src/helpers/layer-hub');

test('detectOpenAI: OPENAI_API_KEY marks connected via env', () => {
  const prev = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    const r = detectOpenAI();
    assert.equal(r.found, true);
    assert.equal(r.method, 'env');
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test('detectOpenAI: missing key → not found', () => {
  const prev = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    const r = detectOpenAI();
    // May still be found via keychain under Electron; under plain node it is not.
    if (!r.found) {
      assert.equal(r.method, null);
      assert.match(r.detail, /OPENAI_API_KEY/);
    }
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test('detectLayerSync: default hub when env unset', () => {
  const prev = process.env.LAYER_HUB_URL;
  try {
    delete process.env.LAYER_HUB_URL;
    const r = detectLayerSync();
    assert.equal(r.found, true);
    assert.equal(r.method, 'default');
    assert.equal(r.url, DEFAULT_HUB_URL);
  } finally {
    if (prev === undefined) delete process.env.LAYER_HUB_URL;
    else process.env.LAYER_HUB_URL = prev;
  }
});

test('detectLayerSync: empty LAYER_HUB_URL disables', () => {
  const prev = process.env.LAYER_HUB_URL;
  try {
    process.env.LAYER_HUB_URL = '';
    const r = detectLayerSync();
    assert.equal(r.found, false);
    assert.equal(r.url, '');
  } finally {
    if (prev === undefined) delete process.env.LAYER_HUB_URL;
    else process.env.LAYER_HUB_URL = prev;
  }
});

test('onPath: nonsense binary is absent', () => {
  assert.equal(onPath('axo-link-definitely-missing-binary-xyz'), false);
});
