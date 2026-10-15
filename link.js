'use strict';
// The desktop app's one socket to the hub, playing both roles over it:
// connector (reports this machine's agents, carries out instructions sent down
// to it) and pill (receives the roster merged from every machine). It dials
// out and redials forever, so the hub never needs a way in.
const OPS = new Set(['send', 'approve', 'deny', 'stop']);
// url and token may be functions, read afresh on every (re)connect: the
// launcher takes them from a file the app rewrites each run with a new token
const value = (v) => (typeof v === 'function' ? v() : v);

function connect({ url, token, device, sessions, onMessage = () => {} }) {
  let ws, wait = 1000, closed = false, refs = 0, retry;
  const replies = new Map();   // ref -> settle(), for ask()
  const send = (msg) => ws?.readyState === WebSocket.OPEN && (ws.send(JSON.stringify(msg)), true);
  // ponytail: full snapshot on every change -- a handful of agents per machine.
  // Send patches if rosters ever get big.
  const report = () => send({ t: 'agents', list: sessions.list() });

  sessions.on('update', report);
  // ponytail: a hand raised while disconnected isn't replayed as a
  // notification; the agent still shows as waiting in the next snapshot
  sessions.on('waiting', (agent) => send({ t: 'hand', agent }));

  /** a question the hub passed on for one of this machine's agents */
  async function answer(m) {
    let r;
    try { r = await sessions.query?.(m.op, m.id); } catch (e) { r = { error: e.message }; }
    send({ t: 'answer', ref: m.ref, ...(r || { error: `that session can't answer "${m.op}"` }) });
  }

  const later = (fn) => {
    if (closed) return;
    retry = setTimeout(fn, wait);
    wait = Math.min(wait * 2, 30000);
  };

  (function open() {
    const target = value(url);
    if (!target) return later(open);   // no hub known yet: the app isn't running
    ws = new WebSocket(target);
    ws.onopen = () => {
      wait = 1000;
      send({ t: 'hello', token: value(token), device });
      report();
      onMessage({ t: 'link', up: true });
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'reply') return replies.get(m.ref)?.(m);
      if (m.t === 'query') return answer(m);
      if (m.t !== 'do') return onMessage(m);
      // an approval carries the request ids it was given for; everything else, text
      if (OPS.has(m.op)) sessions[m.op](m.id, m.op === 'approve' ? m.asks : m.text);
    };
    // A refused connection fires only 'error' -- Node's WebSocket sends no
    // 'close' then -- and a dropped one fires 'close', sometimes after an
    // 'error'. Either way: say so once, and try again once.
    let over = false;
    const lost = () => {
      if (over || closed) return;
      over = true;
      onMessage({ t: 'link', up: false });
      later(open);
    };
    ws.onerror = lost;
    ws.onclose = lost;
  })();

  return {
    do: (op, id, text, asks) => send({ t: 'do', op, id, text, asks }),
    /** request/reply over the same socket: resolves with the hub's reply, rejects on its error */
    ask: (msg, ms = 10000) => new Promise((resolve, reject) => {
      const ref = ++refs;
      const t = setTimeout(() => settle({ error: 'the hub did not answer' }), ms);
      const settle = (m) => {
        clearTimeout(t);
        replies.delete(ref);
        if (m.error) reject(new Error(m.error)); else resolve(m);
      };
      replies.set(ref, settle);
      if (!send({ ...msg, ref })) settle({ error: 'not connected to the hub' });
    }),
    close: () => { closed = true; clearTimeout(retry); ws?.close(); },
  };
}

module.exports = { connect };
