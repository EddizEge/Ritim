const { app, BrowserWindow, WebContentsView, clipboard, ipcMain, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const QRCode = require('qrcode')
const { createDiscordPresence } = require('./discord-presence.cjs')
const { createYouTubeMusicBridge } = require('./ytmusic-bridge.cjs')
const { createUpdateController } = require('./updater.cjs')

const isDev = !app.isPackaged
const APP_BAR_HEIGHT = 52
const ROOM = process.env.RITIM_ROOM || 'EDIZ-4821'
let pairingToken = process.env.RITIM_PAIRING_TOKEN || ''
let mainWindow
let musicView
let settingsWindow
let syncServer
let presence
let musicBridge
let updateController
let isShuttingDown = false

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
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  const activePairingToken = getPairingToken()
  if (!isDev) {
    const { startSyncServer } = require('./sync-server.cjs')
    syncServer = startSyncServer(path.join(__dirname, '..', 'dist'), 8787, { pairingToken: activePairingToken })
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
  }
  presence = createDiscordPresence(process.env.RITIM_DISCORD_CLIENT_ID)
  updateController = createUpdateController({
    app,
    beforeInstall: prepareForUpdate,
    broadcast: (status) => {
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings:update-status', status)
    },
  })

  ipcMain.on('settings:open', createSettingsWindow)
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
      serverReady: Boolean(syncServer?.listening || isDev),
      updateStatus: updateController?.getStatus(),
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
