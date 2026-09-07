'use strict';
const path = require('node:path');
const { app, globalShortcut, Notification } = require('electron');
const { Sessions } = require('./src/helpers/agent');
const { createPillWindow } = require('./src/helpers/windowConfig');
const { registerIpc } = require('./src/helpers/ipc');
const { createSpeaker, line } = require('./src/helpers/speak');
const { registerVoice } = require('./src/helpers/voice');
const {
  enabled: hubEnabled,
  mapWhisperToPill,
  subscribeStream,
} = require('./src/helpers/layer-hub');

// Keep in sync with DEV_SERVER_PORT in vite.config.mjs.
const DEV_SERVER_URL = 'http://127.0.0.1:5273';

const sessions = new Sessions();
const speaker = createSpeaker();
let win;
let hubSub = null;

function createWindow() {
  win = createPillWindow();
  if (process.env.NODE_ENV === 'development') {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'renderer', 'index.html'));
  }
}

function wireLayerHub() {
  if (!hubEnabled()) return;
  hubSub = subscribeStream((ev) => {
    if (!ev || ev.type !== 'agent-whisper' || !ev.whisper) return;
    // Reuses the same waiting → notify + speak path as local CLI settles.
    sessions.upsertExternal(mapWhisperToPill(ev.whisper));
  });
}

app.setAppUserModelId('com.axolink.pill');   // Windows: notifications are silent without this
app.whenReady().then(() => {
  createWindow();
  registerIpc({ sessions, getWindow: () => win });
  registerVoice({ sessions, speaker, getWindow: () => win });
  wireLayerHub();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  hubSub?.stop();
});

sessions.on('update', (list) => win?.webContents.send('sessions', list));

// The whole point of the app: it comes to you, and it says what it did.
sessions.on('waiting', (s) => {
  const approval = s.waiting_kind === 'approval_request';
  const body = [
    approval && s.pending?.[0] && `wants: ${s.pending[0]}`,
    s.did && `did: ${s.did}`,
    s.summary,
  ].filter(Boolean).join(' — ');
  new Notification({
    title: approval ? `${s.label} needs approval` : `${s.label} is waiting on you`,
    body: body.slice(0, 220) || 'waiting on you',
  }).show();
  // The notification is the record you can scroll back to; this is the part
  // that reaches you when you are not looking at the screen.
  speaker.speak(line(s), s.id);
});
