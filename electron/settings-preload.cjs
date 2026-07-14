const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ritimSettings', {
  getData: () => ipcRenderer.invoke('settings:get-data'),
  copyUrl: () => ipcRenderer.invoke('settings:copy-url'),
  restart: () => ipcRenderer.send('settings:restart'),
  checkUpdates: () => ipcRenderer.invoke('settings:check-updates'),
  installUpdate: () => ipcRenderer.invoke('settings:install-update'),
  onUpdateStatus: (listener) => {
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('settings:update-status', handler)
    return () => ipcRenderer.removeListener('settings:update-status', handler)
  },
})
