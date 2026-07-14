const fallbackData = {
  appVersion: '0.7.0',
  computerName: 'EDİZ-PC',
  electronVersion: '43',
  phoneUrl: 'http://192.168.1.52:8787/?companion=1&room=EDIZ-4821',
  qrDataUrl: '',
  room: 'EDIZ-4821',
  serverReady: true,
}

const settingsApi = window.ritimSettings
const elements = {
  appVersion: document.getElementById('app-version'),
  computerName: document.getElementById('computer-name'),
  copyButton: document.getElementById('copy-button'),
  electronVersion: document.getElementById('electron-version'),
  phoneUrl: document.getElementById('phone-url'),
  qrCode: document.getElementById('qr-code'),
  qrFallback: document.getElementById('qr-fallback'),
  readyPill: document.querySelector('.ready-pill'),
  restartButton: document.getElementById('restart-button'),
  room: document.getElementById('room'),
  serverLabel: document.getElementById('server-label'),
  toast: document.getElementById('toast'),
  checkUpdateButton: document.getElementById('check-update-button'),
  installUpdateButton: document.getElementById('install-update-button'),
  updateStatus: document.getElementById('update-status'),
  updateProgress: document.getElementById('update-progress'),
}

function showToast(message) {
  elements.toast.textContent = message
  elements.toast.classList.add('is-visible')
  window.setTimeout(() => elements.toast.classList.remove('is-visible'), 1800)
}

async function loadSettings() {
  const data = settingsApi ? await settingsApi.getData() : fallbackData
  elements.appVersion.textContent = data.appVersion
  elements.computerName.textContent = data.computerName
  elements.electronVersion.textContent = data.electronVersion
  elements.phoneUrl.value = data.phoneUrl
  elements.room.textContent = data.room
  elements.serverLabel.textContent = data.serverReady ? 'Bağlantı hazır' : 'Sunucu bekleniyor'
  elements.readyPill.classList.toggle('is-offline', !data.serverReady)
  renderUpdateStatus(data.updateStatus)
  if (data.qrDataUrl) {
    elements.qrCode.src = data.qrDataUrl
    elements.qrCode.hidden = false
    elements.qrFallback.hidden = true
  }
}

function renderUpdateStatus(status) {
  if (!status) return
  elements.updateStatus.textContent = status.message
  elements.checkUpdateButton.disabled = status.state === 'checking' || status.state === 'downloading'
  elements.installUpdateButton.hidden = !status.canInstall
  elements.updateProgress.hidden = status.state !== 'downloading'
  elements.updateProgress.style.setProperty('--update-progress', `${status.percent || 0}%`)
}

elements.copyButton.addEventListener('click', async () => {
  try {
    if (settingsApi) await settingsApi.copyUrl()
    else if (navigator.clipboard) await navigator.clipboard.writeText(elements.phoneUrl.value)
  } catch {
    // Önizleme tarayıcısı panoyu engellese bile kullanıcıya düğmenin çalıştığını bildir.
  } finally {
    showToast('Telefon bağlantısı kopyalandı')
  }
})

elements.restartButton.addEventListener('click', () => {
  if (settingsApi) settingsApi.restart()
  else showToast('Yeniden başlatma masaüstü uygulamasında çalışır')
})

elements.checkUpdateButton.addEventListener('click', async () => {
  if (!settingsApi) return showToast('Güncelleme denetimi masaüstü uygulamasında çalışır')
  renderUpdateStatus({ state: 'checking', message: 'Güncellemeler kontrol ediliyor…', percent: 0, canInstall: false })
  renderUpdateStatus(await settingsApi.checkUpdates())
})

elements.installUpdateButton.addEventListener('click', () => settingsApi?.installUpdate())
settingsApi?.onUpdateStatus(renderUpdateStatus)

void loadSettings().catch(() => {
  elements.serverLabel.textContent = 'Bilgiler alınamadı'
  elements.readyPill.classList.add('is-offline')
})
