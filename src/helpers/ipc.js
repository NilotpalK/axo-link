'use strict';
// Every ipcMain handler. The renderer half is preload.js; keep the two in sync.
const path = require('node:path');
const { ipcMain, dialog } = require('electron');
const { resizePill } = require('./windowConfig');
const { postTurn } = require('./layer-hub');

async function forwardTurn(text) {
  try {
    return await postTurn(text);
  } catch (e) {
    console.warn('[layer-hub] postTurn failed:', e.message || e);
    return { ok: false, error: e.message };
  }
}

function registerIpc({ sessions, getWindow }) {
  ipcMain.handle('list', () => sessions.list());
  ipcMain.handle('send', async (_e, id, text) => {
    const local = sessions.send(id, text);
    const hub = await forwardTurn(text);
    if (local) return true;
    // Hub-sourced rows have no CLI stdin — the POST is the turn.
    if (sessions.isHub(id)) {
      const prev = sessions.list().find((s) => s.id === id);
      if (prev) {
        sessions.upsertExternal({
          ...prev,
          state: hub.ok ? 'idle' : 'waiting',
          waiting_kind: hub.ok ? null : prev.waiting_kind,
          last: text,
        });
      }
      return Boolean(hub.ok);
    }
    return false;
  });
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
