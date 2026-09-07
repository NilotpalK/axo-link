'use strict';
// Optional Layer hub client: POST wearer turns / agent whispers, and subscribe
// to the room SSE stream. Main-process only (fetch + ReadableStream); the
// renderer never talks to the hub directly.
//
// Env: LAYER_HUB_URL — base URL, default below. Set empty to disable.

const DEFAULT_HUB_URL = 'https://temporary-sonic-silver-10hrsnu.vercel.app';

function hubUrl() {
  if (Object.prototype.hasOwnProperty.call(process.env, 'LAYER_HUB_URL')) {
    return String(process.env.LAYER_HUB_URL || '').replace(/\/$/, '');
  }
  return DEFAULT_HUB_URL;
}

function enabled() {
  return Boolean(hubUrl());
}

/** Map a hub whisper into the pill's session fields (did / summary / waiting_kind). */
function mapWhisperToPill(whisper = {}) {
  const urgent = Boolean(whisper.urgent ?? whisper.interrupt);
  const text = String(whisper.text || '').trim();
  return {
    id: whisper.id || `hub-${Date.now()}`,
    vendor: 'layer-hub',
    cwd: '',
    label: String(whisper.agent || 'hub').trim() || 'hub',
    state: 'waiting',
    waiting_kind: urgent ? 'question' : 'finished',
    summary: text,
    did: '',
    pending: [],
    last: text,
    hub: true,
  };
}

async function postJson(path, body) {
  const base = hubUrl();
  if (!base) return { ok: false, skipped: true };
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  // Hub may 502 when a downstream webhook is unauthorized, while still
  // recording the turn/whisper in the room store — treat that as accepted.
  const recorded = Boolean(
    data && (data.ok === true || Array.isArray(data.payloads) || data.whisper),
  );
  return { ok: res.ok || recorded, status: res.status, data, recorded };
}

function postTurn(text) {
  const t = String(text || '').trim();
  if (!t) return Promise.resolve({ ok: false, skipped: true });
  return postJson('/api/turn', { text: t });
}

function postWhisper({ agent, text, urgent } = {}) {
  const t = String(text || '').trim();
  if (!t) return Promise.resolve({ ok: false, skipped: true });
  const body = { agent: String(agent || 'axo').trim() || 'axo', text: t };
  if (urgent != null) body.urgent = Boolean(urgent);
  return postJson('/api/whispers', body);
}

/** Minimal SSE frame parser over a fetch body stream. */
async function readSse(body, onEvent, signal) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    if (signal?.aborted) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return;
    }
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLines = [];
      for (const raw of frame.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (!line || line.startsWith(':')) continue; // comment / keepalive
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      try {
        onEvent(JSON.parse(dataLines.join('\n')));
      } catch { /* ignore malformed */ }
    }
  }
}

/**
 * Subscribe to GET /api/room/stream. Reconnects with backoff until aborted.
 * Returns an AbortController stop handle: { stop() }.
 */
function subscribeStream(onEvent, { signal } = {}) {
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  let delay = 1000;
  (async () => {
    while (!ac.signal.aborted) {
      const base = hubUrl();
      if (!base) return;
      try {
        const res = await fetch(`${base}/api/room/stream`, {
          headers: { Accept: 'text/event-stream' },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        delay = 1000;
        await readSse(res.body, onEvent, ac.signal);
      } catch (e) {
        if (ac.signal.aborted) return;
        console.warn('[layer-hub] stream error:', e.message || e);
      }
      if (ac.signal.aborted) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  })();

  return { stop: () => ac.abort() };
}

module.exports = {
  DEFAULT_HUB_URL,
  hubUrl,
  enabled,
  mapWhisperToPill,
  postTurn,
  postWhisper,
  subscribeStream,
};
