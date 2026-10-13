'use strict';
// The desktop app's one socket to the hub, playing both roles over it:
// connector (reports this machine's agents, carries out instructions sent down
// to it) and pill (receives the roster merged from every machine). It dials
// out and redials forever, so the hub never needs a way in.
const OPS = new Set(['send', 'approve', 'deny', 'stop']);

function connect({ url, token, device, sessions, onMessage = () => {} }) {
  let ws, wait = 1000, closed = false, refs = 0;
  const replies = new Map();   // ref -> settle(), for ask()
  const send = (msg) => ws?.readyState === WebSocket.OPEN && (ws.send(JSON.stringify(msg)), true);
  // ponytail: full snapshot on every change -- a handful of agents per machine.
  // Send patches if rosters ever get big.
  const report = () => send({ t: 'agents', list: sessions.list() });

  sessions.on('update', report);
  // ponytail: a hand raised while disconnected isn't replayed as a
  // notification; the agent still shows as waiting in the next snapshot
  sessions.on('waiting', (agent) => send({ t: 'hand', agent }));

  (function open() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      wait = 1000;
      send({ t: 'hello', token, device });
      report();
      onMessage({ t: 'link', up: true });
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'reply') return replies.get(m.ref)?.(m);
      if (m.t !== 'do') return onMessage(m);
      if (OPS.has(m.op)) sessions[m.op](m.id, m.text);
    };
    ws.onclose = () => {
      if (closed) return;
      onMessage({ t: 'link', up: false });
      setTimeout(open, wait);
      wait = Math.min(wait * 2, 30000);
    };
  })();

  return {
    do: (op, id, text) => send({ t: 'do', op, id, text }),
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
    close: () => { closed = true; ws.close(); },
  };
}

module.exports = { connect };
