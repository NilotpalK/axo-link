'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('axo', {
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, list) => cb(list)),
  list: () => ipcRenderer.invoke('list'),
  pick: () => ipcRenderer.invoke('pick'),
  send: (id, text) => ipcRenderer.invoke('send', id, text),
  approve: (id) => ipcRenderer.invoke('approve', id),
  deny: (id) => ipcRenderer.invoke('deny', id),
  stop: (id) => ipcRenderer.invoke('stop', id),
  resize: (expanded) => ipcRenderer.send('resize', expanded),
});
