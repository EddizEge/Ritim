const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ritimShell', {
  openSettings: () => ipcRenderer.send('settings:open'),
  setView: (view) => ipcRenderer.invoke('shell:set-view', view),
  getAppearance: () => ipcRenderer.invoke('shell:get-appearance'),
  getSocialState: () => ipcRenderer.invoke('shell:get-social-state'),
  sendSocialAction: (type, payload) => ipcRenderer.send('shell:social-action', { type, payload }),
  onSocialState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('shell:social-state', listener)
    return () => ipcRenderer.removeListener('shell:social-state', listener)
  },
  onViewChanged: (callback) => {
    const listener = (_event, view) => callback(view)
    ipcRenderer.on('shell:view-changed', listener)
    return () => ipcRenderer.removeListener('shell:view-changed', listener)
  },
  onAppearance: (callback) => {
    const listener = (_event, preferences) => callback(preferences)
    ipcRenderer.on('shell:appearance', listener)
    return () => ipcRenderer.removeListener('shell:appearance', listener)
  },
})
