'use strict';
const { app, BrowserWindow, ipcMain, dialog, screen, clipboard, ClipboardItem, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Sessions } = require('./agent');
const { startHub, loadEnv } = require('./hub');
loadEnv();   // GEMINI_API_KEY and friends, from .env, before anything reads them
const { connect } = require('./link');
const { hotkeys, invalid, label, hook } = require('./keys');
const { dictation, secretary, toolRunner, update, speakable } = require('./voice');

// A fixed transparent window at the bottom centre. The pill draws inside it
// and every click outside the pill passes straight through to what's behind.
const SIZE = { width: 420, height: 460 };
// Wispr's chords: hold Ctrl+Win to dictate, add Alt to talk to axo instead
// mic/speaker: device ids, '' meaning the system default
const DEFAULTS = {
  dictate: ['Ctrl', 'Meta'], talk: ['Ctrl', 'Meta', 'Alt'], mode: 'desk', mic: '', speaker: '', clean: true,
};

const sessions = new Sessions();
let win, keys, roster = [], current = null, micLabel = 'the microphone';
const ui = (channel, value) => win?.webContents.send(channel, value);

const settingsFile = path.join(app.getPath('userData'), 'settings.json');
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* first run */ }
const view = () => ({
  mode: settings.mode, mic: settings.mic, speaker: settings.speaker, clean: settings.clean,
  dictate: label(settings.dictate), talk: label(settings.talk),
});
const save = () => { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); ui('settings', view()); };
const setMode = (mode) => {
  if (mode !== 'desk' && mode !== 'away') return false;
  settings.mode = mode;
  save();
  return true;
};

// No AXO_HUB means this machine hosts the hub. Other machines set AXO_HUB to
// ws://<this machine>:7777 and the same AXO_TOKEN. Without AXO_TOKEN the hub
// gets a random one per run, known only to this app, so no other program on
// the PC can connect to it.
const hubToken = process.env.AXO_TOKEN || require('node:crypto').randomBytes(24).toString('hex');
if (!process.env.AXO_HUB) {
  startHub({ host: process.env.AXO_HOST || '127.0.0.1', token: hubToken })
    .on('error', (e) => console.error('hub not started:', e.message));   // e.g. one is already running
}
const hubUrl = process.env.AXO_HUB || 'ws://127.0.0.1:7777';
// `axo claude` in your terminals finds the hub through this file. It sits in
// your user profile, so it's as private as the rest of your app data.
fs.mkdirSync(app.getPath('userData'), { recursive: true });
fs.writeFileSync(path.join(app.getPath('userData'), 'hub.json'),
  JSON.stringify({ url: hubUrl, token: hubToken }), { mode: 0o600 });
const link = connect({
  url: hubUrl,
  token: hubToken,
  device: process.env.AXO_DEVICE || os.hostname(),
  sessions,
  onMessage: (m) => {
    if (m.t === 'roster') { roster = m.agents; ui('sessions', roster); }
    // at the desk an agent finishing is a chime and an amber bar; away, axo says it
    else if (m.t === 'hand') settings.mode === 'away' ? talk.announce(update(m.agent)) : ui('chime', 'hand');
    else if (m.t === 'link') ui('link', m.up);
    else if (m.t === 'error') ui('voice', { state: 'error', msg: m.msg });
  },
});

// Reading something out in full, word for word: a part at a time through the
// hub's text-to-speech, the next part being voiced while this one plays.
// Any hotkey press stops it.
// ponytail: an away-mode update arriving mid-read plays between two parts.
let reading = null;
function readAloud(text) {
  reading?.stop();
  const parts = speakable(text);
  const run = { stopped: false, stop() { this.stopped = true; } };
  reading = run;
  const voiced = (t) => {
    // generous: the hub may be waiting out the free tier's 3-a-minute limit
    const p = link.ask({ t: 'speak', text: t }, 90000).then((r) => r.audio);
    p.catch(() => {});   // a part abandoned by a stop isn't an error
    return p;
  };
  (async () => {
    let next = voiced(parts[0]);
    for (let i = 0; i < parts.length && !run.stopped; i++) {
      const now = next;
      next = parts[i + 1] ? voiced(parts[i + 1]) : null;
      let audio;
      try { audio = await now; } catch (e) {
        if (!run.stopped) ui('voice', { state: 'error', msg: `Couldn't read it out: ${e.message}` });
        break;
      }
      if (run.stopped) break;
      ui('caption', parts[i] + ' ');
      ui('play', audio);   // the pill queues it after whatever is playing
    }
    if (reading === run) reading = null;
  })();
  return { ok: true, reading: `${parts.length} parts, starting now` };
}

