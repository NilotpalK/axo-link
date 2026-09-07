'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('axo', {
  // Returns an unsubscribe so a remounting renderer can't stack listeners.
  onSessions: (cb) => {
    const h = (_e, list) => cb(list);
    ipcRenderer.on('sessions', h);
    return () => ipcRenderer.off('sessions', h);
  },
  list: () => ipcRenderer.invoke('list'),
  pick: () => ipcRenderer.invoke('pick'),
  send: (id, text) => ipcRenderer.invoke('send', id, text),
  approve: (id) => ipcRenderer.invoke('approve', id),
  deny: (id) => ipcRenderer.invoke('deny', id),
  hold: (id) => ipcRenderer.invoke('hold', id),
  stop: (id) => ipcRenderer.invoke('stop', id),
  openLink: (url) => ipcRenderer.invoke('open-link', url),
  resize: (mode) => ipcRenderer.send('resize', mode),

  // --- voice ---
  select: (id) => ipcRenderer.send('select', id),
  onMic: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('mic', h);
    return () => ipcRenderer.off('mic', h);
  },
  voice: (targetId, audio) => ipcRenderer.invoke('voice', targetId, audio),
  hasKey: () => ipcRenderer.invoke('has-key'),
  setKey: (key) => ipcRenderer.invoke('set-key', key),
});
