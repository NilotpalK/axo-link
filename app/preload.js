'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// the only channels main pushes to the pill
const EVENTS = new Set(['sessions', 'link', 'voice', 'play', 'flush', 'caption', 'chime', 'settings', 'hand']);

contextBridge.exposeInMainWorld('axo', {
  on: (channel, cb) => EVENTS.has(channel) && ipcRenderer.on(channel, (_e, v) => cb(v)),
  list: () => ipcRenderer.invoke('list'),
  pick: () => ipcRenderer.invoke('pick'),
  send: (id, text) => ipcRenderer.invoke('send', id, text),
  approve: (id, asks) => ipcRenderer.invoke('approve', id, asks),
  deny: (id) => ipcRenderer.invoke('deny', id),
  stop: (id) => ipcRenderer.invoke('stop', id),
  read: (id) => ipcRenderer.invoke('read', id),
  endVoice: (cancel) => ipcRenderer.send('voice-end', cancel),
  settings: () => ipcRenderer.invoke('settings'),
  record: (mode) => ipcRenderer.invoke('record', mode),
  setMode: (mode) => ipcRenderer.invoke('mode', mode),
  setDevice: (kind, id) => ipcRenderer.invoke('device', kind, id),
  setClean: (on) => ipcRenderer.invoke('clean', on),
  audio: (bytes) => ipcRenderer.send('audio', bytes),
  micLabel: (label) => ipcRenderer.send('miclabel', label),
  hit: (over) => ipcRenderer.send('hit', over),
  focus: (on) => ipcRenderer.send('focus', on),
});
