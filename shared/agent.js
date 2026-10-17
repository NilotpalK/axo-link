'use strict';
// Spawns agent CLIs, parses their NDJSON event stream, tracks session state.
// Per-vendor protocol lives in VENDORS; verified against OpenMausBot's
// server/drivers/claude.ts (Apache-2.0, github.com/milind-soni/OpenMausBot)
// and against the shipping `claude` binary's own schema.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');

const blockText = (msg) => (Array.isArray(msg?.content) ? msg.content : [])
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('')
  .trim();

/** First two sentences, hard-capped. This is what gets spoken, so it has to
 *  stand alone -- no "as mentioned above". */
const brief = (s, max = 200) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^.*?[.!?](?:\s+.*?[.!?])?(?=\s|$)/);
  const out = m ? m[0] : t;
  return out.length > max ? out.slice(0, max - 1).trimEnd() + '\u2026' : out;
};

/** a turn that ends on a question is waiting on an answer, not just done */
const kindOf = (summary) => (/\?["')\]]*\s*$/.test(summary) ? 'question' : 'finished');

/** "Edit x3, Bash x2" -- what it did, without asking a model to summarise. */
const tally = (names) => {
  const c = new Map();
  for (const n of names) c.set(n, (c.get(n) || 0) + 1);
  return [...c].map(([n, k]) => (k > 1 ? `${n} \u00d7${k}` : n)).join(', ');
};

/** The interesting half of a tool call, for "wants to run: Bash(rm -rf /)".
 *  Whole, not a preview: you approve what you read, so it can't be cut short.
 *  The cap only stops a pathological input from flooding the pill. */
const argText = (input) => {
  const v = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern
    ?? input?.url ?? (input && JSON.stringify(input));
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 2000 ? s.slice(0, 1999) + '\u2026' : s;
};

// ponytail: a plain object per vendor, not a driver class. codex/grok slot in
// as two more entries with different args, no class hierarchy.
const VENDORS = {
  claude: {
    cmd: 'claude',
    args: (sid) => [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',                        // required by stream-json output
      '--permission-mode', 'acceptEdits',
      // anything acceptEdits won't auto-allow comes back to us as a
      // control_request, and the CLI pauses mid-turn until we answer it
      '--permission-prompt-tool', 'stdio',
      '--session-id', sid,
    ],
    write: (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n',
    answer: (ask, allow, why) => JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: ask.id,
        response: allow ? { behavior: 'allow', updatedInput: ask.input } : { behavior: 'deny', message: why },
      },
    }) + '\n',
    // (line, per-turn scratch, write-to-stdin) -> state patch, or null for lines we ignore
    parse: (o, turn, reply) => {
      if (o.type === 'system' && o.subtype === 'init') return { model: o.model };

      // Mid-turn permission prompt. Shape read out of claude 2.1.296:
      // {type:'control_request', request_id, request:{subtype:'can_use_tool', tool_name, input, ...}}
      if (o.type === 'control_request') {
        const r = o.request || {};
        if (r.subtype !== 'can_use_tool') {
          // never leave the CLI blocked on a request we don't handle
          reply(JSON.stringify({
            type: 'control_response',
            response: { subtype: 'error', request_id: o.request_id, error: `unsupported: ${r.subtype}` },
          }) + '\n');
          return null;
        }
        turn.asks.push({ id: o.request_id, input: r.input, label: `${r.tool_name}(${argText(r.input)})` });
        return asking(turn);
      }
      if (o.type === 'control_cancel_request') {
        if (!turn.asks.some((a) => a.id === o.request_id)) return null;
        turn.asks = turn.asks.filter((a) => a.id !== o.request_id);
        return turn.asks.length ? asking(turn) : { state: 'running', waiting_kind: null, pending: [], pending_ids: [] };
      }

      if (o.type === 'assistant') {
        for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
          if (b.type === 'tool_use') turn.tools.push(b.name);
        }
        const t = blockText(o.message);
        if (!t) return null;
        turn.text = t;
        return { last: t };
      }

      if (o.type === 'result') {
        // approvals are answered mid-turn now, so a settled turn is never
        // waiting on one -- anything in permission_denials we denied ourselves
        const summary = brief(o.result || turn.text);
        turn.asks = [];
        return {
          state: o.is_error === true ? 'error' : 'waiting',
          waiting_kind: kindOf(summary),
          pending: [], pending_ids: [],
          summary,
          did: tally(turn.tools),
        };
      }
      return null;
    },
  },
};

const freshTurn = () => ({ tools: [], text: '', asks: [] });
const asking = (turn) => ({
  state: 'waiting', waiting_kind: 'approval_request',
  pending: turn.asks.map((a) => a.label),
  pending_ids: turn.asks.map((a) => a.id),   // what an approval has to name
  summary: brief(turn.text), did: tally(turn.tools),
});

class Sessions extends EventEmitter {
  #procs = new Map();   // id -> { child, vendor, stderr, turn }
  #state = new Map();   // id -> record rendered by the pill
  #spawn;
  #stopWait;   // how long stop() waits for the process to exit

  constructor(spawnFn = spawn, { stopWait = 5000 } = {}) {
    super();
    this.#spawn = spawnFn;
    this.#stopWait = stopWait;
  }

