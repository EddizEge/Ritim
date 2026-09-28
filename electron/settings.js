const fallbackData = {
  appVersion: '0.9.1-beta.1',
  computerName: 'EDİZ-PC',
  electronVersion: '43',
  room: 'EDIZ-4821',
  serverReady: true,
  updateStatus: {
    state: 'development', message: 'Güncelleme denetimi paketlenmiş uygulamada çalışır.',
    currentVersion: '0.9.1-beta.1', availableVersion: '', channel: 'beta', lastCheckedAt: '',
    percent: 0, downloadedBytes: 0, totalBytes: 0, canDownload: false, canInstall: false,
  },
  pairing: {
    maskedUrl: 'http://bu-bilgisayar:8787/…?room=EDIZ-4821&token=••••••••',
    revealDurationMs: 60000,
    rotationAllowed: true,
  },
  socialAccount: {
    authenticated: true,
    user: { id: 'e27192a7-4cd3-4ea8-922c-8b99cab26ef9', displayName: 'Ediz Ege Mercan', handle: '@edizegemercan_a18f2b', initials: 'EE' },
    currentDeviceId: 'desktop-preview',
    devices: [
      { id: 'desktop-preview', role: 'desktop', name: 'Ritim PC • EDİZ-PC', lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString() },
      { id: 'phone-preview', role: 'companion', name: 'Ritim Telefon', lastSeenAt: new Date(Date.now() - 240000).toISOString(), createdAt: new Date().toISOString() },
    ],
  },
  socialState: {
    connectionStatus: 'online',
    privacy: { profileVisibility: 'everyone', listeningVisibility: 'everyone' },
    notificationPreferences: { messagesEnabled: true, reactionsEnabled: true, deviceEnabled: false },
    mutedUsers: [],
    blockedUsers: [],
    reportSummary: { total: 0, recent: [] },
  },
  devicePreferences: {
    socialNotificationsEnabled: false,
    appearance: { theme: 'system', density: 'comfortable', motion: 'system', artwork: 'full' },
  },
  productInfo: {
    name: 'Ritim', developer: 'Ediz Ege Mercan',
    descriptionTr: "Ritim, Windows'taki resmi YouTube Music oturumunu Android telefondan yönetmeyi ve kullanıcıların sosyal müzik özellikleriyle etkileşmesini sağlayan bağımsız bir projedir.",
    disclaimerTr: "Ritim; Google veya YouTube ile bağlantılı, onlar tarafından onaylanmış ya da desteklenmiş değildir. YouTube ve YouTube Music, Google LLC'nin ticari markalarıdır.",
    projectLicense: 'Tüm hakları saklıdır / All rights reserved',
    links: {
      github: 'https://github.com/EddizEge/Ritim', releases: 'https://github.com/EddizEge/Ritim/releases',
      privacy: 'https://github.com/EddizEge/Ritim/blob/main/docs/PRIVACY.md',
      thirdPartyNotices: 'https://github.com/EddizEge/Ritim/blob/main/docs/THIRD_PARTY_NOTICES.md',
      feedback: 'https://github.com/EddizEge/Ritim/issues/new',
    },
  },
}

const settingsApi = window.ritimSettings
let accountState
let socialState = fallbackData.socialState
let desktopNotifications = false
let appearancePreferences = fallbackData.devicePreferences.appearance
let pairingState = fallbackData.pairing
let revealSessionId = ''
let revealTimer
const sectionCopy = {
  account: ['Hesap', 'Ritim kimliğin ve sosyal oturumun.'],
  devices: ['Cihazlar', 'Aynı hesaba bağlı PC ve telefonlar.'],
  appearance: ['Görünüm', 'Bu bilgisayardaki tema ve arayüz tercihleri.'],
  social: ['Sosyal', 'Profil ve dinleme görünürlüğünü yönet.'],
  notifications: ['Bildirimler', 'Mesaj, tepki ve cihaz bildirimlerini yönet.'],
  safety: ['Güvenlik', 'Sessize alma, engelleme ve şikâyet özetin.'],
  connection: ['Eşleme', 'Telefonunu bu bilgisayara bağla.'],
  updates: ['Güncellemeler', 'Sürümünü ve Beta kanalını yönet.'],
  about: ['Hakkında', 'Ritim sürümü ve proje bilgileri.'],
}

