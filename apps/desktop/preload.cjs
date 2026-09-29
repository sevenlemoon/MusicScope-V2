const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('startup', {
  current: () => ipcRenderer.invoke('startup-status'),
  onStatus: (callback) => ipcRenderer.on('startup-status', (_event, status) => callback(status)),
  openLogs: () => ipcRenderer.invoke('open-logs'),
});
