'use strict';
// The hub's whole job: merge every machine's agents into one roster, route an
// instruction to the machine that owns the agent, and shut strangers out.
// Real hub, real sockets, fake agents.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter, once } = require('node:events');
const { startHub, plausible, loadEnv } = require('./hub');
const { connect } = require('../shared/link');

// one machine's agents, plus a record of every instruction it was handed
function machine(agent) {
  const s = new EventEmitter();
  s.told = [];
  s.list = () => [agent];
  for (const op of ['send', 'approve', 'deny', 'stop']) {
    s[op] = (id, text) => {
      s.told.push([op, id, text]);
      if (text === 'not now') throw new Error('something is half-typed there');   // a machine saying why not
      return true;
    };
  }
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

  // the home pill approves the office agent, and hears back once it's done
  assert.equal((await homeLink.do('approve', 'b1')).ok, true);
  assert.deepEqual(office.told, [['approve', 'b1', undefined]]);
  assert.deepEqual(home.told, []);

  await assert.rejects(homeLink.do('send', 'b1', 'not now'), /half-typed there/, "the machine's reason comes back");
  await assert.rejects(homeLink.do('send', 'gone', 'hello'), /offline/);

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

test('.env values win over the environment, and a blank one leaves it alone', () => {
  const file = require('node:path').join(require('node:os').tmpdir(), `axo-env-${process.pid}`);
  require('node:fs').writeFileSync(file, '# keys\nAXO_T_NEW=from-file\nAXO_T_OLD=replaced\nAXO_T_BLANK=\n');
  process.env.AXO_T_OLD = 'stale';
  process.env.AXO_T_BLANK = 'still-works';
  loadEnv(file);
  assert.equal(process.env.AXO_T_NEW, 'from-file');
  assert.equal(process.env.AXO_T_OLD, 'replaced', 'the file wins over an old setx value');
  assert.equal(process.env.AXO_T_BLANK, 'still-works', 'a blank placeholder never wipes a working key');
  loadEnv(file + '-missing');   // no .env at all: nothing happens
  require('node:fs').rmSync(file);
  for (const k of ['AXO_T_NEW', 'AXO_T_OLD', 'AXO_T_BLANK']) delete process.env[k];
});

test('dictation clean-up may tidy your words but not answer or rewrite them', () => {
  // tidied: fillers out, a self-correction applied, a number written as a digit
  assert.ok(plausible('um what\'s the capital of uh france', "What's the capital of France?"));
  assert.ok(plausible('send it to john at three no wait four pm and uh cc sarah', 'Send it to John at 4 PM and CC Sarah.'));
  assert.ok(plausible('uh um okay', 'Okay.'));
  // answered or rewritten: paste the exact words instead
  assert.ok(!plausible('um what\'s the capital of uh france', 'Paris.'));
  assert.ok(!plausible('what is a closure', 'A closure is a function that keeps access to the variables of the scope it was created in.'));
  assert.ok(!plausible('lets ship the hub today and the pill tomorrow', 'Here is a plan for shipping your projects on time.'));
  assert.ok(!plausible('hello there', ''));
});

test('wrong tokens and odd messages are shut out without taking the hub down', async () => {
  assert.throws(() => startHub({ port: 0, token: '' }), /AXO_TOKEN/, 'localhost needs a token too');
  const { h, url } = await hub();

  const ws = new WebSocket(url);
  await once(ws, 'open');
  for (const m of ['null', '5', '"hello"', '[]']) ws.send(m);   // valid JSON, not messages
  ws.send(JSON.stringify({ t: 'hello', token: 'sécret' }));   // as many characters as 'secret', more bytes
  const [ev] = await once(ws, 'close');
  assert.equal(ev.code, 4001);

  // every browser sends an Origin header; the app's own connections don't
  const browserLike = new (require('ws'))(url, { origin: 'https://example.com' });
  const [err] = await once(browserLike, 'error');
  assert.match(err.message, /401/);

  const ok = new WebSocket(url);   // and the hub is still there for the real thing
  await once(ok, 'open');
  ok.send(JSON.stringify({ t: 'hello', token: 'secret' }));
  const [msg] = await once(ok, 'message');
  assert.equal(JSON.parse(msg.data).t, 'roster');
  ok.close();
  h.close();
});

test('a question reaches the machine that owns the agent, and its answer comes back', async () => {
  const { h, url } = await hub();
  const owner = machine({ id: 't1', label: 'terminal', state: 'idle' });
  owner.query = (op, id) => ({ text: `${op} of ${id}` });
  const other = machine({ id: 'x1', label: 'other', state: 'idle' });
  other.query = () => ({ text: 'not mine to answer' });
  const seen = [];
  const a = connect({ url, token: 'secret', device: 'A', sessions: owner });
  const b = connect({ url, token: 'secret', device: 'B', sessions: other, onMessage: (m) => seen.push(m) });
  await until(() => seen.findLast((m) => m.t === 'roster')?.agents.length === 2);

  const r = await b.ask({ t: 'query', op: 'screen', id: 't1' });
  assert.equal(r.text, 'screen of t1');
  await assert.rejects(b.ask({ t: 'query', op: 'screen', id: 'gone' }), /offline/);
  a.close();
  b.close();
  h.close();
});

test('a machine that dials in before the hub is up keeps trying until it gets through', async () => {
  // a port nobody is listening on yet
  const probe = startHub({ port: 0, token: 'secret' });
  await once(probe, 'listening');
  const port = probe.address().port;
  probe.close();
  await once(probe, 'close');

  const pc = connect({
    url: `ws://127.0.0.1:${port}`, token: 'secret', device: 'early',
    sessions: machine({ id: 'e1', label: 'early bird', state: 'idle' }),
  });
  await new Promise((r) => setTimeout(r, 300));   // its first attempt has failed by now
  const h = startHub({ port, token: 'secret' });
  await once(h, 'listening');
  const seen = [];
  const pill = connect({ url: `ws://127.0.0.1:${port}`, token: 'secret', device: 'pill',
    sessions: machine({ id: 'p1', label: 'pill', state: 'idle' }), onMessage: (m) => seen.push(m) });
  await until(() => seen.findLast((m) => m.t === 'roster')?.agents.some((a) => a.id === 'e1'), 8000);
  pc.close();
  pill.close();
  h.close();
});

test('the roster only carries well-formed agents', async () => {
  const { h, url } = await hub();
  const odd = Object.assign(new EventEmitter(), {
    list: () => [
      { id: 'ok-1', state: 'idle', label: 'fine' },
      { id: 'has "quotes" and spaces', state: 'idle' },
      { id: 'ok-2', state: 'not-a-state' },
      null,
    ],
  });
  const seen = [];
  const pc = connect({ url, token: 'secret', device: 'PC', sessions: odd, onMessage: (m) => seen.push(m) });
  const r = await until(() => seen.findLast((m) => m.t === 'roster' && m.agents.length));
  assert.deepEqual(r.agents.map((a) => a.id), ['ok-1']);
  pc.close();
  h.close();
});
