'use strict';
// Multi-provider sign-in scaffold: detect local CLI / env / hub, persist
// connection *state* (not secrets) as JSON under userData. Tokens stay in
// env or safeStorage placeholders — no plaintext secrets, no browser OAuth yet.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  PROVIDERS,
  byId,
  emptyState,
  hydrateConnections,
  reduceProviders,
  providerRows,
} = require('./provider-state');

const STORE_NAME = 'provider-connections.json';

// Lazy so unit tests can exercise pure helpers under plain `node`.
const electron = () => require('electron');

function storePath() {
  return path.join(electron().app.getPath('userData'), STORE_NAME);
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return {
      setupSeen: Boolean(raw.setupSeen),
      connections: hydrateConnections(raw.connections),
    };
  } catch {
    return { setupSeen: false, connections: emptyState() };
  }
}

function writeStore(data) {
  const target = storePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = {
    setupSeen: Boolean(data.setupSeen),
    connections: hydrateConnections(data.connections),
  };
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return payload;
}
/** True when `binary` resolves on PATH (no shell). */
function onPath(binary) {
  if (!binary || typeof binary !== 'string') return false;
  try {
    const r = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 2500,
      env: process.env,
    });
    // Missing binary → spawn error (ENOENT). Non-zero exit still means found.
    if (r.error && (r.error.code === 'ENOENT' || r.error.code === 'EINVAL')) return false;
    return r.error == null || r.status != null;
  } catch {
    return false;
  }
}

/**
 * Best-effort Claude login check. Prefer `claude auth status` when it exists;
 * otherwise PATH presence is enough for the scaffold.
 */
