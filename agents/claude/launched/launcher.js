#!/usr/bin/env node
'use strict';
// `axo claude [arguments]`: the real Claude Code in your terminal, with
// axo-link sitting in between. Everything you type and everything Claude draws
// passes straight through, untouched. On the side:
//  - the session shows up in the pill, and axo can type into it ("tell
//    deskill to run the tests"), as if you had typed it;
//  - Claude's hooks, for this session only, tell the launcher what's going
//    on: working, done (with Claude's last message, word for word), needs
//    permission (with the exact command), waiting on you;
//  - the launcher keeps an exact copy of the screen, so axo can read out what's
//    there -- menus and pickers included, which no hook reports.
//
// The launcher is a connector with one agent: it dials the hub like the app
// does, and the hub routes instructions and questions for this session to it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { randomUUID, randomBytes } = require('node:crypto');
const { connect } = require('../../../shared/link');
const { brief, tally, argText, kindOf } = require('../../sessions');

/** where the companion app leaves the hub's address and this run's token */
function hubFile() {
  if (process.env.AXO_HUB_FILE) return process.env.AXO_HUB_FILE;
  const base = process.platform === 'win32' ? process.env.APPDATA
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'axo-link', 'hub.json');
}
const readHub = () => { try { return JSON.parse(fs.readFileSync(hubFile(), 'utf8')); } catch { return {}; } };

/** the claude to run: a real .exe directly, an npm .cmd shim through cmd.exe */
function which(cmd) {
  if (process.platform !== 'win32') return { file: cmd, pre: [] };
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (fs.existsSync(path.join(dir, `${cmd}.exe`))) return { file: path.join(dir, `${cmd}.exe`), pre: [] };
    if (fs.existsSync(path.join(dir, `${cmd}.cmd`))) return { file: process.env.ComSpec || 'cmd.exe', pre: ['/c', cmd] };
  }
  return { file: cmd, pre: [] };
}

/** Claude's hooks call this; each event moves the session's state on.
 *  `state` reads the session's current state, Esc included, which no hook reports. */
function stateMachine(set, state = () => null) {
  let tools = [], known = null;
  return (e) => {
    // Claude's own id for the session, for reading its history: every event
    // carries it (SessionStart would be first, but Claude sends it no HTTP hooks)
    if (typeof e.session_id === 'string' && e.session_id !== known) set({ claude_session: (known = e.session_id) });
    switch (e.hook_event_name) {
      case 'UserPromptSubmit':
        // typed mid-task, it joins the running turn and one Stop covers both
        // (claude 2.1.301), so the tally carries on; a new turn starts afresh
        if (state() !== 'running') tools = [];
        return set({ state: 'running', prompt: e.prompt, waiting_kind: null, pending: [], did: tally(tools), summary: '' });
      case 'PostToolUse':
        tools.push(e.tool_name);
        // a tool ran, so whatever it was asking permission for has been answered
        return set({ state: 'running', waiting_kind: null, pending: [], did: tally(tools) });
      case 'PermissionRequest':
        return set({ state: 'waiting', waiting_kind: 'approval_request', pending: [`${e.tool_name}(${argText(e.tool_input)})`] });
      case 'Stop': {
        const last = String(e.last_assistant_message ?? '');   // Claude's own words, kept whole
        const summary = brief(last);
        return set({ state: 'waiting', waiting_kind: kindOf(summary), pending: [], last, summary, did: tally(tools) });
      }
      case 'StopFailure': {
        // the turn died on an API error (rate limit, overloaded, billing...): Stop never comes
        const details = typeof e.error_details === 'string' ? e.error_details : e.error_details && JSON.stringify(e.error_details);
        const why = brief([e.error || 'unknown error', details].filter(Boolean).join(': '));
        const last = typeof e.last_assistant_message === 'string' && e.last_assistant_message ? { last: e.last_assistant_message } : {};
        return set({ state: 'error', waiting_kind: null, pending: [], ...last, summary: `the turn failed (${why})`, did: tally(tools) });
      }
      case 'Notification':
        // Claude saying it's sat waiting for input, without a turn having ended
        if (e.notification_type === 'idle_prompt') return set({ state: 'waiting', waiting_kind: kindOf(e.message || ''), pending: [] });
    }
  };
}

