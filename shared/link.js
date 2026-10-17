'use strict';
// The desktop app's one socket to the hub, playing both roles over it:
// connector (reports this machine's agents, carries out instructions sent down
// to it) and pill (receives the roster merged from every machine). It dials
// out and redials forever, so the hub never needs a way in.
const OPS = new Set(['send', 'approve', 'deny', 'stop', 'press']);
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

  /** answer the hub about one of this machine's agents: a question, or how an instruction went */
  async function answer(ref, fn) {
    let r;
    try { r = await fn(); } catch (e) { r = { error: e.message }; }
    send({ t: 'answer', ref, ...r });
  }
  // An instruction's outcome: true is done, false a plain no. A session that
  // can say why not throws, and its message is passed back as is.
  const outcome = (op, r) => (r === true ? { ok: true } : { error: `couldn't ${op} it` });

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
      if (m.t === 'query') {
        return answer(m.ref, async () => (await sessions.query?.(m.op, m.id)) || { error: `that session can't answer "${m.op}"` });
      }
      if (m.t !== 'do') return onMessage(m);
      if (!OPS.has(m.op) || typeof sessions[m.op] !== 'function') {
        return m.ref !== undefined && answer(m.ref, () => ({ error: `that session can't ${m.op}` }));
      }
      // an approval carries the request ids it was given for; everything else, text
      const run = () => sessions[m.op](m.id, m.op === 'approve' ? m.asks : m.text);
      if (m.ref === undefined) return run();
      answer(m.ref, async () => outcome(m.op, await run()));
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

  /** request/reply over the same socket: resolves with the hub's reply, rejects on its error */
  const ask = (msg, ms = 10000) => new Promise((resolve, reject) => {
    const ref = ++refs;
    const t = setTimeout(() => settle({ error: 'the hub did not answer' }), ms);
    const settle = (m) => {
      clearTimeout(t);
      replies.delete(ref);
      if (m.error) reject(new Error(m.error)); else resolve(m);
    };
    replies.set(ref, settle);
    if (!send({ ...msg, ref })) settle({ error: 'not connected to the hub' });
  });

  return {
    /** an instruction for an agent: resolves once its machine has carried it out, rejects saying why not */
    do: (op, id, text, asks) => ask({ t: 'do', op, id, text, asks }),
    ask,
    close: () => { closed = true; clearTimeout(retry); ws?.close(); },
  };
}

module.exports = { connect };