const talk = secretary({
  link,
  roster: () => roster,
  run: toolRunner({ link, roster: () => roster, setMode, readAloud }),
  busy: () => !!current,   // never talk over your dictation either
  ui: {
    audio: (b64) => ui('play', b64),
    flush: () => ui('flush'),
    caption: (text) => ui('caption', text),
    error: (e) => ui('voice', { state: 'error', msg: e.message }),
  },
});

// Below this peak (about 3% of full scale) a recording is room noise, not
// speech. Sending it anyway gets an invented answer back, in any language.
const SILENT = 1000;

const hk = hotkeys({ dictate: settings.dictate, talk: settings.talk }, {
  onBegin(mode) {
    if (reading) { reading.stop(); reading = null; ui('flush'); }   // you pressed a key: stop reading
    current = Object.assign(mode === 'dictate' ? dictation(link) : talk.listen(), { peak: 0, bytes: 0 });
    ui('voice', { mode, state: 'listening' });
  },
  onLock: (mode) => ui('voice', { mode, state: 'locked' }),
  async onEnd(mode, { cancel, stale }) {
    const c = current;
    current = null;
    const silent = c.peak < SILENT;
    console.log(`[voice] ${mode}: ${(c.bytes / 32000).toFixed(1)}s of audio, peak ${Math.round((c.peak / 32767) * 100)}%`
      + (cancel ? ', cancelled' : silent ? ', silent so not sent' : ''));
    if (!cancel && silent) {
      c.end(true);
      // all zeros is a dead or virtual device, not a quiet room
      const msg = c.peak === 0 ? `Silence from ${micLabel}. Change mic in Settings.`
        : "Didn't hear anything. Check the microphone in Settings.";
      ui('voice', { mode, state: 'error', msg });
      return talk.drain();
    }
    ui('voice', { mode, state: !cancel && mode === 'dictate' ? 'thinking' : 'idle' });
    try {
      const text = await c.end(cancel);
      if (text) await paste(await tidy(text));
      // a newer recording owns the pill now; this one only finishes its paste
      if (mode === 'dictate' && !stale()) ui('voice', { mode, state: 'idle' });
    } catch (e) {
      if (!stale()) ui('voice', { mode, state: 'error', msg: e.message });
    }
    talk.drain();   // anything held back while you were talking
  },
});

/** Wispr-style tidy-up on the hub. Slow, failed or odd-looking -> your exact words. */
async function tidy(raw) {
  if (!settings.clean) return raw;
  try {
    const r = await link.ask({ t: 'clean', text: raw }, 3000);   // ~1 s warm; the first after a start sets up a connection
    if (r.kept) console.log(`[voice] pasted your exact words: ${r.kept}`);
    return r.text;
  } catch (e) {
    console.log(`[voice] pasted your exact words: ${e.message}`);
    return raw;
  }
}

/** type the dictation into whatever app has focus, then put the clipboard back */
async function paste(text) {
  // Copy out every format now: items from read() may fetch lazily, and the
  // clipboard is about to hold the dictation instead.
  const saved = [];
  for (const item of await clipboard.read().catch(() => [])) {
    const data = {};
    for (const type of item.types) data[type] = await item.getType(type).catch(() => undefined);
    for (const type of Object.keys(data)) if (data[type] === undefined) delete data[type];
    if (Object.keys(data).length) saved.push(new ClipboardItem(data));
  }
  await clipboard.writeText(text);
  keys.paste();
  // give the target app time to read the paste before putting yours back;
  // an empty clipboard keeps the dictation, which is handy anyway
  if (saved.length) setTimeout(() => clipboard.write(saved).catch(() => {}), 500);
}

