'use strict';
// Every ipcMain handler. The renderer half is preload.js; keep the two in sync.
const path = require('node:path');
const { ipcMain, dialog, shell } = require('electron');
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

function dismissHub(sessions, id, patch = {}) {
  const prev = sessions.list().find((s) => s.id === id);
  if (!prev) return false;
  sessions.upsertExternal({
    ...prev,
    state: 'idle',
    waiting_kind: null,
    ...patch,
  });
  return true;
}

function registerIpc({ sessions, getWindow }) {
  ipcMain.handle('list', () => sessions.list());
  ipcMain.handle('send', async (_e, id, text) => {
    const local = sessions.send(id, text);
    const hub = await forwardTurn(text);
    if (local) return true;
    // Hub-sourced rows have no CLI stdin — the POST is the turn.
    if (sessions.isHub(id)) {
      dismissHub(sessions, id, { last: text });
      return Boolean(hub.ok);
    }
    return false;
  });
  ipcMain.handle('approve', async (_e, id) => {
    if (sessions.approve(id)) return true;
    if (sessions.isHub(id)) {
      // Short turn when the hub is up; always dismiss locally.
      await forwardTurn('Approved.');
      return dismissHub(sessions, id, { last: 'Approved.' });
    }
    return false;
  });
  ipcMain.handle('deny', async (_e, id) => {
    if (sessions.deny(id)) return true;
    if (sessions.isHub(id)) {
      await forwardTurn('Denied.');
      return dismissHub(sessions, id, { last: 'Denied.' });
    }
    return false;
  });
  ipcMain.handle('hold', (_e, id) => {
    // Local dismiss only — no turn. Hub rows leave the waiting queue; CLI
    // rows get a soft hold flag so the focused card can skip them.
    if (sessions.isHub(id)) return dismissHub(sessions, id, { held: true });
    return sessions.hold(id);
  });
  ipcMain.handle('stop', (_e, id) => sessions.stop(id));
  ipcMain.handle('open-link', async (_e, url) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return false;
    try {
      await shell.openExternal(u);
      return true;
    } catch (e) {
      console.warn('[open-link]', e.message || e);
      return false;
    }
  });

  ipcMain.handle('pick', async () => {
    const r = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const cwd = r.filePaths[0];
    return sessions.start({ vendor: 'claude', cwd, label: path.basename(cwd) });
  });

  ipcMain.on('resize', (_e, mode) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) resizePill(win, mode);
  });
}

module.exports = { registerIpc };