  list() { return [...this.#state.values()]; }

  start({ vendor = 'claude', label, cwd = process.cwd() } = {}) {
    const v = VENDORS[vendor];
    if (!v) throw new Error(`unknown vendor: ${vendor}`);
    const id = randomUUID();
    // ponytail: shell:true on Windows resolves the claude.cmd shim. Safe here --
    // every arg is our own constant or a UUID; user text goes over stdin, never argv.
    const child = this.#spawn(v.cmd, v.args(id), {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const proc = { child, vendor, stderr: '', turn: freshTurn() };
    this.#procs.set(id, proc);
    this.#set(id, {
      id, vendor, cwd,
      label: label || `${vendor} ${id.slice(0, 4)}`,
      state: 'idle', waiting_kind: null, alive: true,
      last: '', summary: '', did: '', pending: [], pending_ids: [],
      since: Date.now(),
    });

    const reply = (l) => child.stdin?.writable && child.stdin.write(l);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let o;
      try { o = JSON.parse(line); } catch { return; }   // partial/non-JSON noise
      const patch = v.parse(o, proc.turn, reply);
      if (patch) this.#set(id, patch);
    });
    child.stderr?.on('data', (d) => { proc.stderr = (proc.stderr + d).slice(-500); });
    // The session ends once, whichever event says so. A CLI that can't start
    // (no pid) fires only 'error', and Node doesn't promise an 'exit' after it;
    // an 'error' from one that's running (a kill that failed) doesn't end it.
    let ended = false;
    const end = (patch) => {
      if (ended) return;
      ended = true;
      this.#procs.delete(id);
      this.#set(id, { alive: false, waiting_kind: null, pending: [], pending_ids: [], ...patch });
    };
    child.on('error', (e) => {
      const why = { state: 'error', last: e.message, summary: brief(e.message) };
      if (child.pid === undefined) end(why); else this.#set(id, why);
    });
    child.on('exit', (code) => {
      // a stop we asked for, or a clean exit, just ends the session; a crash should say why
      if (code && !proc.stopping) {
        const why = proc.stderr.trim() || `exited ${code}`;
        end({ state: 'error', last: why, summary: brief(why) });
      } else end({ state: 'exited' });
    });
    return id;
  }

  send(id, text) {
    const p = this.#procs.get(id);
    if (!p || !p.child.stdin?.writable) return false;
    // typing back while it waits on approval is "no -- do this instead"
    if (p.turn.asks.length) return this.#answer(id, false, text);
    p.child.stdin.write(VENDORS[p.vendor].write(text));
    p.turn = freshTurn();
    // `last` stays the agent's own words; what you sent is `prompt`
    this.#set(id, {
      state: 'running', prompt: text,
      waiting_kind: null, summary: '', did: '', pending: [], pending_ids: [],
    });
    return true;
  }

  /** Approve exactly the requests you were shown, named by id. If the agent
   *  has since withdrawn one or added another, nothing is approved. */
  approve(id, asks) {
    const p = this.#procs.get(id);
    const now = p?.turn.asks.map((a) => a.id) ?? [];
    const same = Array.isArray(asks) && asks.length === now.length && now.every((x) => asks.includes(x));
    return same && this.#answer(id, true);
  }
  // refusing is safe whatever changed, so deny needs no ids
  deny(id) { return this.#answer(id, false, "Denied. Don't do that \u2014 tell me what you'd do instead."); }

  // ponytail: one answer covers every pending ask (parallel tool calls come in
  // together). Per-ask approve if mixed allow/deny ever matters.
  #answer(id, allow, why) {
    const p = this.#procs.get(id);
    if (!p?.turn.asks.length || !p.child.stdin?.writable) return false;
    for (const a of p.turn.asks) p.child.stdin.write(VENDORS[p.vendor].answer(a, allow, why));
    p.turn.asks = [];
    this.#set(id, { state: 'running', waiting_kind: null, pending: [], pending_ids: [] });
    return true;
  }

  /** Resolves once the process has really exited; rejects if it's still
   *  running after a while, so "stopped" is never said too early. */
  stop(id) {
    const p = this.#procs.get(id);
    if (!p) return false;
    const gone = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.#state.get(id)?.label || 'the session'} didn't stop`)), this.#stopWait);
      p.child.once('exit', () => { clearTimeout(t); resolve(true); });
    });
    p.stopping = true;
    // shell:true puts cmd.exe between us and claude, so kill() would only take
    // out cmd.exe. taskkill /T takes the whole tree, claude's tool runs included.
    if (process.platform === 'win32' && p.child.pid) {
      spawn('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else p.child.kill();
    return gone;
  }

  stopAll() { for (const id of this.#procs.keys()) Promise.resolve(this.stop(id)).catch(() => {}); }

  #set(id, patch) {
    const prev = this.#state.get(id) || {};
    const next = { ...prev, ...patch };
    if (patch.state && patch.state !== prev.state) next.since = Date.now();
    this.#state.set(id, next);
    this.emit('update', this.list());
    // the one transition this whole app exists to catch
    if (next.state === 'waiting' && prev.state !== 'waiting') this.emit('waiting', next);
  }
}

module.exports = { Sessions, VENDORS, brief, tally, argText, kindOf };