function createWindow() {
  const { workArea: wa } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...SIZE,
    x: Math.round(wa.x + (wa.width - SIZE.width) / 2),
    y: wa.y + wa.height - SIZE.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    hasShadow: false,
    focusable: false,       // never steals focus: dictation types into *your* app
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'screen-saver');   // above fullscreen apps too
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('pill.html');
  win.once('ready-to-show', () => win.showInactive());
}

app.setAppUserModelId('com.axolink.pill');
app.whenReady().then(async () => {
  createWindow();
  try { keys = hook(hk); } catch (e) { console.error('hotkeys unavailable:', e.message); }
  // macOS hands an app pure silence until the user says yes, and only asks
  // when asked to. A no is sticky, so say where to change it.
  if (process.platform === 'darwin') {
    const ok = await systemPreferences.askForMediaAccess('microphone');
    console.log(`[mic] macOS access: ${systemPreferences.getMediaAccessStatus('microphone')}`);
    if (!ok) {
      const tell = () => ui('voice', { state: 'error', msg: 'Mic blocked: System Settings > Privacy & Security > Microphone' });
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', tell); else tell();
    }
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { sessions.stopAll(); keys?.stop(); });

// 16 kHz 16-bit mono from the pill: note how loud it got, then pass it on
ipcMain.on('audio', (_e, bytes) => {
  if (!current) return;
  const b = Buffer.from(bytes);
  for (let i = 0; i + 1 < b.length; i += 2) current.peak = Math.max(current.peak, Math.abs(b.readInt16LE(i)));
  current.bytes += b.length;
  current.audio(b.toString('base64'));
});
ipcMain.on('miclabel', (_e, label) => {
  if (typeof label !== 'string' || label === micLabel) return;
  micLabel = label.slice(0, 120);
  console.log(`[mic] using ${micLabel}`);
});
// the pill tells us when the mouse is over it, so clicks land there and nowhere else
ipcMain.on('hit', (_e, over) => win.setIgnoreMouseEvents(!over, { forward: true }));
// typing a reply or picking from a list needs focus; everything else works without it
ipcMain.on('focus', (_e, on) => { win.setFocusable(on); if (on) win.focus(); });

// every agent action goes through the hub, so the pill drives any machine's agents
ipcMain.handle('list', () => roster);
for (const op of ['send', 'deny', 'stop']) {
  ipcMain.handle(op, (_e, id, text) => link.do(op, id, text));
}
// an approval names the request ids the pill showed you
ipcMain.handle('approve', (_e, id, asks) => link.do('approve', id, undefined, asks));
// starting one is local: the folder picker is on this machine
ipcMain.handle('pick', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const cwd = r.filePaths[0];
  return sessions.start({ vendor: 'claude', cwd, label: path.basename(cwd) });
});

ipcMain.handle('settings', () => view());
ipcMain.handle('mode', (_e, mode) => setMode(mode));
ipcMain.handle('clean', (_e, on) => {
  settings.clean = on === true;
  save();
  return true;
});
ipcMain.handle('device', (_e, kind, id) => {
  if ((kind !== 'mic' && kind !== 'speaker') || typeof id !== 'string' || id.length > 512) return false;
  settings[kind] = id;
  save();
  return true;
});
ipcMain.handle('record', (_e, mode) => new Promise((resolve) => {
  if (!keys) return resolve({ error: 'Global hotkeys are unavailable on this machine.', ...view() });
  if (mode !== 'dictate' && mode !== 'talk') return resolve({ error: 'Unknown hotkey.', ...view() });
  hk.record((combo) => {
    const error = invalid(combo, [settings[mode === 'dictate' ? 'talk' : 'dictate']]);
    if (!error) {
      settings[mode] = combo;
      hk.set({ dictate: settings.dictate, talk: settings.talk });
      save();
    }
    resolve({ error, ...view() });
  });
}));