const byId = (id) => document.getElementById(id)
const elements = {
  accountAvatar: byId('account-avatar'), accountError: byId('account-error'), accountErrorMessage: byId('account-error-message'),
  accountHandle: byId('account-handle'), accountId: byId('account-id'), accountLoading: byId('account-loading'), accountName: byId('account-name'),
  accountWarning: byId('account-warning'),
  accountReady: byId('account-ready'), accountSignedOut: byId('account-signed-out'), aboutAppVersion: byId('about-app-version'),
  appVersion: byId('app-version'), checkUpdateButton: byId('check-update-button'), computerName: byId('computer-name'), copyButton: byId('copy-button'),
  currentDeviceName: byId('current-device-name'), deviceCount: byId('device-count'), deviceEmpty: byId('device-empty'), deviceList: byId('device-list'),
  electronVersion: byId('electron-version'), installUpdateButton: byId('install-update-button'), phoneUrl: byId('phone-url'), qrCode: byId('qr-code'),
  qrFallback: byId('qr-fallback'), restartButton: byId('restart-button'), room: byId('room'), sectionDescription: byId('section-description'),
  sectionTitle: byId('section-title'), serverLabel: byId('server-label'), sidebarStatus: document.querySelector('.sidebar-status'), toast: byId('toast'),
  updateProgress: byId('update-progress'), updateStatus: byId('update-status'),
  profileVisibility: byId('profile-visibility'), listeningVisibility: byId('listening-visibility'), messagesEnabled: byId('messages-enabled'),
  reactionsEnabled: byId('reactions-enabled'), deviceNotificationsButton: byId('device-notifications-button'), mutedCount: byId('muted-count'),
  mutedList: byId('muted-list'), mutedEmpty: byId('muted-empty'), blockedCount: byId('blocked-count'), blockedList: byId('blocked-list'),
  blockedEmpty: byId('blocked-empty'), reportCount: byId('report-count'), reportList: byId('report-list'), reportEmpty: byId('report-empty'),
  revealPairingButton: byId('reveal-pairing-button'), rotatePairingButton: byId('rotate-pairing-button'), pairingRevealStatus: byId('pairing-reveal-status'),
  qrCard: byId('qr-card'), qrCaption: byId('qr-caption'),
  appearanceTheme: byId('appearance-theme'), appearanceDensity: byId('appearance-density'),
  appearanceMotion: byId('appearance-motion'), appearanceArtwork: byId('appearance-artwork'),
  availableVersion: byId('available-version'), updateChannel: byId('update-channel'), updateLastChecked: byId('update-last-checked'),
  updateTransfer: byId('update-transfer'), downloadUpdateButton: byId('download-update-button'),
  productName: byId('product-name'), productDescription: byId('product-description'), productDeveloper: byId('product-developer'),
  productLicense: byId('product-license'), productDisclaimer: byId('product-disclaimer'),
  aboutGithub: byId('about-github'), aboutReleases: byId('about-releases'), aboutPrivacy: byId('about-privacy'),
  aboutNotices: byId('about-notices'), aboutFeedback: byId('about-feedback'),
}

const appearanceValues = {
  theme: new Set(['system', 'dark', 'black']),
  density: new Set(['comfortable', 'compact']),
  motion: new Set(['system', 'reduced']),
  artwork: new Set(['full', 'reduced', 'hidden']),
}
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)')

function normalizeAppearancePreferences(value = {}) {
  return {
    theme: appearanceValues.theme.has(value.theme) ? value.theme : 'system',
    density: appearanceValues.density.has(value.density) ? value.density : 'comfortable',
    motion: appearanceValues.motion.has(value.motion) ? value.motion : 'system',
    artwork: appearanceValues.artwork.has(value.artwork) ? value.artwork : 'full',
  }
}

function applyAppearancePreferences(next) {
  appearancePreferences = normalizeAppearancePreferences(next)
  const root = document.documentElement
  root.dataset.theme = appearancePreferences.theme
  root.dataset.resolvedTheme = appearancePreferences.theme === 'system'
    ? systemThemeQuery.matches ? 'dark' : 'light'
    : appearancePreferences.theme
  root.dataset.density = appearancePreferences.density
  root.dataset.motion = appearancePreferences.motion
  root.dataset.artwork = appearancePreferences.artwork
  elements.appearanceTheme.value = appearancePreferences.theme
  elements.appearanceDensity.value = appearancePreferences.density
  elements.appearanceMotion.value = appearancePreferences.motion
  elements.appearanceArtwork.value = appearancePreferences.artwork
}

