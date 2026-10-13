'use strict';
// The hub. Every connector and every pill dials in and keeps one socket open;
// nothing ever dials out of here. Connectors report their agents, the hub
// merges them into one roster, broadcasts it, and routes each instruction down
// the socket of whichever machine owns that agent.
//
//   in:  hello{token, device?}  agents{list}  hand{agent}  do{op, id, text?}  voice{ref, kind}
//   out: roster{agents}  hand{agent}  do{op, id, text?}  error{id, msg}  reply{ref, ...}
//
//   node hub.js                              (localhost only)
//   AXO_HOST=0.0.0.0 AXO_TOKEN=… node hub.js (reachable from other machines)
const { WebSocketServer } = require('ws');
const { timingSafeEqual } = require('node:crypto');

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const same = (a, b) => typeof a === 'string' && a.length === b.length
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Voice runs on the client, but the Gemini key never leaves the hub: a client
// gets a one-use token locked to one model, good for opening a session within
// the next minute. The hub picks the model, so it's changed in one place.
const VOICE = { talk: 'gemini-3.8-live', dictate: 'gemini-3.5-transcribe-live' };
let genai;
async function voiceToken(kind) {
  const model = VOICE[kind];
  if (!model) throw new Error(`unknown voice kind: ${kind}`);
  if (!process.env.GEMINI_API_KEY) throw new Error('voice needs GEMINI_API_KEY set where the hub runs');
  genai ??= new (require('@google/genai').GoogleGenAI)({ apiKey: process.env.GEMINI_API_KEY });
  const t = await genai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 30 * 60e3).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 60e3).toISOString(),
      liveConnectConstraints: { model },
      lockAdditionalFields: [],   // lock the model only; the client sends its own config
      httpOptions: { apiVersion: 'v1alpha' },
    },
  });
  return { token: t.name, model };
}

function startHub({ port = 7777, host = '127.0.0.1', token = process.env.AXO_TOKEN } = {}) {
  // the hub can make machines run commands, so it never listens openly
  if (!token && !LOOPBACK.has(host)) throw new Error('set AXO_TOKEN before listening beyond localhost');

  const wss = new WebSocketServer({ port, host, maxPayload: 1 << 20 });
  const devices = new Map();   // socket -> { name, agents }

  const roster = () => [...devices.values()]
    .flatMap((d) => d.agents.map((a) => ({ ...a, device: d.name })));
  const send = (ws, msg) => ws.send(JSON.stringify(msg));
  const broadcast = (msg) => { for (const c of wss.clients) if (c.authed) send(c, msg); };
  const ownerOf = (id) => [...devices].find(([, d]) => d.agents.some((a) => a.id === id))?.[0];

  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!ws.authed) {
        if (m.t !== 'hello' || (token && !same(m.token, token))) return ws.close(4001, 'bad token');
        ws.authed = true;
        ws.device = m.device || null;   // pills without a connector say no device
        return send(ws, { t: 'roster', agents: roster() });
      }
      if (m.t === 'agents' && ws.device && Array.isArray(m.list)) {
        devices.set(ws, { name: ws.device, agents: m.list });
        broadcast({ t: 'roster', agents: roster() });
      } else if (m.t === 'hand' && ws.device) {
        broadcast({ t: 'hand', agent: { ...m.agent, device: ws.device } });
      } else if (m.t === 'do') {
        const owner = ownerOf(m.id);
        // deliberately not queued: a stale "go ahead" must never fire hours later
        if (owner) send(owner, { t: 'do', op: m.op, id: m.id, text: m.text });
        else send(ws, { t: 'error', id: m.id, msg: "that agent's machine is offline" });
      } else if (m.t === 'voice') {
        voiceToken(m.kind).then(
          (r) => send(ws, { t: 'reply', ref: m.ref, ...r }),
          (e) => send(ws, { t: 'reply', ref: m.ref, error: e.message }),
        );
      }
    });
    ws.on('close', () => { if (devices.delete(ws)) broadcast({ t: 'roster', agents: roster() }); });
  });

  // routers silently drop idle sockets; a ping every 30s keeps them open and
  // catches the dead ones (clients answer pings on their own)
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
  }, 30000).unref();
  wss.on('close', () => clearInterval(beat));
  return wss;
}

if (require.main === module) {
  const host = process.env.AXO_HOST || '127.0.0.1';
  const port = Number(process.env.PORT) || 7777;
  startHub({ host, port }).on('listening', () => console.log(`hub on ws://${host}:${port}`));
}

module.exports = { startHub };
