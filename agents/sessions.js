'use strict';
// Runs agent CLIs headless for the pill (spawned sessions), parses their
// event stream through the agent's own module, and tracks each session's
// state. Agent-specific protocol lives in agents/<agent>/spawned.js.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');
const { brief } = require('./summary');

// ponytail: a plain object per agent, not a driver class. codex/grok slot in
// as more entries with different args, no class hierarchy.
const VENDORS = {
  claude: require('./claude/spawned'),
};

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
    const proc = { child, vendor, stderr: '', turn: v.turn() };
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

module.exports = { Sessions, VENDORS };