systemThemeQuery.addEventListener('change', () => {
  if (appearancePreferences.theme === 'system') applyAppearancePreferences(appearancePreferences)
})

function showToast(message) {
  elements.toast.textContent = message
  elements.toast.classList.add('is-visible')
  window.setTimeout(() => elements.toast.classList.remove('is-visible'), 2000)
}

function renderPairingState(next) {
  pairingState = { ...fallbackData.pairing, ...(next || {}) }
  if (!revealSessionId) elements.phoneUrl.value = pairingState.maskedUrl
  elements.rotatePairingButton.disabled = pairingState.rotationAllowed !== true
  elements.rotatePairingButton.textContent = pairingState.rotationAllowed ? 'Anahtarı yenile' : 'Sistem tarafından yönetiliyor'
}

function maskPairing({ invalidate = true, expired = false } = {}) {
  const hadSession = Boolean(revealSessionId)
  revealSessionId = ''
  window.clearTimeout(revealTimer)
  revealTimer = undefined
  elements.phoneUrl.value = pairingState.maskedUrl
  elements.phoneUrl.classList.remove('is-secret-visible')
  elements.copyButton.disabled = true
  elements.qrCode.hidden = true
  elements.qrCode.removeAttribute('src')
  elements.qrFallback.hidden = false
  elements.qrFallback.textContent = 'Gizli'
  elements.qrCard.classList.add('is-masked')
  elements.qrCaption.textContent = 'Onaydan sonra gösterilir'
  elements.pairingRevealStatus.textContent = expired
    ? 'Gösterim süresi doldu. Yeniden görmek için güvenlik uyarısını tekrar onayla.'
    : 'QR kodu ve bağlantıyı görmek için önce güvenlik uyarısını onayla. Gösterim 60 saniye sonra otomatik kapanır.'
  if (invalidate && hadSession) void settingsApi?.hidePairing()
}

function showRevealedPairing(result) {
  revealSessionId = result.sessionId
  elements.phoneUrl.value = result.phoneUrl
  elements.phoneUrl.classList.add('is-secret-visible')
  elements.copyButton.disabled = false
  elements.qrCode.src = result.qrDataUrl
  elements.qrCode.hidden = false
  elements.qrFallback.hidden = true
  elements.qrCard.classList.remove('is-masked')
  elements.qrCaption.textContent = 'Geçici güvenli gösterim'
  const remainingMs = Math.max(0, Number(result.expiresAt) - Date.now())
  elements.pairingRevealStatus.textContent = `Bağlantı ${Math.max(1, Math.ceil(remainingMs / 1000))} saniye sonra otomatik gizlenecek.`
  window.clearTimeout(revealTimer)
  revealTimer = window.setTimeout(() => maskPairing({ expired: true }), remainingMs)
}

function openSection(section) {
  if (section !== 'connection' && revealSessionId) maskPairing()
  const copy = sectionCopy[section] || sectionCopy.account
  elements.sectionTitle.textContent = copy[0]
  elements.sectionDescription.textContent = copy[1]
  document.querySelectorAll('[data-section]').forEach((button) => button.classList.toggle('is-active', button.dataset.section === section))
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    const selected = panel.dataset.panel === section
    panel.hidden = !selected
    panel.classList.toggle('is-active', selected)
  })
}

function lastSeenLabel(value) {
  if (!value) return 'Henüz çevrimiçi görülmedi'
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000))
  if (!Number.isFinite(elapsedMinutes)) return 'Son görülme bilinmiyor'
  if (elapsedMinutes < 2) return 'Şimdi çevrimiçi'
  if (elapsedMinutes < 60) return `${elapsedMinutes} dk önce görüldü`
  if (elapsedMinutes < 1440) return `${Math.round(elapsedMinutes / 60)} sa önce görüldü`
  return new Date(value).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })
}

