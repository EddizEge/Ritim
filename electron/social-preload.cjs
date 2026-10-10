const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// The Social view never sees the social socket or any token: it reads state
// and asks the main process to perform validated, acknowledged actions.
contextBridge.exposeInMainWorld('ritimSocial', {
  getState: () => ipcRenderer.invoke('social:get-state'),
  action: (type, payload) => ipcRenderer.invoke('social:action', { type, payload }),
  getAppearance: () => ipcRenderer.invoke('social:get-appearance'),
  onState: (callback) => subscribe('social:state', callback),
  onEvent: (callback) => subscribe('social:event', callback),
  onVisibility: (callback) => subscribe('social:visibility', callback),
  onAppearance: (callback) => subscribe('social:appearance', callback),
})
