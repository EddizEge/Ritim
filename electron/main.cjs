const { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, Notification, protocol, safeStorage, session, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const QRCode = require('qrcode')
const { io } = require('socket.io-client')
const { createAppearanceStore, normalizeAppearancePreferences } = require('./appearance-store.cjs')
const { createDiscordPresence } = require('./discord-presence.cjs')
const { createDevicePreferences } = require('./device-preferences.cjs')
const { createPairingRevealStore, createPairingSecurity, createSafeSettingsData } = require('./pairing-security.cjs')
const { updateClockEstimate } = require('./room-playback-sync.cjs')
const { createSocialAuthClient } = require('./social-auth-client.cjs')
const {
  SETTINGS_SECTIONS,
  createSocialActionBridge,
  normalizeSocialAction,
  publicSocialAuthentication,
  sanitizeSocialErrorEvent,
  socialBadgeCount,
} = require('./social-bridge.cjs')
const {
  SOCIAL_PARTITION,
  SOCIAL_SCHEME,
  createSocialProtocolHandler,
  isExternalWebUrl,
  isSocialPageUrl,
  socialPageUrl,
  socialSchemePrivileges,
} = require('./social-page.cjs')
const { createSocialProfilePublisher } = require('./social-profile-policy.cjs')
const { handleFromDisplayName } = require('./social-handle.cjs')
const { desktopSocialNotificationContent } = require('./social-notifications.cjs')
const { createYouTubeMusicBridge } = require('./ytmusic-bridge.cjs')
const { createUpdateController } = require('./updater.cjs')
const productInfo = require('../shared/product-info.json')

const APP_BAR_HEIGHT = 52
const ROOM = process.env.RITIM_ROOM || 'EDIZ-4821'
const DISCORD_CLIENT_ID = process.env.RITIM_DISCORD_CLIENT_ID || '1528122277500030976'
const PUBLIC_SOCIAL_URL = 'https://social.edizegemercan.com.tr'
const LOCAL_SOCIAL_URL = 'http://127.0.0.1:8790'
const SOCIAL_URL = process.env.RITIM_SOCIAL_URL || (app.isPackaged ? PUBLIC_SOCIAL_URL : LOCAL_SOCIAL_URL)
const SETTINGS_PAGE_URL = pathToFileURL(path.join(__dirname, 'settings.html')).toString()
// Packaged builds (or RITIM_SOCIAL_FROM_DIST=1) serve the Social view from dist/;
// `npm run desktop` uses the Vite development server.
const SOCIAL_PAGE_FROM_DIST = app.isPackaged || process.env.RITIM_SOCIAL_FROM_DIST === '1'
const SOCIAL_PAGE_URL = socialPageUrl({
  isPackaged: SOCIAL_PAGE_FROM_DIST,
  devServerUrl: process.env.RITIM_DEV_SERVER_URL || undefined,
})
const pairingRevealStore = createPairingRevealStore({ ttlMs: 60_000 })
const socialProfilePublisher = createSocialProfilePublisher()
let mainWindow
let musicView
let socialView
let socialSessionConfigured = false
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
// "Son başarılı bağlantı" in the Social view, which may be opened later.
let socialLastOnlineAt = 0
let latestPlayerState
let publishedPlaybackRoomId = ''
let publishedPlaybackRevision = 0
let publishedPlaybackSignature = ''
let appliedPlaybackRoomId = ''
let scheduledPlaybackRevision = 0
let pendingRoomPlayback
let roomPlaybackApplyRunning = false
let roomPlaybackApplyChain = Promise.resolve()
let socialClockEstimate = {}
let socialClockPingInFlight = false
let socialClockTimer
let updateController
let devicePreferences
let appearanceStore
let pairingSecurity
let isShuttingDown = false
let activeShellView = 'music'
const socialActionBridge = createSocialActionBridge({ getSocket: () => socialSocket })

// Must run before the app is ready; the scheme is only handled in the Social
// view's own session (configureSocialSession).
protocol.registerSchemesAsPrivileged([socialSchemePrivileges()])

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
  if (socialClockTimer) clearInterval(socialClockTimer)
  socialClockTimer = undefined
  socialClockPingInFlight = false
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
  // Keep the running app intact until electron-updater actually begins quitting.
  // The normal before-quit handler stops Ritim's local services safely.
  pairingRevealStore.invalidateAll()
}