function renderDevices(account) {
  elements.deviceList.replaceChildren()
  const devices = account?.devices || []
  elements.deviceCount.textContent = String(devices.length)
  elements.deviceList.hidden = !devices.length
  elements.deviceEmpty.hidden = Boolean(devices.length)
  for (const device of devices) {
    const current = device.id === account.currentDeviceId
    const row = document.createElement('article')
    row.className = 'device-row'
    const icon = document.createElement('span')
    icon.className = 'device-icon'
    icon.textContent = device.role === 'desktop' ? '▣' : '▯'
    const copy = document.createElement('div')
    copy.className = 'device-copy'
    const name = document.createElement('b')
    name.textContent = device.name
    const detail = document.createElement('small')
    detail.textContent = `${device.role === 'desktop' ? 'Bilgisayar' : 'Telefon'} · ${lastSeenLabel(device.lastSeenAt)}`
    copy.append(name, detail)
    row.append(icon, copy)
    if (current) {
      const badge = document.createElement('span')
      badge.className = 'current-device'
      badge.textContent = 'Bu cihaz'
      row.append(badge)
      elements.currentDeviceName.textContent = device.name
    } else {
      const remove = document.createElement('button')
      remove.className = 'device-remove'
      remove.textContent = 'Kaldır'
      remove.addEventListener('click', async () => {
        if (!window.confirm(`${device.name} cihazının Ritim Sosyal erişimi kaldırılsın mı?`)) return
        remove.disabled = true
        remove.textContent = 'Kaldırılıyor…'
        try {
          accountState = settingsApi ? await settingsApi.revokeSocialDevice(device.id) : { ...accountState, devices: accountState.devices.filter((item) => item.id !== device.id) }
          renderAccount(accountState)
          showToast('Cihazın sosyal erişimi kaldırıldı')
        } catch (error) {
          showToast(error?.message || 'Cihaz kaldırılamadı')
          remove.disabled = false
          remove.textContent = 'Kaldır'
        }
      })
      row.append(remove)
    }
    elements.deviceList.append(row)
  }
}

function renderAccount(account) {
  accountState = account
  elements.accountLoading.hidden = true
  elements.accountError.hidden = !account?.error
  elements.accountSignedOut.hidden = Boolean(account?.authenticated || account?.error)
  elements.accountReady.hidden = !account?.authenticated || Boolean(account?.error)
  if (account?.error) {
    elements.accountErrorMessage.textContent = account.error
    renderDevices({ devices: [] })
    return
  }
  if (!account?.authenticated || !account.user) {
    renderDevices({ devices: [] })
    return
  }
  elements.accountName.textContent = account.user.displayName
  elements.accountHandle.textContent = account.user.handle || '@ritim'
  elements.accountId.textContent = account.user.id
  elements.accountAvatar.textContent = account.user.avatarUrl ? '' : account.user.initials || 'R'
  elements.accountAvatar.style.backgroundImage = account.user.avatarUrl ? `url(${account.user.avatarUrl})` : ''
  elements.accountWarning.hidden = !account.warning
  elements.accountWarning.textContent = account.warning || ''
  renderDevices(account)
}

function desktopNotificationsEnabled() {
  return desktopNotifications
}

function renderModerationList(container, empty, users, actionType) {
  container.replaceChildren()
  container.hidden = !users.length
  empty.hidden = Boolean(users.length)
  for (const user of users) {
    const row = document.createElement('article')
    row.className = 'moderation-row'
    const copy = document.createElement('span')
    const name = document.createElement('b')
    name.textContent = user.displayName || 'Ritim kullanıcısı'
    const handle = document.createElement('small')
    handle.textContent = user.handle || user.id || ''
    copy.append(name, handle)
    const button = document.createElement('button')
    button.textContent = actionType === 'mute' ? 'Sesi aç' : 'Engeli kaldır'
    button.addEventListener('click', () => settingsApi?.sendSocialAction(actionType, { targetUserId: user.id }))
    row.append(copy, button)
    container.append(row)
  }
}

