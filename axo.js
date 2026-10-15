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
const { connect } = require('./link');
const { brief, tally, argText, kindOf } = require('./agent');

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

/** Claude's hooks call this; each event moves the session's state on */
function stateMachine(set) {
  let tools = [], known = null;
  return (e) => {
    // Claude's own id for the session, for reading its history: every event
    // carries it (SessionStart would be first, but Claude sends it no HTTP hooks)
    if (typeof e.session_id === 'string' && e.session_id !== known) set({ claude_session: (known = e.session_id) });
    switch (e.hook_event_name) {
      case 'UserPromptSubmit':
        tools = [];
        return set({ state: 'running', prompt: e.prompt, waiting_kind: null, pending: [], did: '', summary: '' });
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
      case 'Notification':
        // Claude saying it's sat waiting for input, without a turn having ended
        if (e.notification_type === 'idle_prompt') return set({ state: 'waiting', waiting_kind: kindOf(e.message || '') });
    }
  };
}

/** Run `file args` in a pseudo-terminal wired to this terminal, and register
 *  it with the hub. Resolves with the exit code when the program ends. */
async function launch({ file, args, id, cwd = process.cwd(), typeDelay = 150 }) {
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
    if (record.state === 'waiting' && was !== 'waiting') session.emit('waiting', { ...record });
  };
  const onHook = stateMachine(set);

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
    hooks: { UserPromptSubmit: hook, PostToolUse: hook, PermissionRequest: hook, Stop: hook, Notification: hook },
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
  input.on('data', (d) => pty.write(d.toString()));
  if (input.isTTY) input.setRawMode(true);   // keystrokes go to Claude as-is, Ctrl+C included
  input.resume();
  if (out.isTTY) {
    out.on('resize', () => { pty.resize(out.columns, out.rows); screen.resize(out.columns, out.rows); });
  }

  Object.assign(session, {
    list: () => [record],
    send(_id, text) {
      if (typeof text !== 'string' || !text.trim()) return false;
      // One line, then Enter a moment later: text and Enter arriving together
      // read as a paste, and the paste isn't submitted.
      // ponytail: lands even if you're typing in this terminal right then.
      pty.write(text.replace(/\s+/g, ' ').trim());
      setTimeout(() => pty.write('\r'), typeDelay);
      set({ prompt: text });
      return true;
    },
    // permission prompts are answered in the terminal itself, for now
    approve: () => false,
    deny: () => false,
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

module.exports = { launch, hubFile, stateMachine };
