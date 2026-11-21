const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fClonedisk', {
  isElectron: true,
  platform: process.platform,
  getSystemInfo: () => ipcRenderer.invoke('disk:getSystemInfo'),
  listDisks: () => ipcRenderer.invoke('disk:listDisks'),
  executeOperations: (operations) => ipcRenderer.invoke('disk:executeOperations', operations),
  exportLog: (logText) => ipcRenderer.invoke('disk:exportLog', logText),
  onProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('disk:progress', handler);
    return () => ipcRenderer.removeListener('disk:progress', handler);
  },
});