function renderSocialState(next) {
  socialState = {
    ...fallbackData.socialState,
    ...(next || {}),
    privacy: { ...fallbackData.socialState.privacy, ...(next?.privacy || {}) },
    notificationPreferences: {
      ...fallbackData.socialState.notificationPreferences,
      ...(next?.notificationPreferences || {}),
      deviceEnabled: desktopNotificationsEnabled(),
    },
    reportSummary: { total: 0, recent: [], ...(next?.reportSummary || {}) },
  }
  elements.profileVisibility.value = socialState.privacy.profileVisibility
  elements.listeningVisibility.value = socialState.privacy.listeningVisibility
  elements.messagesEnabled.checked = socialState.notificationPreferences.messagesEnabled !== false
  elements.reactionsEnabled.checked = socialState.notificationPreferences.reactionsEnabled !== false
  elements.deviceNotificationsButton.textContent = socialState.notificationPreferences.deviceEnabled ? 'Açık · Kapat' : 'Aç'
  elements.deviceNotificationsButton.classList.toggle('is-enabled', socialState.notificationPreferences.deviceEnabled)
  const mutedUsers = socialState.mutedUsers || []
  const blockedUsers = socialState.blockedUsers || []
  elements.mutedCount.textContent = String(mutedUsers.length)
  elements.blockedCount.textContent = String(blockedUsers.length)
  renderModerationList(elements.mutedList, elements.mutedEmpty, mutedUsers, 'mute')
  renderModerationList(elements.blockedList, elements.blockedEmpty, blockedUsers, 'block')
  const reports = socialState.reportSummary.recent || []
  elements.reportCount.textContent = `${socialState.reportSummary.total || 0} kayıt`
  elements.reportList.replaceChildren()
  elements.reportList.hidden = !reports.length
  elements.reportEmpty.hidden = Boolean(reports.length)
  for (const report of reports) {
    const row = document.createElement('article')
    row.className = 'report-row'
    const copy = document.createElement('span')
    const name = document.createElement('b')
    name.textContent = report.displayName || 'Ritim kullanıcısı'
    const detail = document.createElement('small')
    detail.textContent = `${report.reason} · ${new Date(report.createdAt).toLocaleDateString('tr-TR')}`
    const status = document.createElement('small')
    status.textContent = 'Alındı'
    copy.append(name, detail)
    row.append(copy, status)
    elements.reportList.append(row)
  }
}

async function refreshAccount() {
  elements.accountLoading.hidden = false
  elements.accountError.hidden = true
  elements.accountReady.hidden = true
  elements.accountSignedOut.hidden = true
  try {
    const account = settingsApi ? await settingsApi.getSocialAccount() : fallbackData.socialAccount
    renderAccount(account)
  } catch (error) {
    renderAccount({ authenticated: false, devices: [], error: error?.message || 'Hesap bilgileri alınamadı.' })
  }
}