function isTrustedSettingsSender(event) {
  if (!settingsWindow || settingsWindow.isDestroyed()) return false
  const senderFrame = event?.senderFrame
  return event.sender === settingsWindow.webContents
    && senderFrame === event.sender.mainFrame
    && senderFrame?.url === SETTINGS_PAGE_URL
}

function isTrustedSocialSender(event) {
  if (!socialView || socialView.webContents.isDestroyed()) return false
  const senderFrame = event?.senderFrame
  return event.sender === socialView.webContents
    && senderFrame === event.sender.mainFrame
    && isSocialPageUrl(senderFrame?.url, SOCIAL_PAGE_URL)
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

function phoneUrl() {
  return `http://${findLanAddress()}:8787/?companion=1&room=${encodeURIComponent(ROOM)}&token=${encodeURIComponent(pairingSecurity.getPairingToken())}&installationId=${encodeURIComponent(pairingSecurity.getInstallationId())}&computerName=${encodeURIComponent(os.hostname())}`
}

function maskedPhoneUrl() {
  return `http://${findLanAddress()}:8787/…?room=${encodeURIComponent(ROOM)}&token=••••••••`
}

function resizeContentViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const [width, height] = mainWindow.getContentSize()
  const bounds = { x: 0, y: APP_BAR_HEIGHT, width, height: Math.max(0, height - APP_BAR_HEIGHT) }
  musicView?.setBounds(bounds)
  socialView?.setBounds(bounds)
}

function sendToSocialView(channel, payload) {
  if (!socialView || socialView.webContents.isDestroyed()) return
  socialView.webContents.send(channel, payload)
}

// Hidden Social view keeps its React state (selection, drafts) but must not
// mark conversations read while the user is on the Music tab.
function socialViewVisible() {
  return activeShellView === 'social'
    && Boolean(mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized())
}

function sendSocialVisibility() {
  sendToSocialView('social:visibility', socialViewVisible())
}

function configureSocialSession() {
  if (socialSessionConfigured) return
  socialSessionConfigured = true
  const socialSession = session.fromPartition(SOCIAL_PARTITION)
  socialSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  socialSession.setPermissionCheckHandler(() => false)
  if (SOCIAL_PAGE_FROM_DIST) {
    socialSession.protocol.handle(SOCIAL_SCHEME, createSocialProtocolHandler({
      distRoot: path.join(__dirname, '..', 'dist'),
      readFile: (filePath) => fs.promises.readFile(filePath),
    }))
  }
}

// The Social view is created on first use and then kept alive behind the
// Music view. It renders the shared React DesktopSocialHub and talks to the
// main-process social socket only through social-preload.cjs.
function ensureSocialView() {
  if (socialView) return socialView
  if (!mainWindow || mainWindow.isDestroyed()) return null
  configureSocialSession()
  socialView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: SOCIAL_PARTITION,
      preload: path.join(__dirname, 'social-preload.cjs'),
      spellcheck: false,
    },
  })
  socialView.setBackgroundColor('#090a0a')
  socialView.setVisible(false)
  const contents = socialView.webContents
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isSocialPageUrl(url, SOCIAL_PAGE_URL)) return
    event.preventDefault()
    if (isExternalWebUrl(url)) void shell.openExternal(url)
  })
  contents.on('will-redirect', (event, url) => {
    if (!isSocialPageUrl(url, SOCIAL_PAGE_URL)) event.preventDefault()
  })
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame) console.error('[Ritim Social] Sosyal görünüm yüklenemedi:', errorCode, errorDescription, validatedUrl)
  })
  mainWindow.contentView.addChildView(socialView)
  resizeContentViews()
  void contents.loadURL(SOCIAL_PAGE_URL).catch((error) => {
    console.error('[Ritim Social] Sosyal görünüm açılamadı:', error?.message || error)
  })
  return socialView
}

function setShellView(nextView) {
  activeShellView = nextView === 'social' ? 'social' : 'music'
  if (activeShellView === 'social') ensureSocialView()
  musicView?.setVisible(activeShellView === 'music')
  socialView?.setVisible(activeShellView === 'social')
  resizeContentViews()
  if (activeShellView === 'social' && socialView && !socialView.webContents.isDestroyed()) {
    socialView.webContents.focus()
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shell:view-changed', activeShellView)
  }
  sendSocialVisibility()
  return activeShellView
}

