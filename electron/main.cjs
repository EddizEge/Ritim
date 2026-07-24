const { app, BrowserWindow, WebContentsView, clipboard, ipcMain, safeStorage, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const QRCode = require('qrcode')
const { io } = require('socket.io-client')
const { createDiscordPresence } = require('./discord-presence.cjs')
const { createSocialAuthClient } = require('./social-auth-client.cjs')
const { createYouTubeMusicBridge } = require('./ytmusic-bridge.cjs')
const { createUpdateController } = require('./updater.cjs')

const APP_BAR_HEIGHT = 52
const ROOM = process.env.RITIM_ROOM || 'EDIZ-4821'
const DISCORD_CLIENT_ID = process.env.RITIM_DISCORD_CLIENT_ID || '1528122277500030976'
const SOCIAL_URL = process.env.RITIM_SOCIAL_URL || 'http://127.0.0.1:8790'
let pairingToken = process.env.RITIM_PAIRING_TOKEN || ''
let mainWindow
let musicView
let settingsWindow
let syncServer
let presence
let musicBridge
let socialSocket
let socialAuth
let socialAuthStatus = { configured: false, required: false, authenticated: false }
let socialStartSequence = 0
let latestSocialState
let socialConnectionStatus = 'connecting'
let latestPlayerState
let updateController
let isShuttingDown = false
let activeShellView = 'music'

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (isShuttingDown) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function stopRuntime() {
  socialStartSequence += 1
  socialSocket?.disconnect()
  socialSocket = null
  musicBridge?.destroy()
  musicBridge = null
  presence?.destroy()
  presence = null
  if (syncServer) {
    syncServer.close()
    syncServer = null
  }
}

async function prepareForUpdate() {
  isShuttingDown = true
  stopRuntime()

  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()

  app.releaseSingleInstanceLock()
  // Let Chromium child processes and the local phone server finish exiting before
  // electron-updater starts NSIS and asks the Electron main process to quit.
  await new Promise((resolve) => setTimeout(resolve, 250))
}

function isMusicAuthUrl(value) {
  try {
    const host = new URL(value).hostname
    return host === 'music.youtube.com' || host === 'accounts.google.com' || host.endsWith('.google.com')
  } catch {
    return false
  }
}

function findLanAddress() {
  const candidates = []
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (/vmware|vethernet|virtual|tailscale|loopback/i.test(name)) continue
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal || address.address.startsWith('169.254.')) continue
      candidates.push({ name, address: address.address })
    }
  }
  const preferred = candidates.find(({ name }) => /wi-?fi|wlan|ethernet/i.test(name))
  return preferred?.address || candidates[0]?.address || '127.0.0.1'
}

