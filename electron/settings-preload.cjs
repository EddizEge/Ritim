const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ritimSettings', {
  getData: () => ipcRenderer.invoke('settings:get-data'),
  revealPairing: () => ipcRenderer.invoke('settings:reveal-pairing'),
  copyUrl: (revealSessionId) => ipcRenderer.invoke('settings:copy-url', revealSessionId),
  hidePairing: () => ipcRenderer.invoke('settings:hide-pairing'),
  rotatePairing: () => ipcRenderer.invoke('settings:rotate-pairing'),
  restart: () => ipcRenderer.send('settings:restart'),
  checkUpdates: () => ipcRenderer.invoke('settings:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('settings:download-update'),
  installUpdate: () => ipcRenderer.invoke('settings:install-update'),
  setDeviceNotifications: (enabled) => ipcRenderer.invoke('settings:set-device-notifications', enabled),
  setAppearance: (preferences) => ipcRenderer.invoke('settings:set-appearance', preferences),
  getSocialAccount: () => ipcRenderer.invoke('settings:get-social-account'),
  revokeSocialDevice: (deviceId) => ipcRenderer.invoke('settings:revoke-social-device', deviceId),
  signOutSocial: () => ipcRenderer.invoke('settings:social-sign-out'),
  signInSocial: () => ipcRenderer.invoke('settings:social-sign-in'),
  sendSocialAction: (type, payload) => ipcRenderer.send('settings:social-action', { type, payload }),
  onSocialState: (listener) => {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('settings:social-state', handler)
    return () => ipcRenderer.removeListener('settings:social-state', handler)
  },
  onUpdateStatus: (listener) => {
    const handler = (_event, status) => listener(status)
    ipcRenderer.on('settings:update-status', handler)
    return () => ipcRenderer.removeListener('settings:update-status', handler)
  },
  onAppearance: (listener) => {
    const handler = (_event, preferences) => listener(preferences)
    ipcRenderer.on('settings:appearance', handler)
    return () => ipcRenderer.removeListener('settings:appearance', handler)
  },
  // The Social view's "Sosyal ayarları" shortcuts open a given section.
  onOpenSection: (listener) => {
    const handler = (_event, section) => listener(section)
    ipcRenderer.on('settings:open-section', handler)
    return () => ipcRenderer.removeListener('settings:open-section', handler)
  },
})