function broadcastAppearancePreferences(preferences = appearanceStore?.read()) {
  if (!preferences) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shell:appearance', preferences)
  }
  sendToSocialView('social:appearance', preferences)
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:appearance', preferences)
  }
}

function desktopSocialIdentity() {
  const accountId = pairingSecurity.socialAccountId()
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
    // Empty when nothing usable remains; the gateway then derives it.
    handle: handleFromDisplayName(displayName),
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

function publishDesktopSocialProfile({ force = false } = {}) {
  if (!socialSocket?.connected) return
  const profile = desktopSocialProfile()
  // The player reports state on every capture; see social-profile-policy.cjs.
  if (!force && !socialProfilePublisher.shouldPublish(profile)) return
  socialProfilePublisher.remember(profile)
  socialSocket.emit('social:profile', { profile })
}

function publishOwnedRoomPlayback() {
  if (!socialSocket?.connected || !latestPlayerState) return
  const room = latestSocialState?.rooms?.find((candidate) => candidate.viewerRole === 'owner')
  const track = latestPlayerState.catalog?.[latestPlayerState.trackId]
  const videoId = String(track?.youtubeVideoId || '').trim()
  if (!room || !videoId) return
  if (publishedPlaybackRoomId !== room.id) {
    publishedPlaybackRoomId = room.id
    publishedPlaybackRevision = Number(room.playback?.playbackRevision) || 0
    publishedPlaybackSignature = ''
  } else {
    publishedPlaybackRevision = Math.max(
      publishedPlaybackRevision,
      Number(room.playback?.playbackRevision) || 0,
    )
  }
  const playbackPositionMs = Math.max(0, Math.round((Number(latestPlayerState.position) || 0) * 1000))
  const playbackState = latestPlayerState.isPlaying ? 'playing' : 'paused'
  const signature = JSON.stringify([videoId, playbackPositionMs, playbackState])
  if (signature === publishedPlaybackSignature) return
  publishedPlaybackSignature = signature
  const playbackRevision = ++publishedPlaybackRevision
  socialSocket.emit('social:room-playback:update', {
    roomId: room.id,
    videoId,
    playbackPositionMs,
    playbackState,
    playbackRevision,
  }, (result = {}) => {
    const acceptedRevision = Number(result.playback?.playbackRevision) || 0
    publishedPlaybackRevision = Math.max(publishedPlaybackRevision, acceptedRevision)
    if (!result.ok) publishedPlaybackSignature = ''
  })
}

function measureSocialClock() {
  const listenerRoom = latestSocialState?.rooms?.find((candidate) => candidate.viewerRole === 'listener')
  if (!listenerRoom || !socialSocket?.connected || socialClockPingInFlight) return
  const activeSocket = socialSocket
  const requestId = crypto.randomUUID()
  const clientSentAtMs = Date.now()
  socialClockPingInFlight = true
  let settled = false
  const finish = () => {
    if (settled) return false
    settled = true
    socialClockPingInFlight = false
    clearTimeout(timeout)
    return true
  }
  const timeout = setTimeout(() => finish(), 3_000)
  activeSocket.emit('social:clock:ping', { requestId, clientSentAtMs }, (result = {}) => {
    const clientReceivedAtMs = Date.now()
    if (!finish() || activeSocket !== socialSocket || result.requestId !== requestId) return
    if (!Number.isFinite(Number(result.serverTimeMs))) return
    socialClockEstimate = updateClockEstimate(socialClockEstimate, {
      clientSentAtMs,
      clientReceivedAtMs,
      serverTimeMs: Number(result.serverTimeMs),
    })
  })
}

function reportRoomPlaybackResult(playback, result) {
  if (!socialSocket?.connected || !playback?.roomId || !playback?.playbackRevision) return
  socialSocket.emit('social:room-playback:result', {
    roomId: playback.roomId,
    playbackRevision: playback.playbackRevision,
    status: result?.applied ? 'applied' : 'failed',
    seekApplied: Boolean(result?.seekApplied),
    playbackStateApplied: Boolean(result?.playbackStateApplied),
    driftMs: Number(result?.driftMs) || 0,
    roundTripMs: Number(socialClockEstimate.roundTripMs) || 0,
    reason: result?.reason,
    error: result?.error,
  })
}

function applyJoinedRoomPlayback(state) {
  const room = state?.rooms?.find((candidate) => candidate.viewerRole === 'listener')
  const playback = room?.playback
  if (!room || !playback) {
    appliedPlaybackRoomId = ''
    scheduledPlaybackRevision = 0
    pendingRoomPlayback = undefined
    return
  }
  if (appliedPlaybackRoomId !== room.id) {
    appliedPlaybackRoomId = room.id
    scheduledPlaybackRevision = 0
  }
  const revision = Number(playback.playbackRevision) || 0
  if (revision <= scheduledPlaybackRevision) return
  scheduledPlaybackRevision = revision
  pendingRoomPlayback = playback
  if (roomPlaybackApplyRunning) return
  roomPlaybackApplyRunning = true
  roomPlaybackApplyChain = (async () => {
    while (pendingRoomPlayback) {
      const nextPlayback = pendingRoomPlayback
      pendingRoomPlayback = undefined
      try {
        const result = await musicBridge?.applyRoomPlayback(nextPlayback, socialClockEstimate)
        reportRoomPlaybackResult(nextPlayback, result)
      } catch (error) {
        console.warn('[Ritim Social] Oda oynatma durumu uygulanamadı:', error?.message || error)
        reportRoomPlaybackResult(nextPlayback, {
          applied: false,
          reason: 'apply_failed',
          error: error?.message || String(error),
        })
      }
    }
  })().finally(() => {
    roomPlaybackApplyRunning = false
    if (pendingRoomPlayback) applyJoinedRoomPlayback(latestSocialState)
  })
}

function emptySocialState() {
  return {
    currentUser: desktopSocialProfile(),
    privacy: {
      profileVisibility: 'everyone',
      listeningVisibility: 'everyone',
    },
    currentDeviceCount: 1,
    companionConnected: false,
    users: [],
    rooms: [],
    roomMessages: {},
    roomReactions: {},
    conversations: {},
    unreadCounts: {},
    messageRequests: [],
    notifications: [],
    notificationPreferences: { messagesEnabled: true, reactionsEnabled: true, deviceEnabled: false },
    mutedUserIds: [],
    mutedUsers: [],
    blockedUsers: [],
    reportSummary: { total: 0, recent: [] },
    selectedUserId: '',
    authentication: socialAuthStatus,
    connectionStatus: socialConnectionStatus,
  }
}

// What the Social view renders: the gateway snapshot, this PC's system
// notification switch and a token-free authentication summary.
function socialViewState() {
  const state = latestSocialState || emptySocialState()
  return {
    ...state,
    notificationPreferences: {
      ...state.notificationPreferences,
      deviceEnabled: Boolean(devicePreferences?.read().socialNotificationsEnabled),
    },
    authentication: publicSocialAuthentication(socialAuthStatus),
    connectionStatus: socialConnectionStatus,
    lastOnlineAt: socialLastOnlineAt || undefined,
  }
}

function socialShellSummary() {
  return {
    unreadCount: socialBadgeCount(latestSocialState),
    companionConnected: Boolean(latestSocialState?.companionConnected),
  }
}

// Signing in or out must not leave the previous account's conversations on
// screen until the new session's first snapshot arrives.
function resetSocialSessionState() {
  latestSocialState = undefined
}

function broadcastSocialState(status, incomingState) {
  if (status === 'online' || socialConnectionStatus === 'online') socialLastOnlineAt = Date.now()
  socialConnectionStatus = status
  const previousState = latestSocialState
  const previous = incomingState || previousState
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
    roomMessages: previous?.roomMessages || {},
    roomReactions: previous?.roomReactions || {},
    conversations: previous?.conversations || {},
    unreadCounts: previous?.unreadCounts || {},
    messageRequests: previous?.messageRequests || [],
    notifications: previous?.notifications || [],
    notificationPreferences: previous?.notificationPreferences || {
      messagesEnabled: true,
      reactionsEnabled: true,
      deviceEnabled: false,
    },
    mutedUserIds: previous?.mutedUserIds || [],
    mutedUsers: previous?.mutedUsers || [],
    blockedUsers: previous?.blockedUsers || [],
    reportSummary: previous?.reportSummary || { total: 0, recent: [] },
    selectedUserId: previous?.selectedUserId || '',
    listeningWithUserId: previous?.listeningWithUserId,
    activeRoomId: previous?.activeRoomId,
    authentication: socialAuthStatus,
    connectionStatus: status,
  }
  if (incomingState) deliverDesktopSocialNotifications(previousState, latestSocialState)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('shell:social-summary', socialShellSummary())
  sendToSocialView('social:state', socialViewState())
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings:social-state', latestSocialState)
}

