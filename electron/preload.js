// Minimal preload — the app uses Express SSE so no special Electron APIs are needed in the renderer.
// This file exists as a placeholder for future IPC needs.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
});
