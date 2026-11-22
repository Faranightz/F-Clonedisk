const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fClonedisk', {
  isElectron: true,
  platform: process.platform,
  getSystemInfo: () => ipcRenderer.invoke('disk:getSystemInfo'),
  listDisks: () => ipcRenderer.invoke('disk:listDisks'),
  executeOperations: (operations) => ipcRenderer.invoke('disk:executeOperations', operations),
  runSurfaceTest: (diskNumber, segments, mode) => ipcRenderer.invoke('disk:runSurfaceTest', { diskNumber, segments, mode }),
  createWinPe: (opts) => ipcRenderer.invoke('disk:createWinPe', opts),
  scanTestDisk: (diskNumber, customPath) => ipcRenderer.invoke('disk:scanTestDisk', { diskNumber, customPath }),
  exportLog: (logText) => ipcRenderer.invoke('disk:exportLog', logText),
  onProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('disk:progress', handler);
    return () => ipcRenderer.removeListener('disk:progress', handler);
  },
  onWorkerEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('disk:workerEvent', handler);
    return () => ipcRenderer.removeListener('disk:workerEvent', handler);
  },
});
