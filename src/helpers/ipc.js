'use strict';
// Every ipcMain handler. The renderer half is preload.js; keep the two in sync.
const path = require('node:path');
const { ipcMain, dialog } = require('electron');
const { resizePill } = require('./windowConfig');

function registerIpc({ sessions, getWindow }) {
  ipcMain.handle('list', () => sessions.list());
  ipcMain.handle('send', (_e, id, text) => sessions.send(id, text));
  ipcMain.handle('approve', (_e, id) => sessions.approve(id));
  ipcMain.handle('deny', (_e, id) => sessions.deny(id));
  ipcMain.handle('stop', (_e, id) => sessions.stop(id));

  ipcMain.handle('pick', async () => {
    const r = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const cwd = r.filePaths[0];
    return sessions.start({ vendor: 'claude', cwd, label: path.basename(cwd) });
  });

  ipcMain.on('resize', (_e, expanded) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) resizePill(win, expanded);
  });
}

module.exports = { registerIpc };