function detectClaude() {
  if (!onPath('claude')) {
    return { found: false, method: null, detail: 'claude not on PATH' };
  }
  try {
    const r = spawnSync('claude', ['auth', 'status'], {
      encoding: 'utf8',
      timeout: 4000,
      env: process.env,
    });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`.toLowerCase();
    if (/logged.?in|authenticated|email|ok\b/.test(out) && !/not logged|unauthor/.test(out)) {
      return { found: true, method: 'cli', detail: 'claude CLI logged in' };
    }
    if (r.status === 0) {
      return { found: true, method: 'cli', detail: 'claude CLI on PATH' };
    }
  } catch { /* fall through */ }
  return { found: true, method: 'cli', detail: 'claude on PATH (login not verified)' };
}

function envSet(name) {
  const v = process.env[name];
  return Boolean(v && String(v).trim());
}

function detectOpenAI() {
  // Mirror transcribe.js: env first, then safeStorage placeholder (never returned).
  if (envSet('OPENAI_API_KEY')) {
    return { found: true, method: 'env', detail: 'OPENAI_API_KEY set' };
  }
  try {
    const secrets = require('./secrets');
    if (secrets.get('openai')) {
      return { found: true, method: 'keychain', detail: 'key in OS keychain' };
    }
  } catch { /* plain node / no electron */ }
  return { found: false, method: null, detail: 'no OPENAI_API_KEY / keychain entry' };
}
function detectEnvKey(envName, secretName) {
  if (envSet(envName)) {
    return { found: true, method: 'env', detail: `${envName} set` };
  }
  if (secretName) {
    try {
      const secrets = require('./secrets');
      if (secrets.get(secretName)) {
        return { found: true, method: 'keychain', detail: 'key in OS keychain' };
      }
    } catch { /* ignore */ }
  }
  return { found: false, method: null, detail: `${envName} not set — TODO(sso)` };
}

async function pingLayerHub(baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) return { ok: false, detail: 'LAYER_HUB_URL empty' };
  try {
    const res = await fetch(`${base}/api/room/stream`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: AbortSignal.timeout(3500),
    });
    // Any HTTP response means the hub is reachable; 401/404 still count as up.
    if (res.body && typeof res.body.cancel === 'function') {
      try { await res.body.cancel(); } catch { /* ignore */ }
    }
    return { ok: true, detail: `hub reachable (${res.status})` };
  } catch (e) {
    return { ok: false, detail: `hub unreachable: ${e.message || e}` };
  }
}

function detectLayerSync() {
  const { hubUrl, DEFAULT_HUB_URL } = require('./layer-hub');
  const url = hubUrl();
  if (!url) {
    return { found: false, method: null, detail: 'LAYER_HUB_URL disabled', url: '' };
  }
  const viaEnv = Object.prototype.hasOwnProperty.call(process.env, 'LAYER_HUB_URL')
    && Boolean(String(process.env['LAYER_HUB_URL'] || '').trim());
  return {
    found: true,
    method: viaEnv ? 'env' : 'default',
    detail: viaEnv ? `LAYER_HUB_URL = ${url}` : `default hub → ${url}`,
    url,
    isDefault: url === DEFAULT_HUB_URL && !viaEnv,
  };
}

/** Run all local detectors. Hub ping is optional/async. */
async function detectAll({ pingHub = true } = {}) {
  const detections = {};

  detections.claude = detectClaude();
  detections.openai = detectOpenAI();
  detections.grok = detectEnvKey('XAI_API_KEY', 'xai');

  detections.codex = onPath('codex')
    ? { found: true, method: 'cli', detail: 'codex on PATH' }
    : { found: false, method: null, detail: 'codex not on PATH — TODO(sso)' };

  detections.hermes = {
    found: false,
    method: null,
    detail: 'manual seat — TODO(sso / local agent login)',
  };

  const layer = detectLayerSync();
  if (layer.found && pingHub) {
    const ping = await pingLayerHub(layer.url);
    detections.layer = {
      found: true,
      method: layer.method,
      detail: `${layer.detail}; ${ping.detail}`,
    };
  } else {
    detections.layer = {
      found: layer.found,
      method: layer.method,
      detail: layer.detail,
    };
  }

  return detections;
}

let cache = null;

function load() {
  if (!cache) cache = readStore();
  return cache;
}

function save(next) {
  cache = writeStore(next);
  return cache;
}

function snapshotFrom(data) {
  return {
    setupSeen: data.setupSeen,
    connections: data.connections,
    providers: providerRows(data.connections),
  };
}

async function refresh({ force = false } = {}) {
  const cur = load();
  const detections = await detectAll({ pingHub: true });
  const connections = reduceProviders(cur.connections, {
    type: 'APPLY_DETECT',
    detections,
    force,
  });
  return save({ setupSeen: cur.setupSeen, connections });
}

function snapshot() {
  return snapshotFrom(load());
}

async function connect(id) {
  const meta = byId[id];
  if (!meta) return { ok: false, error: 'unknown provider' };

  const cur = load();
  const detections = await detectAll({ pingHub: id === 'layer' });
  const hit = detections[id];

  let action;
  if (hit && hit.found) {
    action = {
      type: 'CONNECT',
      id,
      status: 'connected',
      method: hit.method || 'detect',
      detail: hit.detail,
    };
  } else {
    // Scaffold: mark pending with an explicit SSO TODO — do not invent OAuth.
    action = {
      type: 'CONNECT',
      id,
      status: 'pending',
      method: 'todo',
      detail:  (hit && hit.detail) || `TODO(sso): real sign-in for ${meta.label}`,
    };
  }

  const connections = reduceProviders(cur.connections, action);
  const saved = save({ setupSeen: true, connections });
  return { ok: true, ...snapshotFrom(saved), action: action.status };
}

function disconnect(id) {
  if (!byId[id]) return { ok: false, error: 'unknown provider' };
  const cur = load();
  const connections = reduceProviders(cur.connections, {
    type: 'DISCONNECT',
    id,
    detail: 'disconnected locally (env/keychain untouched)',
  });
  const saved = save({ setupSeen: cur.setupSeen, connections });
  return { ok: true, ...snapshotFrom(saved) };
}

function markSetupSeen() {
  const cur = load();
  const saved = save({ setupSeen: true, connections: cur.connections });
  return snapshotFrom(saved);
}

/** Test seam: wipe in-memory cache (and optionally the on-disk file). */
function _resetForTests({ wipeFile = false } = {}) {
  cache = null;
  if (wipeFile) {
    try { fs.unlinkSync(storePath()); } catch { /* ignore */ }
  }
}

module.exports = {
  PROVIDERS,
  STORE_NAME,
  onPath,
  detectClaude,
  detectOpenAI,
  detectLayerSync,
  detectAll,
  pingLayerHub,
  load,
  save,
  refresh,
  snapshot,
  connect,
  disconnect,
  markSetupSeen,
  readStore,
  writeStore,
  _resetForTests,
};
