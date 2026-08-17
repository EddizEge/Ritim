const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ritimSettings', {
  getData: () => ipcRenderer.invoke('settings:get-data'),
  copyUrl: () => ipcRenderer.invoke('settings:copy-url'),
  restart: () => ipcRenderer.send('settings:restart'),
  checkUpdates: () => ipcRenderer.invoke('settings:check-updates'),
  installUpdate: () => ipcRenderer.invoke('settings:install-update'),
  getSocialAccount: () => ipcRenderer.invoke('settings:get-social-account'),
  revokeSocialDevice: (deviceId) => ipcRenderer.invoke('settings:revoke-social-device', deviceId),
  signOutSocial: () => ipcRenderer.invoke('settings:social-sign-out'),
  signInSocial: () => ipcRenderer.invoke('settings:social-sign-in'),
  onUpdateStatus: (listener) => {
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('settings:update-status', handler)
    return () => ipcRenderer.removeListener('settings:update-status', handler)
  },
})
