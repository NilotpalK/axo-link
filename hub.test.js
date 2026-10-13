'use strict';
// The hub's whole job: merge every machine's agents into one roster, route an
// instruction to the machine that owns the agent, and shut strangers out.
// Real hub, real sockets, fake agents.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter, once } = require('node:events');
const { startHub } = require('./hub');
const { connect } = require('./link');

// one machine's agents, plus a record of every instruction it was handed
function machine(agent) {
  const s = new EventEmitter();
  s.told = [];
  s.list = () => [agent];
  for (const op of ['send', 'approve', 'deny', 'stop']) s[op] = (id, text) => s.told.push([op, id, text]);
  return s;
}

const until = (pred, ms = 3000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    const v = pred();
    if (v) return resolve(v);
    if (Date.now() - t0 > ms) return reject(new Error('timed out'));
    setTimeout(poll, 10);
  })();
});

async function hub() {
  const h = startHub({ port: 0, token: 'secret' });
  await once(h, 'listening');
  return { h, url: `ws://127.0.0.1:${h.address().port}` };
}

test('one roster across machines; instructions land on the machine that owns the agent', async () => {
  const { h, url } = await hub();
  const home = machine({ id: 'a1', label: 'claude 1', state: 'waiting' });
  const office = machine({ id: 'b1', label: 'codex', state: 'running' });
  const seen = [];
  const homeLink = connect({ url, token: 'secret', device: 'Home PC', sessions: home, onMessage: (m) => seen.push(m) });
  const officeLink = connect({ url, token: 'secret', device: 'Office PC', sessions: office });

  const r = await until(() => seen.findLast((m) => m.t === 'roster' && m.agents.length === 2));
  assert.deepEqual(r.agents.map((a) => `${a.label}@${a.device}`).sort(), ['claude 1@Home PC', 'codex@Office PC']);

  homeLink.do('approve', 'b1');   // the home pill approves the office agent
  await until(() => office.told.length);
  assert.deepEqual(office.told, [['approve', 'b1', undefined]]);
  assert.deepEqual(home.told, []);

  homeLink.do('send', 'gone', 'hello');
  const err = await until(() => seen.find((m) => m.t === 'error'));
  assert.match(err.msg, /offline/);

  officeLink.close();             // a machine dropping off takes its agents with it
  await until(() => seen.findLast((m) => m.t === 'roster')?.agents.length === 1);

  homeLink.close();
  h.close();
});

test('voice tokens are asked of the hub, which says plainly when it has no Gemini key', async () => {
  const { h, url } = await hub();
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  let up;
  const connected = new Promise((r) => { up = r; });
  const pill = connect({ url, token: 'secret', device: 'x', sessions: machine({ id: 'a', label: 'a' }),
    onMessage: (m) => m.t === 'link' && m.up && up() });
  await connected;

  await assert.rejects(pill.ask({ t: 'voice', kind: 'talk' }), /GEMINI_API_KEY/);
  await assert.rejects(pill.ask({ t: 'voice', kind: 'karaoke' }), /unknown voice kind/);

  if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
  pill.close();
  h.close();
});

test('a socket without the right token is shut out, and an open hub needs a token', async () => {
  const { h, url } = await hub();
  const ws = new WebSocket(url);
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'hello', token: 'wrong' }));
  const [ev] = await once(ws, 'close');
  assert.equal(ev.code, 4001);
  h.close();

  assert.throws(() => startHub({ host: '0.0.0.0', token: '' }), /AXO_TOKEN/);
});
