const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ritimShell', {
  openSettings: () => ipcRenderer.send('settings:open'),
})