function deliverDesktopSocialNotifications(previousState, nextState) {
  const preferences = devicePreferences?.read()
  if (!preferences?.socialNotificationsEnabled || !Notification.isSupported()) return
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() && activeShellView === 'social') return
  const delivered = new Set(preferences.deliveredSocialNotificationIds)
  const previousIds = new Set((previousState?.notifications || []).map((notification) => notification.id))
  let changed = false
  for (const notification of nextState.notifications || []) {
    if (notification.read || delivered.has(notification.id)) continue
    if (previousState && previousIds.has(notification.id)) continue
    const actor = nextState.users?.find((user) => user.id === notification.actorId)
    const actorName = actor?.displayName || 'Bir Ritim kullanıcısı'
    // Unknown kinds and kinds switched off in preferences are not shown.
    const content = desktopSocialNotificationContent(notification, actorName, nextState.notificationPreferences)
    if (!content) continue
    new Notification(content).show()
    delivered.add(notification.id)
    changed = true
  }
  if (changed) {
    devicePreferences.update({ deliveredSocialNotificationIds: [...delivered].slice(-100) })
  }
}

async function startSocialClient({ forceRefresh = false } = {}) {
  const sequence = ++socialStartSequence
  if (socialClockTimer) clearInterval(socialClockTimer)
  socialClockTimer = undefined
  socialClockPingInFlight = false
  socialClockEstimate = {}
  socialSocket?.disconnect()
  broadcastSocialState('connecting')
  let accessToken = ''
  try {
    const [status, token] = await Promise.all([
      socialAuth?.status(),
      socialAuth?.accessToken({ forceRefresh }),
    ])
    socialAuthStatus = status || socialAuthStatus
    accessToken = status?.configured ? (token || '') : ''
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
    const profile = desktopSocialProfile()
    socialSocket.emit('social:join', {
      ...identity,
      deviceRole: 'desktop',
      profile,
    })
    socialProfilePublisher.remember(profile)
    measureSocialClock()
  })
  socialSocket.on('disconnect', () => {
    appliedPlaybackRoomId = ''
    scheduledPlaybackRevision = 0
    pendingRoomPlayback = undefined
    broadcastSocialState('offline')
  })
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
  socialSocket.on('social:error', (error) => sendToSocialView('social:event', sanitizeSocialErrorEvent(error)))
  socialSocket.on('social:report-saved', () => sendToSocialView('social:event', { kind: 'report-saved' }))
  socialSocket.on('social:state', (state) => {
    broadcastSocialState('online', state)
    publishOwnedRoomPlayback()
    applyJoinedRoomPlayback(state)
    if (Date.now() - (Number(socialClockEstimate.measuredAtMs) || 0) >= 5_000) measureSocialClock()
  })
  socialClockTimer = setInterval(measureSocialClock, 5_000)
  socialClockTimer.unref?.()
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
  resizeContentViews()
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
      publishOwnedRoomPlayback()
    },
    room: ROOM,
    syncUrl: process.env.RITIM_SYNC_URL || 'http://127.0.0.1:8787',
  })
}

