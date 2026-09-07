'use strict';
// Pure provider catalog + connection-state reducer. No Electron, no I/O —
// main process detection/persist live in providers.js; tests import this.

/** @typedef {'connected'|'disconnected'|'pending'} ConnStatus */

/**
 * Seats in the Wispr-like setup flow. OAuth/SSO is deliberately not here yet —
 * Connect uses local detection (CLI / env / hub) and leaves clear TODOs.
 */
const PROVIDERS = Object.freeze([
  {
    id: 'claude',
    label: 'Claude',
    detail: 'CLI + Anthropic',
    kind: 'cli',
    binary: 'claude',
    // TODO(sso): browser OAuth / `claude auth login` deep-link when we wire real SSO.
  },
  {
    id: 'openai',
    label: 'ChatGPT / OpenAI',
    detail: 'API key (STT + chats)',
    kind: 'env',
    env: 'OPENAI_API_KEY',
    secretName: 'openai',
    // TODO(sso): ChatGPT account OAuth — not in this PR.
  },
  {
    id: 'grok',
    label: 'Grok / xAI',
    detail: 'Grok Bot',
    kind: 'env',
    env: 'XAI_API_KEY',
    secretName: 'xai',
    // TODO(sso): xAI / Grok account sign-in.
  },
  {
    id: 'codex',
    label: 'Codex',
    detail: 'OpenAI Codex CLI',
    kind: 'cli',
    binary: 'codex',
    // TODO(sso): share OpenAI session or Codex login when available.
  },
  {
    id: 'hermes',
    label: 'Hermes',
    detail: 'Local agent seat',
    kind: 'manual',
    // TODO(sso): Hermes hub / token once the agent ships a login path.
  },
  {
    id: 'layer',
    label: 'Layer hub',
    detail: 'Room stream URL',
    kind: 'hub',
    env: 'LAYER_HUB_URL',
    // Health ping against LAYER_HUB_URL when set.
  },
]);

const byId = Object.freeze(Object.fromEntries(PROVIDERS.map((p) => [p.id, p])));

function emptyConnection() {
  return {
    status: 'disconnected',
    method: null,
    detail: null,
    at: null,
    manual: false,
  };
}

function emptyState() {
  return Object.fromEntries(PROVIDERS.map((p) => [p.id, emptyConnection()]));
}

/** Normalize a persisted row so bad JSON cannot poison the UI. */
function normalizeConnection(raw) {
  const base = emptyConnection();
  if (!raw || typeof raw !== 'object') return base;
  const status = ['connected', 'disconnected', 'pending'].includes(raw.status)
    ? raw.status
    : 'disconnected';
  return {
    status,
    method: raw.method == null ? null : String(raw.method),
    detail: raw.detail == null ? null : String(raw.detail),
    at: typeof raw.at === 'number' ? raw.at : null,
    manual: Boolean(raw.manual),
  };
}

function hydrateConnections(raw) {
  const next = emptyState();
  if (!raw || typeof raw !== 'object') return next;
  for (const id of Object.keys(next)) {
    if (raw[id]) next[id] = normalizeConnection(raw[id]);
  }
  return next;
}

/**
 * Connection-state reducer.
 * Actions:
 *   { type: 'HYDRATE', connections }
 *   { type: 'CONNECT', id, status?, method?, detail?, at? }
 *   { type: 'DISCONNECT', id, detail?, at? }
 *   { type: 'APPLY_DETECT', detections: { [id]: { found, method?, detail?, at? } }, force? }
 */
function reduceProviders(state, action) {
  const prev = state && typeof state === 'object' ? state : emptyState();

  switch (action?.type) {
    case 'HYDRATE':
      return hydrateConnections(action.connections);

    case 'CONNECT': {
      const id = action.id;
      if (!byId[id]) return prev;
      return {
        ...prev,
        [id]: {
          status: action.status || 'connected',
          method: action.method || 'manual',
          detail: action.detail != null ? String(action.detail) : prev[id]?.detail || null,
          at: action.at ?? Date.now(),
          manual: true,
        },
      };
    }

    case 'DISCONNECT': {
      const id = action.id;
      if (!byId[id]) return prev;
      return {
        ...prev,
        [id]: {
          status: 'disconnected',
          method: null,
          detail: action.detail != null ? String(action.detail) : null,
          at: action.at ?? Date.now(),
          manual: true,
        },
      };
    }

    case 'APPLY_DETECT': {
      const detections = action.detections || {};
      const force = Boolean(action.force);
      const next = { ...prev };
      for (const [id, patch] of Object.entries(detections)) {
        if (!byId[id]) continue;
        const cur = next[id] || emptyConnection();
        // Honor an explicit Disconnect until the user Connects again (unless force).
        if (cur.manual && cur.status === 'disconnected' && !force) {
          next[id] = {
            ...cur,
            detail: patch.detail != null ? String(patch.detail) : cur.detail,
          };
          continue;
        }
        if (patch.found) {
          next[id] = {
            status: 'connected',
            method: patch.method || 'detect',
            detail: patch.detail != null ? String(patch.detail) : cur.detail,
            at: patch.at ?? Date.now(),
            manual: cur.manual && cur.status === 'connected' ? true : false,
          };
        } else if (!cur.manual) {
          next[id] = {
            ...emptyConnection(),
            detail: patch.detail != null ? String(patch.detail) : null,
            at: cur.at,
          };
        } else {
          next[id] = {
            ...cur,
            detail: patch.detail != null ? String(patch.detail) : cur.detail,
          };
        }
      }
      return next;
    }

    default:
      return prev;
  }
}

/** Rows the Setup panel renders — catalog merged with connection state. */
function providerRows(connections) {
  const state = connections && typeof connections === 'object' ? connections : emptyState();
  return PROVIDERS.map((p) => {
    const c = normalizeConnection(state[p.id]);
    return {
      id: p.id,
      label: p.label,
      detail: p.detail,
      kind: p.kind,
      status: c.status,
      method: c.method,
      statusDetail: c.detail,
      at: c.at,
      connected: c.status === 'connected',
    };
  });
}

module.exports = {
  PROVIDERS,
  byId,
  emptyConnection,
  emptyState,
  normalizeConnection,
  hydrateConnections,
  reduceProviders,
  providerRows,
};
