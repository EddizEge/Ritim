const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ritimShell', {
  openSettings: () => ipcRenderer.send('settings:open'),
  setView: (view) => ipcRenderer.invoke('shell:set-view', view),
  getAppearance: () => ipcRenderer.invoke('shell:get-appearance'),
  getSocialSummary: () => ipcRenderer.invoke('shell:get-social-summary'),
  onSocialSummary: (callback) => {
    const listener = (_event, summary) => callback(summary)
    ipcRenderer.on('shell:social-summary', listener)
    return () => ipcRenderer.removeListener('shell:social-summary', listener)
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