// what axo may press in a terminal; letters and digits besides. No Ctrl
// combinations: Ctrl+C twice quits Claude.
const KEYS = {
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  enter: '\r', esc: '\x1b', tab: '\t', space: ' ', backspace: '\x7f',
};
/** the bytes for a key name, or null; only the names above, never Object's own properties */
const keyBytes = (name) => {
  const n = String(name);
  return Object.hasOwn(KEYS, n.toLowerCase()) ? KEYS[n.toLowerCase()] : /^[a-z0-9]$/i.test(n) ? n : null;
};

// escape sequences (arrows, Alt+key, a lone Esc) move the cursor; they type nothing
const ESCAPES = /\x1b(?:\[[\d;?]*[ -/]*[@-~]|O.|.?)/gs;
const PASTE = ['\x1b[200~', '\x1b[201~'];   // a terminal wraps pasted text in these

/** Roughly how much is typed into Claude's prompt and not yet sent, from the
 *  keys pressed, as they arrive. axo won't type on top of it: a half-written
 *  line and its words would go in as one message.
 *  ponytail: counts keys, doesn't read the prompt. A line recalled with the
 *  up arrow, or a big paste Claude shows as one "[Pasted text]" chip that a
 *  single backspace deletes, is miscounted. Read the prompt line off the
 *  screen copy if that bites. */
function drafts() {
  let n = 0, pasting = false;
  const keys = (s) => {
    for (const ch of s.replace(ESCAPES, '')) {
      if (ch === '\r' || ch === '\x03' || ch === '\x15') n = 0;   // Enter, Ctrl+C, Ctrl+U
      else if (ch === '\x7f' || ch === '\b') n = Math.max(0, n - 1);
      else if (ch >= ' ') n++;
    }
  };
  return {
    // a paste is all text, line breaks included, however many chunks it spans
    typed(s) {
      while (s) {
        const mark = PASTE[pasting ? 1 : 0], at = s.indexOf(mark);
        const before = at < 0 ? s : s.slice(0, at);
        if (pasting) n += [...before].length; else keys(before);
        if (at < 0) return;
        pasting = !pasting;
        s = s.slice(at + mark.length);
      }
    },
    left: () => n,
    add: (k) => { n += k; },
    clear: () => { n = 0; },
  };
}

/** Run `file args` in a pseudo-terminal wired to this terminal, and register
 *  it with the hub. Resolves with the exit code when the program ends. */
async function launch({ file, args, id, cwd = process.cwd(), typeDelay = 150, keyDelay = 60 }) {
  const out = process.stdout, input = process.stdin;
  const cols = out.columns || 120, rows = out.rows || 30;

  // the session as the pill and axo see it
  const record = {
    id, vendor: 'claude', kind: 'terminal', label: path.basename(cwd), cwd,
    state: 'idle', alive: true, last: '', prompt: '', summary: '', did: '', pending: [], pending_ids: [],
    since: Date.now(),
  };
  const session = new EventEmitter();
  const set = (patch) => {
    const was = record.state;
    Object.assign(record, patch);
    if (patch.state && patch.state !== was) record.since = Date.now();
    session.emit('update');
    // done, asking, or failed: each raises its hand once
    if ((record.state === 'waiting' || record.state === 'error') && was !== record.state) session.emit('waiting', { ...record });
  };

  const draft = drafts();
  const interrupted = () => {
    // Esc or Ctrl+C stops a turn, or declines a permission prompt, and no hook says so
    if (record.state === 'running' || record.waiting_kind === 'approval_request') {
      set({ state: 'idle', waiting_kind: null, pending: [] });
    }
  };
  const typed = (s) => {
    if (s === '\x1b' || s === '\x03') interrupted();
    draft.typed(s);
  };
  const machine = stateMachine(set, () => record.state);
  const onHook = (e) => {
    if (e.hook_event_name === 'UserPromptSubmit') draft.clear();   // whatever was in the prompt has gone in
    machine(e);
  };

  // Claude's hooks for this session report here: this PC only, behind a
  // secret path, POST only, and never from a browser (browsers send Origin)
  const secret = randomBytes(16).toString('hex');
  const hooks = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== `/${secret}` || req.headers.origin) return res.writeHead(404).end();
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200).end();   // an empty answer: no decisions, Claude carries on as normal
      let e;
      try { e = JSON.parse(body); } catch { return; }
      if (e !== null && typeof e === 'object') onHook(e);
    });
  });
  hooks.listen(0, '127.0.0.1');
  await once(hooks, 'listening');
  // the hooks go in a settings file for this one session (`claude --settings`):
  // your own Claude settings are never touched
  const hook = [{ hooks: [{ type: 'http', url: `http://127.0.0.1:${hooks.address().port}/${secret}`, timeout: 5 }] }];
  const settings = path.join(os.tmpdir(), `axo-${id}.json`);
  fs.writeFileSync(settings, JSON.stringify({
    // no SessionStart: Claude doesn't send that one over HTTP ("not supported")
    hooks: { UserPromptSubmit: hook, PostToolUse: hook, PermissionRequest: hook, Stop: hook, StopFailure: hook, Notification: hook },
  }), { mode: 0o600 });

  // AXO_DEBUG=1: Claude logs what it does with hooks to a file next to the settings
  const debug = process.env.AXO_DEBUG ? ['--debug', 'hooks', '--debug-file', settings.replace(/\.json$/, '-debug.log')] : [];
  const pty = require('node-pty').spawn(file, [...args, '--settings', settings, ...debug], {
    name: 'xterm-256color', cwd, env: process.env, cols, rows,
  });
  // an exact copy of what's on the screen, for "what's on its screen?"
  const { Terminal } = require('@xterm/headless');
  const screen = new Terminal({ cols, rows, allowProposedApi: true });
  const screenText = () => {
    const b = screen.buffer.active, lines = [];
    for (let i = 0; i < screen.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
    return lines.join('\n').replace(/\s+$/, '');
  };

  pty.onData((d) => { out.write(d); screen.write(d); });
  // While axo is typing, your keys wait, so none land between its words and its Enter
  let busy = false;
  const held = [];
  const yours = (s) => { typed(s); pty.write(s); };
  input.on('data', (d) => (busy ? held.push(d.toString()) : yours(d.toString())));
  /** Write each piece, `gap` ms apart, then hand the keyboard back. Resolves
   *  with how many pieces went in: all of them, or fewer if a permission
   *  prompt came up on the way -- the next piece (an Enter, a key) could
   *  answer it, so nothing more is written.
   *  ponytail: relies on Claude's PermissionRequest hook reaching us before
   *  the next piece is due. If Claude ever draws the prompt well before its
   *  hook arrives, read the screen copy before each piece instead. */
  const type = (pieces, gap) => new Promise((resolve) => {
    busy = true;
    let i = 0;
    const done = () => { busy = false; held.splice(0).forEach(yours); resolve(i); };
    (function next() {
      if (i === pieces.length || record.waiting_kind === 'approval_request') return done();
      try { pty.write(pieces[i++]); } catch { return done(); }   // Claude has gone
      setTimeout(next, gap);
    })();
  });
  /** why axo mustn't type into this terminal right now, if it mustn't */
  const blocked = () => (
    record.waiting_kind === 'approval_request' ? `${record.label} is showing a permission prompt; answer it in its terminal first`
      : busy ? `still typing into ${record.label}`
      : draft.left() > 0 ? `something is half-typed in ${record.label}'s terminal, so nothing was sent`
      : null);
  const promptCameUp = `${record.label} put up a permission prompt while I was typing`;
  if (input.isTTY) input.setRawMode(true);   // keystrokes go to Claude as-is, Ctrl+C included
  input.resume();
  if (out.isTTY) {
    out.on('resize', () => { pty.resize(out.columns, out.rows); screen.resize(out.columns, out.rows); });
  }

  Object.assign(session, {
    list: () => [record],
    // A refusal throws, and its message reaches axo or the pill as is.
    async send(_id, text) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('nothing to send');
      const no = blocked();
      if (no) throw new Error(no);
      // Lines stay lines: a line feed is Ctrl+J, which Claude Code takes as a
      // new line in the prompt rather than Enter. Then Enter a moment later:
      // text and Enter arriving together read as a paste, which isn't submitted.
      const lines = text.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
      set({ prompt: text });
      const n = await type([lines, '\r'], typeDelay);
      if (n === 2) return true;
      if (n === 0) throw new Error(`couldn't type into ${record.label}`);
      // the words are in its prompt but weren't sent: they count as half-typed now
      draft.add(lines.length);
      throw new Error(`${promptCameUp}, so I didn't press Enter; the message is sitting unsent in its prompt`);
    },
    /** keys for a menu or picker, one at a time so each reads as a keypress */
    async press(_id, keys) {
      if (!Array.isArray(keys) || !keys.length || keys.length > 20) throw new Error('press takes 1 to 20 keys');
      const bytes = keys.map((k) => {
        const b = keyBytes(k);
        if (b === null) throw new Error(`no key called "${k}"`);
        return b;
      });
      // your half-typed line counts (Enter would send it); axo's own keys don't
      const no = blocked();
      if (no) throw new Error(no);
      if (bytes.includes('\x1b')) interrupted();
      const n = await type(bytes, keyDelay);
      if (n === bytes.length) return true;
      throw new Error(`${promptCameUp}, so I stopped after ${n} of ${bytes.length} keys`);
    },
    // permission prompts are answered in the terminal itself, for now
    approve() { throw new Error(`${record.label}'s permission prompts are answered in its terminal`); },
    deny() { throw new Error(`${record.label}'s permission prompts are answered in its terminal`); },
    stop() { pty.kill(); return true; },
    query(op) { if (op === 'screen') return { text: screenText() }; },
  });
  // nothing may ever be printed from here: this terminal belongs to Claude
  const link = connect({ url: () => readHub().url, token: () => readHub().token, device: os.hostname(), sessions: session });

  return new Promise((resolve) => pty.onExit(({ exitCode }) => {
    link.close();
    hooks.close();
    fs.rmSync(settings, { force: true });   // now, before the process exits

    if (input.isTTY) input.setRawMode(false);
    input.pause();
    resolve(exitCode);
  }));
}

if (require.main === module) {
  const [vendor, ...args] = process.argv.slice(2);
  if (vendor !== 'claude') {
    console.error('usage: axo claude [arguments for claude]');
    process.exit(2);
  }
  // AXO_CLAUDE: a different claude executable, if it isn't the one on PATH
  const { file, pre } = process.env.AXO_CLAUDE ? { file: process.env.AXO_CLAUDE, pre: [] } : which('claude');
  // Our own session id, so this session's history can be found later; a
  // resumed session keeps the id it already has (its first hook event reports it).
  const id = randomUUID();
  const resuming = args.some((a) => /^(-r|--resume|-c|--continue)(=|$)/.test(a));
  launch({ file, args: [...pre, ...args, ...(resuming ? [] : ['--session-id', id])], id })
    // exit straight away: on Windows the pseudo-terminal would otherwise keep
    // this process alive after Claude has gone
    .then((code) => process.exit(code ?? 0));
}

module.exports = { launch, hubFile, stateMachine, drafts, keyBytes };
