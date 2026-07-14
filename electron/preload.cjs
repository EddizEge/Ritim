const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ritimDesktop', {
  platform: process.platform,
  updatePresence: (payload) => ipcRenderer.send('player:presence', payload),
  music: {
    setVisible: (visible) => ipcRenderer.invoke('music:set-visible', Boolean(visible)),
    command: (command) => ipcRenderer.send('music:command', command),
  },
  youtube: {
    status: () => ipcRenderer.invoke('youtube:status'),
    configure: (credentials) => ipcRenderer.invoke('youtube:configure', credentials),
    signIn: () => ipcRenderer.invoke('youtube:sign-in'),
    signOut: () => ipcRenderer.invoke('youtube:sign-out'),
    home: () => ipcRenderer.invoke('youtube:home'),
    playlist: (input) => ipcRenderer.invoke('youtube:playlist', input),
    search: (query) => ipcRenderer.invoke('youtube:search', query),
    openConsole: () => ipcRenderer.invoke('youtube:open-console'),
  },
})
