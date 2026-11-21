const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const diskBackend = require('./diskBackend.cjs');

let mainWindow = null;

function isTrustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return event.sender === mainWindow.webContents;
}

function getRuntimeIconPath() {
  const distIcon = path.join(__dirname, '..', 'dist', 'icon.png');
  if (fs.existsSync(distIcon)) return distIcon;
  const publicIcon = path.join(__dirname, '..', 'public', 'icon.png');
  if (fs.existsSync(publicIcon)) return publicIcon;
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1120,
    minHeight: 700,
    title: 'F-Clonedisk',
    backgroundColor: '#0f141c',
    autoHideMenuBar: true,
    icon: getRuntimeIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedDev = process.env.ELECTRON_DEV === '1' && url.startsWith('http://localhost:5173');
    const allowedFile = url.startsWith('file://');
    if (!allowedDev && !allowedFile) {
      event.preventDefault();
    }
  });

  if (process.env.ELECTRON_DEV === '1') {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('disk:getSystemInfo', async (event) => {
  if (!isTrustedSender(event)) throw new Error('Origine IPC non autorisée.');
  return diskBackend.getSystemInfo();
});

ipcMain.handle('disk:listDisks', async (event) => {
  if (!isTrustedSender(event)) throw new Error('Origine IPC non autorisée.');
  return diskBackend.listWindowsDisks();
});

ipcMain.handle('disk:executeOperations', async (event, operations) => {
  if (!isTrustedSender(event)) throw new Error('Origine IPC non autorisée.');

  // Validate entire queue and build all real PowerShell commands BEFORE confirmation
  const prepared = diskBackend.prepareOperations(operations);
  const detail = diskBackend.formatConfirmationSummary(prepared);

  const confirm = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Annuler', 'Exécuter sur les disques Windows'],
    defaultId: 0,
    cancelId: 0,
    title: 'Confirmation F-Clonedisk — Modification matérielle',
    message: `Vous êtes sur le point d'exécuter ${prepared.length} commande(s) PowerShell réelle(s) :`,
    detail,
  });

  if (confirm.response !== 1) {
    return { cancelled: true, results: [] };
  }

  const results = await diskBackend.executeOperations(operations, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('disk:progress', progress);
    }
  });

  return { cancelled: false, results };
});

ipcMain.handle('disk:runSurfaceTest', async (event, payload) => {
  if (!isTrustedSender(event)) throw new Error('Origine IPC non autorisée.');
  const advancedTools = require('./advancedTools.cjs');
  return advancedTools.runDiskWorker('surface', payload || {}, (ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('disk:workerEvent', ev);
    }
  });
});

ipcMain.handle('disk:createWinPe', async (event, opts) => {
  if (!isTrustedSender(event)) throw new Error('Origine IPC non autorisée.');
  const advancedTools = require('./advancedTools.cjs');
  const adk = advancedTools.locateWindowsAdkWinPe();
  const plan = advancedTools.buildWinPeCommands(opts || {});
  if (!adk) {
    return {
      ok: false,
      adkInstalled: false,
      commands: plan.commands,
      error: 'Windows ADK (WinPE Add-on) introuvable. Installez Windows ADK depuis Microsoft Learn puis relancez.',
    };
  }
  return { ok: true, adkInstalled: true, adkBase: adk.adkBase, commands: plan.commands };
});

ipcMain.handle('disk:scanTestDisk', async (event, payload) => {
  if (!isTrustedSender(event)) throw new Error('Origine IPC non autorisée.');
  const advancedTools = require('./advancedTools.cjs');
  const bin = advancedTools.locateTestDisk(payload?.customPath);
  if (!bin) {
    return {
      ok: false,
      found: false,
      partitions: [],
      error: 'TestDisk introuvable (cherché dans 06_OUTILS_SYSTEME\\Testdisk\\testdisk_win.exe).',
    };
  }
  return { ok: true, found: true, binaryPath: bin, partitions: [] };
});

ipcMain.handle('disk:exportLog', async (event, logText) => {
  if (!isTrustedSender(event)) throw new Error('Origine IPC non autorisée.');
  if (typeof logText !== 'string' || logText.length > 5 * 1024 * 1024) {
    throw new Error('Contenu de journal invalide.');
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exporter le journal F-Clonedisk',
    defaultPath: `F-Clonedisk-log-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Fichiers texte', extensions: ['txt', 'log'] }],
  });
  if (!result.canceled && result.filePath) {
    try {
      await fs.promises.writeFile(result.filePath, logText, 'utf8');
      return { saved: true, path: result.filePath };
    } catch (err) {
      return { saved: false, error: err.message };
    }
  }
  return { saved: false };
});
