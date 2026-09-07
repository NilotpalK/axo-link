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

/** "Edit x3, Bash x2" -- what it did, without asking a model to summarise. */
const tally = (names) => {
  const c = new Map();
  for (const n of names) c.set(n, (c.get(n) || 0) + 1);
  return [...c].map(([n, k]) => (k > 1 ? `${n} \u00d7${k}` : n)).join(', ');
};

/** The interesting half of a tool call, for "wants to run: Bash(rm -rf /)". */
const argPreview = (input) => {
  const v = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern
    ?? input?.url ?? (input && JSON.stringify(input));
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 59) + '\u2026' : s;
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
      '--session-id', sid,
    ],
    write: (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n',
    // (line, per-turn scratch) -> state patch, or null for lines we ignore
    parse: (o, turn) => {
      if (o.type === 'system' && o.subtype === 'init') return { model: o.model };

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
        // The CLI's own docs call result.permission_denials "the authoritative
        // record" of what it was blocked from doing. Shape: {tool_name,
        // tool_input, tool_use_id}.
        const denied = Array.isArray(o.permission_denials) ? o.permission_denials : [];
        const summary = brief(o.result || turn.text);
        return {
          state: o.is_error === true ? 'error' : 'waiting',
          waiting_kind: denied.length ? 'approval_request'
            : /\?["')\]]*\s*$/.test(summary) ? 'question'
            : 'finished',
          pending: denied.map((d) => `${d.tool_name}(${argPreview(d.tool_input)})`),
          summary,
          did: tally(turn.tools),
        };
      }
      return null;
    },
  },
};

const freshTurn = () => ({ tools: [], text: '' });

class Sessions extends EventEmitter {
  #procs = new Map();   // id -> { child, vendor, stderr, turn }
  #state = new Map();   // id -> record rendered by the pill
  #spawn;

  constructor(spawnFn = spawn) {
    super();
    this.#spawn = spawnFn;
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
      state: 'idle', waiting_kind: null,
      last: '', summary: '', did: '', pending: [],
      since: Date.now(),
    });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let o;
      try { o = JSON.parse(line); } catch { return; }   // partial/non-JSON noise
      const patch = v.parse(o, proc.turn);
      if (patch) this.#set(id, patch);
    });
    child.stderr?.on('data', (d) => { proc.stderr = (proc.stderr + d).slice(-500); });
    child.on('error', (e) => this.#set(id, { state: 'error', last: e.message, summary: e.message }));
    child.on('exit', (code) => {
      this.#procs.delete(id);
      // a clean exit is just an idle session; a crash should say why
      if (code) {
        const why = proc.stderr.trim() || `exited ${code}`;
        this.#set(id, { state: 'error', last: why, summary: brief(why) });
      } else this.#set(id, { state: 'idle' });
    });
    return id;
  }

  send(id, text) {
    const p = this.#procs.get(id);
    if (!p || !p.child.stdin?.writable) return false;
    p.child.stdin.write(VENDORS[p.vendor].write(text));
    p.turn = freshTurn();
    this.#set(id, {
      state: 'running', last: text,
      waiting_kind: null, summary: '', did: '', pending: [],
    });
    return true;
  }

  // ponytail: post-hoc approval -- the turn has already settled, so "approved"
  // is just the next turn on the still-open session. Ceiling: the agent reports
  // and stops rather than pausing mid-work. Upgrade when voice lands:
  // --permission-prompt-tool pointed at an MCP `approve` tool returning
  // {"behavior":"allow"}, which blocks the CLI mid-turn until you answer.
  approve(id) { return this.send(id, 'Approved. Go ahead and do that.'); }
  deny(id) { return this.send(id, "Denied. Don't do that \u2014 tell me what you'd do instead."); }

  stop(id) { this.#procs.get(id)?.child.kill(); }

  /** Upsert an external (non-CLI) session record — e.g. a Layer hub whisper. */
  upsertExternal(rec) {
    if (!rec?.id) throw new Error('upsertExternal: id required');
    this.#set(rec.id, rec);
    return this.#state.get(rec.id);
  }

  isHub(id) {
    const s = this.#state.get(id);
    return Boolean(s && (s.hub || s.vendor === 'layer-hub'));
  }

  /** Soft-dismiss from the focused card without sending a turn. */
  hold(id) {
    if (!this.#state.get(id)) return false;
    this.#set(id, { held: true });
    return true;
  }

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

module.exports = { Sessions, VENDORS, brief, tally };