function getPairingToken() {
  if (pairingToken) return pairingToken

  const tokenPath = path.join(app.getPath('userData'), 'pairing-token')
  try {
    const savedToken = fs.readFileSync(tokenPath, 'utf8').trim()
    if (/^[A-Za-z0-9_-]{32,128}$/.test(savedToken)) pairingToken = savedToken
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[Ritim] Kayitli telefon anahtari okunamadi:', error)
  }

  if (!pairingToken) {
    pairingToken = crypto.randomBytes(24).toString('base64url')
    try {
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
      fs.writeFileSync(tokenPath, `${pairingToken}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      console.warn('[Ritim] Telefon anahtari kalici olarak kaydedilemedi:', error)
    }
  }

  return pairingToken
}

function phoneUrl() {
  return `http://${findLanAddress()}:8787/?companion=1&room=${encodeURIComponent(ROOM)}&token=${encodeURIComponent(getPairingToken())}`
}

function resizeMusicView() {
  if (!mainWindow || !musicView || mainWindow.isDestroyed()) return
  const [width, height] = mainWindow.getContentSize()
  musicView.setBounds({ x: 0, y: APP_BAR_HEIGHT, width, height: Math.max(0, height - APP_BAR_HEIGHT) })
}

function setShellView(nextView) {
  activeShellView = nextView === 'social' ? 'social' : 'music'
  if (musicView) {
    musicView.setVisible(activeShellView === 'music')
    if (activeShellView === 'music') resizeMusicView()
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shell:view-changed', activeShellView)
  }
  return activeShellView
}

function stableSocialAccountId(seed) {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `ritim-${(hash >>> 0).toString(36)}`
}

function desktopSocialIdentity() {
  // The pairing token is the account identity shared by this PC and its phone.
  // Using the room in development made the companion appear as another person.
  const accountId = stableSocialAccountId(getPairingToken())
  return {
    accountId,
    deviceId: `desktop-${accountId}`,
  }
}

function desktopSocialProfile() {
  const track = latestPlayerState?.catalog?.[latestPlayerState?.trackId]
  const accountProfile = latestPlayerState?.accountProfile
  const { accountId } = desktopSocialIdentity()
  const displayName = accountProfile?.displayName || `Ritim PC • ${os.hostname()}`
  return {
    id: accountId,
    displayName,
    handle: `@${displayName.toLocaleLowerCase('tr').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '') || 'ritimpc'}`,
    initials: displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('tr') || 'PC',
    avatarUrl: accountProfile?.avatarUrl,
    avatarTone: 0,
    presence: 'online',
    currentTrack: track ? {
      id: track.id,
      videoId: track.youtubeVideoId,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      position: latestPlayerState.position,
      cover: track.cover,
      thumbnailUrl: track.thumbnailUrl,
      isPlaying: latestPlayerState.isPlaying,
    } : undefined,
    reactionCount: 0,
  }
}

function publishDesktopSocialProfile() {
  if (!socialSocket?.connected) return
  socialSocket.emit('social:profile', { profile: desktopSocialProfile() })
}

function broadcastSocialState(status, incomingState) {
  socialConnectionStatus = status
  const previous = incomingState || latestSocialState
  latestSocialState = {
    currentUser: previous?.currentUser || desktopSocialProfile(),
    privacy: previous?.privacy || {
      profileVisibility: 'everyone',
      listeningVisibility: 'everyone',
    },
    currentDeviceCount: previous?.currentDeviceCount || 1,
    companionConnected: Boolean(previous?.companionConnected),
    users: (previous?.users || []).map((user) => status === 'online' ? user : { ...user, presence: 'offline' }),
    rooms: previous?.rooms || [],
    conversations: previous?.conversations || {},
    selectedUserId: previous?.selectedUserId || '',
    listeningWithUserId: previous?.listeningWithUserId,
    activeRoomId: previous?.activeRoomId,
    authentication: socialAuthStatus,
    connectionStatus: status,
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('shell:social-state', latestSocialState)
}

async function startSocialClient({ forceRefresh = false } = {}) {
  const sequence = ++socialStartSequence
  socialSocket?.disconnect()
  broadcastSocialState('connecting')
  let accessToken = ''
  try {
    const [status, token] = await Promise.all([
      socialAuth?.status(),
      socialAuth?.accessToken({ forceRefresh }),
    ])
    socialAuthStatus = status || socialAuthStatus
    accessToken = token || ''
  } catch (error) {
    console.warn('[Ritim Social] Oturum hazırlanamadı:', error?.message || error)
  }
  if (sequence !== socialStartSequence || isShuttingDown) return
  socialSocket = io(SOCIAL_URL, {
    timeout: 3000,
    reconnectionDelay: 900,
    ...(accessToken ? { auth: { accessToken } } : {}),
  })
  socialSocket.on('connect', () => {
    broadcastSocialState('connecting')
    const identity = desktopSocialIdentity()
    socialSocket.emit('social:join', {
      ...identity,
      deviceRole: 'desktop',
      profile: desktopSocialProfile(),
    })
  })
  socialSocket.on('disconnect', () => broadcastSocialState('offline'))
  let authRetryUsed = false
  socialSocket.on('connect_error', (error) => {
    broadcastSocialState('offline')
    if (
      accessToken
      && !authRetryUsed
      && /oturumu geçersiz/i.test(String(error?.message || ''))
    ) {
      authRetryUsed = true
      void socialAuth?.invalidateAccessToken()
        .then(() => startSocialClient({ forceRefresh: true }))
        .catch(() => {})
    }
  })
  socialSocket.io.on('reconnect_attempt', () => broadcastSocialState('connecting'))
  socialSocket.on('social:state', (state) => {
    broadcastSocialState('online', state)
  })
}

function createMusicView() {
  musicView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:ritim-youtube-music',
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  musicView.setBackgroundColor('#090909')
  musicView.setVisible(true)
  musicView.webContents.setWindowOpenHandler(({ url }) => {
    if (isMusicAuthUrl(url)) {
      void musicView.webContents.loadURL(url)
      return { action: 'deny' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.contentView.addChildView(musicView)
  musicView.setVisible(true)
  resizeMusicView()
  musicView.webContents.on('did-finish-load', () => {
    void musicView?.webContents.insertCSS(`
      ytmusic-player-bar {
        animation: none !important;
        transform: translateY(0) !important;
        opacity: 1 !important;
      }
      ytmusic-player-page[player-page-open] {
        transform: translateY(0) !important;
      }
    `).catch(() => {})
  })
  void musicView.webContents.loadURL('https://music.youtube.com/')
  musicBridge = createYouTubeMusicBridge({
    webContents: musicView.webContents,
    presence,
    onState: (state) => {
      latestPlayerState = state
      publishDesktopSocialProfile()
    },
    room: ROOM,
    syncUrl: process.env.RITIM_SYNC_URL || 'http://127.0.0.1:8787',
  })
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    parent: mainWindow,
    width: 680,
    height: 760,
    minWidth: 620,
    minHeight: 680,
    resizable: true,
    backgroundColor: '#0b0c0d',
    title: 'Ritim Ayarları',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'settings-preload.cjs'),
    },
  })
  settingsWindow.setMenuBarVisibility(false)
  settingsWindow.once('ready-to-show', () => settingsWindow.show())
  settingsWindow.on('closed', () => { settingsWindow = null })
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  void settingsWindow.loadFile(path.join(__dirname, 'settings.html'))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#090909',
    title: 'Ritim',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'shell-preload.cjs'),
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('resize', resizeMusicView)
  mainWindow.on('closed', () => {
    musicBridge?.destroy()
    musicBridge = null
    musicView = null
    mainWindow = null
  })
  void mainWindow.loadFile(path.join(__dirname, 'shell.html'))
  createMusicView()
  setShellView('music')
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  const activePairingToken = getPairingToken()
  socialAuth = createSocialAuthClient({
    baseUrl: SOCIAL_URL,
    userDataPath: app.getPath('userData'),
    safeStorage,
    shell,
  })
  const { startSyncServer } = require('./sync-server.cjs')
  syncServer = startSyncServer(path.join(__dirname, '..', 'dist'), 8787, {
    pairingToken: activePairingToken,
    getSocialCompanionTicket: () => socialAuth.createCompanionTicket(),
  })
  if (!syncServer.listening) {
    try {
      await new Promise((resolve, reject) => {
        syncServer.once('listening', resolve)
        syncServer.once('error', reject)
      })
    } catch (error) {
      console.error('[Ritim] Telefon köprüsü başlatılamadı:', error)
      syncServer = null
    }
  }
  presence = createDiscordPresence(DISCORD_CLIENT_ID)
  updateController = createUpdateController({
    app,
    beforeInstall: prepareForUpdate,
    broadcast: (status) => {
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings:update-status', status)
    },
  })

  ipcMain.on('settings:open', createSettingsWindow)
  ipcMain.handle('shell:set-view', (_event, view) => setShellView(view))
  ipcMain.handle('shell:get-social-state', () => latestSocialState || {
    currentUser: desktopSocialProfile(),
    privacy: {
      profileVisibility: 'everyone',
      listeningVisibility: 'everyone',
    },
    currentDeviceCount: 1,
    companionConnected: false,
    users: [],
    rooms: [],
    conversations: {},
    selectedUserId: '',
    authentication: socialAuthStatus,
    connectionStatus: socialConnectionStatus,
  })
  ipcMain.on('shell:social-action', (_event, action = {}) => {
    if (action.type === 'reconnect') {
      broadcastSocialState('connecting')
      if (socialSocket?.connected) publishDesktopSocialProfile()
      else void startSocialClient()
      return
    }
    if (action.type === 'sign-in') {
      void socialAuth?.signIn()
        .then(async () => {
          socialAuthStatus = await socialAuth.status()
          await startSocialClient()
        })
        .catch((error) => {
          console.error('[Ritim Social] Google ile giriş tamamlanamadı:', error)
          broadcastSocialState('offline')
        })
      return
    }
    if (action.type === 'sign-out') {
      void socialAuth?.signOut().then(async (status) => {
        socialAuthStatus = status
        await startSocialClient()
      })
      return
    }
    if (!socialSocket?.connected) return
    const payload = action.payload || {}
    if (action.type === 'message') socialSocket.emit('social:message', payload)
    if (action.type === 'reaction') socialSocket.emit('social:reaction', payload)
    if (action.type === 'privacy') socialSocket.emit('social:privacy', payload)
    if (action.type === 'block') socialSocket.emit('social:block', payload)
    if (action.type === 'listening') socialSocket.emit('social:listening', payload)
    if (action.type === 'create-room') {
      const track = latestPlayerState?.catalog?.[latestPlayerState?.trackId]
      socialSocket.emit('social:create-room', {
        ...payload,
        title: track?.title || 'Ritim PC dinliyor',
        cover: track?.cover || 0,
      })
    }
  })
  ipcMain.on('player:presence', (_event, payload) => presence?.update(payload))
  ipcMain.handle('settings:get-data', async () => {
    const url = phoneUrl()
    const qrDataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#0a0b0c', light: '#ffffff' },
    })
    return {
      appVersion: app.getVersion(),
      computerName: os.hostname(),
      electronVersion: process.versions.electron,
      phoneUrl: url,
      qrDataUrl,
      room: ROOM,
      serverReady: Boolean(syncServer?.listening),
      updateStatus: updateController?.getStatus(),
      socialAuth: socialAuthStatus,
    }
  })
  ipcMain.handle('settings:copy-url', () => {
    clipboard.writeText(phoneUrl())
    return true
  })
  ipcMain.on('settings:restart', () => {
    isShuttingDown = true
    app.relaunch()
    app.quit()
  })
  ipcMain.handle('settings:check-updates', () => updateController?.check())
  ipcMain.handle('settings:install-update', () => updateController?.install() || false)

  createWindow()
  void startSocialClient()
  setTimeout(() => void updateController?.check(), 3500)
  app.on('activate', () => {
    if (!isShuttingDown && BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isShuttingDown && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isShuttingDown = true
  stopRuntime()
})