// `section` comes only from the main process (Social view's 'open-settings'
// action is validated in social-bridge.cjs); the page shows that section.
function createSettingsWindow(section) {
  const targetSection = SETTINGS_SECTIONS.has(section) ? section : ''
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    if (targetSection) settingsWindow.webContents.send('settings:open-section', targetSection)
    return
  }
  settingsWindow = new BrowserWindow({
    parent: mainWindow,
    width: 920,
    height: 720,
    minWidth: 800,
    minHeight: 620,
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
  const settingsWebContentsId = settingsWindow.webContents.id
  settingsWindow.setMenuBarVisibility(false)
  settingsWindow.once('ready-to-show', () => settingsWindow.show())
  settingsWindow.on('closed', () => {
    pairingRevealStore.invalidateOwner(settingsWebContentsId)
    settingsWindow = null
  })
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (target.protocol === 'https:' && target.hostname === 'github.com') void shell.openExternal(target.toString())
    } catch {
      // Invalid and non-web targets stay inside the denied renderer request.
    }
    return { action: 'deny' }
  })
  settingsWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== SETTINGS_PAGE_URL) event.preventDefault()
  })
  settingsWindow.webContents.on('will-redirect', (event, url) => {
    if (url !== SETTINGS_PAGE_URL) event.preventDefault()
  })
  if (targetSection) {
    settingsWindow.webContents.once('did-finish-load', () => {
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings:open-section', targetSection)
    })
  }
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
  mainWindow.on('resize', resizeContentViews)
  mainWindow.on('minimize', sendSocialVisibility)
  mainWindow.on('restore', sendSocialVisibility)
  mainWindow.on('closed', () => {
    musicBridge?.destroy()
    musicBridge = null
    musicView = null
    socialView = null
    mainWindow = null
  })
  void mainWindow.loadFile(path.join(__dirname, 'shell.html'))
  createMusicView()
  setShellView('music')
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  devicePreferences = createDevicePreferences(app.getPath('userData'))
  appearanceStore = createAppearanceStore(app.getPath('userData'))
  pairingSecurity = createPairingSecurity({
    userDataPath: app.getPath('userData'),
    environmentToken: process.env.RITIM_PAIRING_TOKEN,
  })
  const activePairingToken = pairingSecurity.getPairingToken()
  pairingSecurity.getInstallationId()
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

  const setDesktopSocialNotifications = (enabled) => {
    const supported = Notification.isSupported()
    const next = devicePreferences.update({ socialNotificationsEnabled: supported && enabled === true })
    sendToSocialView('social:state', socialViewState())
    return { socialNotificationsEnabled: next.socialNotificationsEnabled, supported }
  }

  // Every renderer request goes through social-bridge.cjs: unknown types and
  // malformed payloads are rejected before anything reaches the gateway.
  const handleSocialAction = async (type, payload) => {
    const action = normalizeSocialAction(type, payload)
    if (!action.ok) return action
    if (action.type === 'reconnect') {
      broadcastSocialState('connecting')
      if (socialSocket?.connected) publishDesktopSocialProfile({ force: true })
      else void startSocialClient()
      return { ok: true }
    }
    if (action.type === 'sign-in') {
      try {
        await socialAuth.signIn()
        socialAuthStatus = await socialAuth.status()
        resetSocialSessionState()
        await startSocialClient()
        return { ok: true }
      } catch (error) {
        console.error('[Ritim Social] Google ile giriş tamamlanamadı:', error)
        broadcastSocialState('offline')
        return { ok: false, code: 'sign_in_failed' }
      }
    }
    if (action.type === 'sign-out') {
      try {
        socialAuthStatus = await socialAuth.signOut()
        resetSocialSessionState()
        await startSocialClient()
        return { ok: true }
      } catch (error) {
        console.error('[Ritim Social] Ritim Social oturumu kapatılamadı:', error)
        return { ok: false, code: 'sign_out_failed' }
      }
    }
    if (action.type === 'device-notifications') {
      const result = setDesktopSocialNotifications(action.payload.enabled)
      return { ok: true, enabled: result.socialNotificationsEnabled, supported: result.supported }
    }
    if (action.type === 'open-settings') {
      createSettingsWindow(action.payload.section)
      return { ok: true }
    }
    if (action.type === 'create-room') {
      const track = latestPlayerState?.catalog?.[latestPlayerState?.trackId]
      return socialActionBridge.emit({
        ...action,
        payload: {
          title: track?.title || 'Ritim PC dinliyor',
          cover: track?.cover || 0,
        },
      })
    }
    return socialActionBridge.emit(action)
  }

  ipcMain.on('settings:open', () => createSettingsWindow())
  ipcMain.handle('shell:set-view', (_event, view) => setShellView(view))
  ipcMain.handle('shell:get-appearance', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error('Görünüm tercihleri yalnızca Ritim ana penceresinden okunabilir.')
    }
    return appearanceStore.read()
  })
  ipcMain.handle('shell:get-social-summary', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error('Sosyal özet yalnızca Ritim ana penceresinden okunabilir.')
    }
    return socialShellSummary()
  })
  ipcMain.handle('social:get-state', (event) => {
    if (!isTrustedSocialSender(event)) throw new Error('Sosyal durum yalnızca Ritim sosyal görünümünden okunabilir.')
    return { ...socialViewState(), viewVisible: socialViewVisible() }
  })
  ipcMain.handle('social:get-appearance', (event) => {
    if (!isTrustedSocialSender(event)) throw new Error('Görünüm tercihleri yalnızca Ritim sosyal görünümünden okunabilir.')
    return appearanceStore.read()
  })
  ipcMain.handle('social:action', (event, request) => {
    if (!isTrustedSocialSender(event)) return { ok: false, code: 'forbidden' }
    const selected = request && typeof request === 'object' && !Array.isArray(request) ? request : {}
    return handleSocialAction(selected.type, selected.payload)
  })
  // The Settings window keeps its own moderation and preference controls.
  const settingsSocialActions = new Set(['privacy', 'notification-preferences', 'mute', 'block'])
  ipcMain.on('settings:social-action', (event, request) => {
    if (!isTrustedSettingsSender(event)) return
    const selected = request && typeof request === 'object' && !Array.isArray(request) ? request : {}
    if (!settingsSocialActions.has(selected.type)) return
    void handleSocialAction(selected.type, selected.payload)
  })
  ipcMain.on('player:presence', (_event, payload) => presence?.update(payload))
  ipcMain.handle('settings:get-data', async () => {
    const socialAccount = await socialAuth?.account().catch((error) => ({
      authenticated: Boolean(socialAuthStatus?.authenticated),
      user: socialAuthStatus?.user,
      currentDeviceId: socialAuthStatus?.device?.id || '',
      devices: [],
      error: error?.message || 'Hesap bilgileri alınamadı.',
    }))
    return createSafeSettingsData({
      appVersion: app.getVersion(),
      computerName: os.hostname(),
      electronVersion: process.versions.electron,
      room: ROOM,
      serverReady: Boolean(syncServer?.listening),
      updateStatus: updateController?.getStatus(),
      socialAuth: socialAuthStatus,
      socialAccount,
      socialState: latestSocialState,
      devicePreferences: {
        socialNotificationsEnabled: devicePreferences.read().socialNotificationsEnabled,
        appearance: appearanceStore.read(),
      },
      pairing: {
        maskedUrl: maskedPhoneUrl(),
        revealDurationMs: pairingRevealStore.ttlMs,
        rotationAllowed: pairingSecurity.isRotationAllowed(),
      },
      productInfo,
    })
  })
  ipcMain.handle('settings:set-appearance', (event, preferences = {}) => {
    if (!settingsWindow || settingsWindow.isDestroyed() || event.sender !== settingsWindow.webContents) {
      throw new Error('Görünüm tercihleri yalnızca Ayarlar penceresinden değiştirilebilir.')
    }
    const next = appearanceStore.update(normalizeAppearancePreferences(preferences))
    broadcastAppearancePreferences(next)
    return next
  })
  ipcMain.handle('settings:get-social-account', () => socialAuth?.account())
  ipcMain.handle('settings:revoke-social-device', (_event, deviceId) => socialAuth?.revokeDevice(String(deviceId || '')))
  ipcMain.handle('settings:social-sign-out', async () => {
    socialAuthStatus = await socialAuth.signOut()
    resetSocialSessionState()
    await startSocialClient()
    return socialAuth.account()
  })
  ipcMain.handle('settings:social-sign-in', async () => {
    socialAuthStatus = await socialAuth.signIn()
    resetSocialSessionState()
    await startSocialClient()
    return socialAuth.account()
  })
  ipcMain.handle('settings:reveal-pairing', async (event) => {
    if (!settingsWindow || settingsWindow.isDestroyed() || event.sender !== settingsWindow.webContents) {
      return { ok: false, reason: 'forbidden', message: 'Eşleme bilgisi yalnızca Ayarlar penceresinden gösterilebilir.' }
    }
    const { response } = await dialog.showMessageBox(settingsWindow, {
      type: 'warning',
      title: 'Telefon eşleme bağlantısını göster',
      message: 'Bu bağlantıyı yalnızca bağlamak istediğin telefonda kullan.',
      detail: 'QR kodu ve bağlantı, bu bilgisayarı uzaktan kontrol etmeye yarayan gizli bir anahtar içerir. Ekranını paylaşırken gösterme.',
      buttons: ['60 saniye göster', 'Vazgeç'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (response !== 0) return { ok: false, reason: 'cancelled' }

    const url = phoneUrl()
    const session = pairingRevealStore.create(event.sender.id, url)
    try {
      const qrDataUrl = await QRCode.toDataURL(url, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
        color: { dark: '#0a0b0c', light: '#ffffff' },
      })
      return { ok: true, ...session, phoneUrl: url, qrDataUrl }
    } catch (error) {
      pairingRevealStore.invalidateOwner(event.sender.id)
      return { ok: false, reason: 'failed', message: error?.message || 'QR kodu hazırlanamadı.' }
    }
  })
  ipcMain.handle('settings:hide-pairing', (event) => {
    pairingRevealStore.invalidateOwner(event.sender.id)
    return true
  })
  ipcMain.handle('settings:copy-url', (event, revealSessionId) => {
    const url = pairingRevealStore.resolve(revealSessionId, event.sender.id)
    if (!url) return { ok: false, reason: 'expired', message: 'Gösterim süresi doldu. Bağlantıyı yeniden göster.' }
    clipboard.writeText(url)
    return { ok: true }
  })
  ipcMain.handle('settings:rotate-pairing', async (event) => {
    if (!settingsWindow || settingsWindow.isDestroyed() || event.sender !== settingsWindow.webContents) {
      return { ok: false, reason: 'forbidden', message: 'Eşleme anahtarı yalnızca Ayarlar penceresinden yenilenebilir.' }
    }
    if (!pairingSecurity.isRotationAllowed()) {
      return {
        ok: false,
        reason: 'managed',
        message: 'Eşleme anahtarı sistem yöneticisi tarafından yönetiliyor; uygulama içinden yenilenemez.',
      }
    }
    const { response } = await dialog.showMessageBox(settingsWindow, {
      type: 'warning',
      title: 'İkinci onay: eşleme anahtarını yenile',
      message: 'Bağlı tüm telefonların bağlantısı hemen kesilecek.',
      detail: 'Eski QR kodları ve bağlantılar kalıcı olarak geçersiz olur. Telefonları yeni QR koduyla tekrar eşlemen gerekir.',
      buttons: ['Anahtarı yenile', 'Vazgeç'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (response !== 0) return { ok: false, reason: 'cancelled' }

    try {
      const nextToken = pairingSecurity.rotatePairingToken()
      syncServer?.rotatePairingToken(nextToken)
      pairingRevealStore.invalidateAll()
      return {
        ok: true,
        pairing: {
          maskedUrl: maskedPhoneUrl(),
          revealDurationMs: pairingRevealStore.ttlMs,
          rotationAllowed: pairingSecurity.isRotationAllowed(),
        },
      }
    } catch (error) {
      return { ok: false, reason: error?.code || 'failed', message: error?.message || 'Eşleme anahtarı yenilenemedi.' }
    }
  })
  ipcMain.on('settings:restart', () => {
    isShuttingDown = true
    app.relaunch()
    app.quit()
  })
  ipcMain.handle('settings:check-updates', (event) => {
    if (!isTrustedSettingsSender(event)) throw new Error('Yetkisiz güncelleme denetimi isteği.')
    return updateController?.check()
  })
  ipcMain.handle('settings:download-update', (event) => {
    if (!isTrustedSettingsSender(event)) throw new Error('Yetkisiz güncelleme indirme isteği.')
    return updateController?.download()
  })
  ipcMain.handle('settings:install-update', (event) => {
    if (!isTrustedSettingsSender(event)) throw new Error('Yetkisiz güncelleme kurma isteği.')
    return updateController?.install() || false
  })
  ipcMain.handle('settings:set-device-notifications', (_event, enabled) => setDesktopSocialNotifications(enabled))

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