function renderUpdateStatus(status) {
  if (!status) return
  elements.updateStatus.textContent = status.message
  elements.checkUpdateButton.disabled = status.state === 'checking' || status.state === 'downloading' || status.state === 'installing' || status.state === 'ready'
  elements.installUpdateButton.disabled = status.state === 'installing'
  elements.installUpdateButton.hidden = !status.canInstall
  elements.downloadUpdateButton.disabled = status.state === 'downloading'
  elements.downloadUpdateButton.hidden = !status.canDownload
  elements.updateProgress.hidden = status.state !== 'downloading'
  elements.updateProgress.style.setProperty('--update-progress', `${status.percent || 0}%`)
  elements.appVersion.textContent = status.currentVersion || elements.appVersion.textContent
  elements.availableVersion.textContent = status.availableVersion || '—'
  const channelLabels = { alpha: 'Alpha', beta: 'Beta', rc: 'RC', latest: 'Kararlı' }
  elements.updateChannel.textContent = channelLabels[status.channel] || String(status.channel || '—')
  elements.updateLastChecked.textContent = status.lastCheckedAt
    ? new Date(status.lastCheckedAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : 'Henüz denetlenmedi'
  const formatBytes = (value) => {
    const bytes = Math.max(0, Number(value) || 0)
    if (!bytes) return '0 MB'
    return `${(bytes / 1024 / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} MB`
  }
  elements.updateTransfer.textContent = status.totalBytes
    ? `${formatBytes(status.downloadedBytes)} / ${formatBytes(status.totalBytes)} · %${Math.round(status.percent || 0)}`
    : status.state === 'available' ? 'İndirme bekleniyor' : '—'
}

function renderProductInfo(info = fallbackData.productInfo) {
  const selected = { ...fallbackData.productInfo, ...(info || {}), links: { ...fallbackData.productInfo.links, ...(info?.links || {}) } }
  elements.productName.textContent = selected.name
  elements.productDescription.textContent = selected.descriptionTr
  elements.productDeveloper.textContent = `${selected.developer} tarafından geliştirildi`
  elements.productLicense.textContent = selected.projectLicense
  elements.productDisclaimer.textContent = selected.disclaimerTr
  elements.aboutGithub.href = selected.links.github
  elements.aboutReleases.href = selected.links.releases
  elements.aboutPrivacy.href = selected.links.privacy
  elements.aboutNotices.href = selected.links.thirdPartyNotices
  elements.aboutFeedback.href = selected.links.feedback
}

async function loadSettings() {
  const data = settingsApi ? await settingsApi.getData() : fallbackData
  elements.appVersion.textContent = data.appVersion
  elements.aboutAppVersion.textContent = data.appVersion
  elements.computerName.textContent = data.computerName
  elements.electronVersion.textContent = data.electronVersion
  elements.room.textContent = data.room
  elements.serverLabel.textContent = data.serverReady ? 'Bağlantı hazır' : 'Sunucu bekleniyor'
  elements.sidebarStatus.classList.toggle('is-offline', !data.serverReady)
  renderUpdateStatus(data.updateStatus)
  renderProductInfo(data.productInfo)
  desktopNotifications = data.devicePreferences?.socialNotificationsEnabled === true
  applyAppearancePreferences(data.devicePreferences?.appearance)
  renderPairingState(data.pairing)
  maskPairing({ invalidate: false })
  renderAccount(data.socialAccount || { authenticated: false, currentDeviceId: '', devices: [] })
  renderSocialState(data.socialState)
}

document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', () => openSection(button.dataset.section)))
elements.revealPairingButton.addEventListener('click', async () => {
  if (!settingsApi) return showToast('Güvenli eşleme gösterimi masaüstü uygulamasında çalışır')
  elements.revealPairingButton.disabled = true
  try {
    const result = await settingsApi.revealPairing()
    if (result?.ok) {
      showRevealedPairing(result)
      showToast('Eşleme bağlantısı geçici olarak gösteriliyor')
    } else if (result?.reason !== 'cancelled') {
      showToast(result?.message || 'Eşleme bağlantısı gösterilemedi')
    }
  } catch (error) {
    showToast(error?.message || 'Eşleme bağlantısı gösterilemedi')
  } finally {
    elements.revealPairingButton.disabled = false
  }
})
elements.copyButton.addEventListener('click', async () => {
  if (!settingsApi || !revealSessionId) return showToast('Önce eşleme bağlantısını göster')
  try {
    const result = await settingsApi.copyUrl(revealSessionId)
    if (!result?.ok) {
      maskPairing({ invalidate: false, expired: true })
      return showToast(result?.message || 'Gösterim süresi doldu')
    }
    showToast('Telefon bağlantısı kopyalandı')
  } catch (error) {
    showToast(error?.message || 'Telefon bağlantısı kopyalanamadı')
  }
})
elements.rotatePairingButton.addEventListener('click', async () => {
  if (pairingState.rotationAllowed !== true) return showToast('Eşleme anahtarı sistem tarafından yönetiliyor')
  if (!window.confirm('İlk uyarı: Anahtarı yenilersen bağlı telefonların bağlantısı kesilir ve eski QR kodları çalışmaz. Devam edilsin mi?')) return
  if (!settingsApi) return showToast('Anahtar yenileme masaüstü uygulamasında çalışır')
  elements.rotatePairingButton.disabled = true
  try {
    const result = await settingsApi.rotatePairing()
    if (result?.ok) {
      renderPairingState(result.pairing)
      maskPairing({ invalidate: false })
      showToast('Eşleme anahtarı yenilendi; telefonları yeniden eşle')
    } else if (result?.reason !== 'cancelled') {
      showToast(result?.message || 'Eşleme anahtarı yenilenemedi')
    }
  } catch (error) {
    showToast(error?.message || 'Eşleme anahtarı yenilenemedi')
  } finally {
    elements.rotatePairingButton.disabled = pairingState.rotationAllowed !== true
  }
})
elements.restartButton.addEventListener('click', () => settingsApi ? settingsApi.restart() : showToast('Yeniden başlatma masaüstü uygulamasında çalışır'))
elements.checkUpdateButton.addEventListener('click', async () => {
  if (!settingsApi) return showToast('Güncelleme denetimi masaüstü uygulamasında çalışır')
  renderUpdateStatus({ state: 'checking', message: 'Güncellemeler kontrol ediliyor…', percent: 0, canInstall: false })
  renderUpdateStatus(await settingsApi.checkUpdates())
})
elements.downloadUpdateButton.addEventListener('click', async () => {
  if (!settingsApi) return showToast('Güncelleme indirme paketlenmiş masaüstü uygulamasında çalışır')
  renderUpdateStatus(await settingsApi.downloadUpdate())
})
elements.installUpdateButton.addEventListener('click', () => settingsApi?.installUpdate())
function sendPrivacy() {
  settingsApi?.sendSocialAction('privacy', {
    profileVisibility: elements.profileVisibility.value,
    listeningVisibility: elements.listeningVisibility.value,
  })
}
elements.profileVisibility.addEventListener('change', sendPrivacy)
elements.listeningVisibility.addEventListener('change', sendPrivacy)
function sendNotificationPreferences() {
  settingsApi?.sendSocialAction('notification-preferences', {
    messagesEnabled: elements.messagesEnabled.checked,
    reactionsEnabled: elements.reactionsEnabled.checked,
  })
}
elements.messagesEnabled.addEventListener('change', sendNotificationPreferences)
elements.reactionsEnabled.addEventListener('change', sendNotificationPreferences)
elements.deviceNotificationsButton.addEventListener('click', async () => {
  const requested = !desktopNotificationsEnabled()
  const result = settingsApi
    ? await settingsApi.setDeviceNotifications(requested)
    : { socialNotificationsEnabled: requested, supported: true }
  desktopNotifications = result.socialNotificationsEnabled === true
  renderSocialState(socialState)
  showToast(!result.supported
    ? 'Windows sistem bildirimlerini desteklemiyor'
    : desktopNotifications ? 'Bu PC’de sistem bildirimleri açıldı' : 'Bu PC’de sistem bildirimleri kapatıldı')
})
async function saveAppearancePreferences() {
  const previous = appearancePreferences
  const requested = {
    theme: elements.appearanceTheme.value,
    density: elements.appearanceDensity.value,
    motion: elements.appearanceMotion.value,
    artwork: elements.appearanceArtwork.value,
  }
  applyAppearancePreferences(requested)
  try {
    const saved = settingsApi ? await settingsApi.setAppearance(requested) : requested
    applyAppearancePreferences(saved)
    showToast('Görünüm bu PC için kaydedildi')
  } catch (error) {
    applyAppearancePreferences(previous)
    showToast(error?.message || 'Görünüm tercihi kaydedilemedi')
  }
}
for (const select of [elements.appearanceTheme, elements.appearanceDensity, elements.appearanceMotion, elements.appearanceArtwork]) {
  select.addEventListener('change', () => void saveAppearancePreferences())
}
byId('account-retry-button').addEventListener('click', () => void refreshAccount())
byId('devices-refresh-button').addEventListener('click', () => void refreshAccount())
byId('social-sign-in-button').addEventListener('click', async () => {
  if (!settingsApi) return showToast('Google girişi masaüstü uygulamasında açılır')
  byId('social-sign-in-button').disabled = true
  try { renderAccount(await settingsApi.signInSocial()); showToast('Ritim Sosyal bağlandı') } catch (error) { showToast(error?.message || 'Giriş tamamlanamadı') }
  finally { byId('social-sign-in-button').disabled = false }
})
byId('social-sign-out-button').addEventListener('click', async () => {
  if (!window.confirm('Bu PC’deki Ritim Sosyal oturumu kapatılsın mı? YouTube Music oturumun açık kalır.')) return
  try {
    renderAccount(settingsApi ? await settingsApi.signOutSocial() : { authenticated: false, currentDeviceId: '', devices: [] })
    showToast('Ritim Sosyal oturumu kapatıldı')
  } catch (error) { showToast(error?.message || 'Oturum kapatılamadı') }
})
settingsApi?.onUpdateStatus(renderUpdateStatus)
settingsApi?.onSocialState(renderSocialState)
settingsApi?.onAppearance(applyAppearancePreferences)

applyAppearancePreferences(appearancePreferences)
renderProductInfo(fallbackData.productInfo)
void loadSettings().catch((error) => {
  elements.serverLabel.textContent = 'Bilgiler alınamadı'
  elements.sidebarStatus.classList.add('is-offline')
  renderAccount({ authenticated: false, devices: [], error: error?.message || 'Ayarlar yüklenemedi.' })
})
