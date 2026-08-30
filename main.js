'use strict';
const { app, BrowserWindow, ipcMain, Notification, dialog, screen } = require('electron');
const path = require('node:path');
const { Sessions } = require('./agent');

const COLLAPSED = { width: 232, height: 46 };
const EXPANDED = { width: 420, height: 500 };

const sessions = new Sessions();
let win;

function createWindow() {
  win = new BrowserWindow({
    ...COLLAPSED,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,      // no taskbar entry, per the handoff doc
    resizable: false,
    maximizable: false,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'screen-saver');   // above fullscreen apps too
  win.loadFile('pill.html');

  const { workArea } = screen.getPrimaryDisplay();
  win.setPosition(workArea.x + workArea.width - COLLAPSED.width - 24, workArea.y + 24);
}

app.setAppUserModelId('com.axolink.pill');   // Windows: notifications are silent without this
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

sessions.on('update', (list) => win?.webContents.send('sessions', list));

// The whole point of the app: it comes to you, and it says what it did.
sessions.on('waiting', (s) => {
  const approval = s.waiting_kind === 'approval_request';
  const body = [
    approval && s.pending?.[0] && `wants: ${s.pending[0]}`,
    s.did && `did: ${s.did}`,
    s.summary,
  ].filter(Boolean).join(' \u2014 ');
  new Notification({
    title: approval ? `${s.label} needs approval` : `${s.label} is waiting on you`,
    body: body.slice(0, 220) || 'waiting on you',
  }).show();
});

ipcMain.handle('list', () => sessions.list());
ipcMain.handle('send', (_e, id, text) => sessions.send(id, text));
ipcMain.handle('approve', (_e, id) => sessions.approve(id));
ipcMain.handle('deny', (_e, id) => sessions.deny(id));
ipcMain.handle('stop', (_e, id) => sessions.stop(id));
ipcMain.handle('pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const cwd = r.filePaths[0];
  return sessions.start({ vendor: 'claude', cwd, label: path.basename(cwd) });
});
ipcMain.on('resize', (_e, expanded) => {
  const b = win.getBounds();
  const s = expanded ? EXPANDED : COLLAPSED;
  // grow down-and-left so the pill's top-right corner never moves
  win.setBounds({ x: b.x + b.width - s.width, y: b.y, ...s });
});
