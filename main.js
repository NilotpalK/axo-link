'use strict';
const { app, BrowserWindow, ipcMain, dialog, screen, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Sessions } = require('./agent');
const { startHub } = require('./hub');
const { connect } = require('./link');
const { hotkeys, invalid, label, hook } = require('./keys');
const { dictation, secretary, toolRunner, update } = require('./voice');

// A fixed transparent window at the bottom centre. The pill draws inside it
// and every click outside the pill passes straight through to what's behind.
const SIZE = { width: 420, height: 460 };
// Wispr's chords: hold Ctrl+Win to dictate, add Alt to talk to axo instead
// mic/speaker: device ids, '' meaning the system default
const DEFAULTS = { dictate: ['Ctrl', 'Meta'], talk: ['Ctrl', 'Meta', 'Alt'], mode: 'desk', mic: '', speaker: '' };

const sessions = new Sessions();
let win, keys, roster = [], current = null;
const ui = (channel, value) => win?.webContents.send(channel, value);

const settingsFile = path.join(app.getPath('userData'), 'settings.json');
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* first run */ }
const view = () => ({
  mode: settings.mode, mic: settings.mic, speaker: settings.speaker,
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
// ws://<this machine>:7777 and the same AXO_TOKEN.
if (!process.env.AXO_HUB) {
  startHub({ host: process.env.AXO_HOST || '127.0.0.1' })
    .on('error', (e) => console.error('hub not started:', e.message));   // e.g. one is already running
}
const link = connect({
  url: process.env.AXO_HUB || 'ws://127.0.0.1:7777',
  token: process.env.AXO_TOKEN,
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

const talk = secretary({
  link,
  roster: () => roster,
  run: toolRunner({ link, roster: () => roster, setMode }),
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
    current = Object.assign(mode === 'dictate' ? dictation(link) : talk.listen(), { peak: 0, bytes: 0 });
    ui('voice', { mode, state: 'listening' });
  },
  onLock: (mode) => ui('voice', { mode, state: 'locked' }),
  async onEnd(mode, { cancel }) {
    const c = current;
    current = null;
    const silent = c.peak < SILENT;
    console.log(`[voice] ${mode}: ${(c.bytes / 32000).toFixed(1)}s of audio, peak ${Math.round((c.peak / 32767) * 100)}%`
      + (cancel ? ', cancelled' : silent ? ', silent so not sent' : ''));
    if (!cancel && silent) {
      c.end(true);
      ui('voice', { mode, state: 'error', msg: "Didn't hear anything. Check the microphone in Settings." });
      return talk.drain();
    }
    ui('voice', { mode, state: !cancel && mode === 'dictate' ? 'thinking' : 'idle' });
    try {
      const text = await c.end(cancel);
      if (text) paste(text);
      if (mode === 'dictate') ui('voice', { mode, state: 'idle' });
    } catch (e) {
      ui('voice', { mode, state: 'error', msg: e.message });
    }
    talk.drain();   // anything held back while you were talking
  },
});

/** type the dictation into whatever app has focus, then put the clipboard back */
function paste(text) {
  const prev = { text: clipboard.readText(), image: clipboard.readImage() };
  clipboard.writeText(text);
  keys.paste();
  // ponytail: restores plain text or an image; files and rich formats on the
  // clipboard are lost. Save every format if that ever bites.
  setTimeout(() => (prev.image.isEmpty() ? clipboard.writeText(prev.text) : clipboard.writeImage(prev.image)), 500);
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
app.whenReady().then(() => {
  createWindow();
  try { keys = hook(hk); } catch (e) { console.error('hotkeys unavailable:', e.message); }
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
// the pill tells us when the mouse is over it, so clicks land there and nowhere else
ipcMain.on('hit', (_e, over) => win.setIgnoreMouseEvents(!over, { forward: true }));
// typing a reply or picking from a list needs focus; everything else works without it
ipcMain.on('focus', (_e, on) => { win.setFocusable(on); if (on) win.focus(); });

// every agent action goes through the hub, so the pill drives any machine's agents
ipcMain.handle('list', () => roster);
for (const op of ['send', 'approve', 'deny', 'stop']) {
  ipcMain.handle(op, (_e, id, text) => link.do(op, id, text));
}
// starting one is local: the folder picker is on this machine
ipcMain.handle('pick', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const cwd = r.filePaths[0];
  return sessions.start({ vendor: 'claude', cwd, label: path.basename(cwd) });
});

ipcMain.handle('settings', () => view());
ipcMain.handle('mode', (_e, mode) => setMode(mode));
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
