const fallbackData = {
  appVersion: '0.9.1-beta.1',
  computerName: 'EDİZ-PC',
  electronVersion: '43',
  phoneUrl: 'http://192.168.1.52:8787/?companion=1&room=EDIZ-4821',
  qrDataUrl: '',
  room: 'EDIZ-4821',
  serverReady: true,
  socialAccount: {
    authenticated: true,
    user: { id: 'e27192a7-4cd3-4ea8-922c-8b99cab26ef9', displayName: 'Ediz Ege Mercan', handle: '@edizegemercan_a18f2b', initials: 'EE' },
    currentDeviceId: 'desktop-preview',
    devices: [
      { id: 'desktop-preview', role: 'desktop', name: 'Ritim PC • EDİZ-PC', lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString() },
      { id: 'phone-preview', role: 'companion', name: 'Ritim Telefon', lastSeenAt: new Date(Date.now() - 240000).toISOString(), createdAt: new Date().toISOString() },
    ],
  },
}

const settingsApi = window.ritimSettings
let accountState
const sectionCopy = {
  account: ['Hesap', 'Ritim kimliğin ve sosyal oturumun.'],
  devices: ['Cihazlar', 'Aynı hesaba bağlı PC ve telefonlar.'],
  connection: ['Eşleme', 'Telefonunu bu bilgisayara bağla.'],
  updates: ['Güncellemeler', 'Sürümünü ve Beta kanalını yönet.'],
  about: ['Hakkında', 'Ritim sürümü ve proje bilgileri.'],
}

const byId = (id) => document.getElementById(id)
const elements = {
  accountAvatar: byId('account-avatar'), accountError: byId('account-error'), accountErrorMessage: byId('account-error-message'),
  accountHandle: byId('account-handle'), accountId: byId('account-id'), accountLoading: byId('account-loading'), accountName: byId('account-name'),
  accountReady: byId('account-ready'), accountSignedOut: byId('account-signed-out'), aboutAppVersion: byId('about-app-version'),
  appVersion: byId('app-version'), checkUpdateButton: byId('check-update-button'), computerName: byId('computer-name'), copyButton: byId('copy-button'),
  currentDeviceName: byId('current-device-name'), deviceCount: byId('device-count'), deviceEmpty: byId('device-empty'), deviceList: byId('device-list'),
  electronVersion: byId('electron-version'), installUpdateButton: byId('install-update-button'), phoneUrl: byId('phone-url'), qrCode: byId('qr-code'),
  qrFallback: byId('qr-fallback'), restartButton: byId('restart-button'), room: byId('room'), sectionDescription: byId('section-description'),
  sectionTitle: byId('section-title'), serverLabel: byId('server-label'), sidebarStatus: document.querySelector('.sidebar-status'), toast: byId('toast'),
  updateProgress: byId('update-progress'), updateStatus: byId('update-status'),
}

function showToast(message) {
  elements.toast.textContent = message
  elements.toast.classList.add('is-visible')
  window.setTimeout(() => elements.toast.classList.remove('is-visible'), 2000)
}

function openSection(section) {
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
  renderDevices(account)
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
  elements.checkUpdateButton.disabled = status.state === 'checking' || status.state === 'downloading' || status.state === 'installing'
  elements.installUpdateButton.disabled = status.state === 'installing'
  elements.installUpdateButton.hidden = !status.canInstall
  elements.updateProgress.hidden = status.state !== 'downloading'
  elements.updateProgress.style.setProperty('--update-progress', `${status.percent || 0}%`)
}

async function loadSettings() {
  const data = settingsApi ? await settingsApi.getData() : fallbackData
  elements.appVersion.textContent = data.appVersion
  elements.aboutAppVersion.textContent = data.appVersion
  elements.computerName.textContent = data.computerName
  elements.electronVersion.textContent = data.electronVersion
  elements.phoneUrl.value = data.phoneUrl
  elements.room.textContent = data.room
  elements.serverLabel.textContent = data.serverReady ? 'Bağlantı hazır' : 'Sunucu bekleniyor'
  elements.sidebarStatus.classList.toggle('is-offline', !data.serverReady)
  renderUpdateStatus(data.updateStatus)
  renderAccount(data.socialAccount || { authenticated: false, currentDeviceId: '', devices: [] })
  if (data.qrDataUrl) {
    elements.qrCode.src = data.qrDataUrl
    elements.qrCode.hidden = false
    elements.qrFallback.hidden = true
  }
}

document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', () => openSection(button.dataset.section)))
elements.copyButton.addEventListener('click', async () => {
  try { if (settingsApi) await settingsApi.copyUrl(); else await navigator.clipboard?.writeText(elements.phoneUrl.value) } catch {}
  showToast('Telefon bağlantısı kopyalandı')
})
elements.restartButton.addEventListener('click', () => settingsApi ? settingsApi.restart() : showToast('Yeniden başlatma masaüstü uygulamasında çalışır'))
elements.checkUpdateButton.addEventListener('click', async () => {
  if (!settingsApi) return showToast('Güncelleme denetimi masaüstü uygulamasında çalışır')
  renderUpdateStatus({ state: 'checking', message: 'Güncellemeler kontrol ediliyor…', percent: 0, canInstall: false })
  renderUpdateStatus(await settingsApi.checkUpdates())
})
elements.installUpdateButton.addEventListener('click', () => settingsApi?.installUpdate())
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

void loadSettings().catch((error) => {
  elements.serverLabel.textContent = 'Bilgiler alınamadı'
  elements.sidebarStatus.classList.add('is-offline')
  renderAccount({ authenticated: false, devices: [], error: error?.message || 'Ayarlar yüklenemedi.' })
})
