const { Notification } = require('electron')
const log = require('electron-log')
const { updateChannel } = require('./version-policy.cjs')

function createUpdateController({
  app,
  broadcast,
  beforeInstall,
  updater,
  logger = log,
  NotificationClass = Notification,
  now = () => new Date(),
}) {
  const activeUpdater = updater || require('electron-updater').autoUpdater
  let installStarted = false
  let installRecoveryTimer
  let readyStatusBeforeInstall
  const updateChannelName = updateChannel(app.getVersion())
  let status = {
    state: app.isPackaged ? 'idle' : 'development',
    message: app.isPackaged ? 'Güncellemeler GitHub Releases üzerinden denetlenir.' : 'Güncelleme denetimi paketlenmiş uygulamada çalışır.',
    currentVersion: app.getVersion(), availableVersion: '', channel: updateChannelName,
    lastCheckedAt: '', percent: 0, downloadedBytes: 0, totalBytes: 0,
    canDownload: false, canInstall: false,
  }
  const publish = (patch) => {
    status = { ...status, ...patch }
    broadcast?.(status)
    return status
  }
  activeUpdater.logger = logger
  const setProviderChannel = (channel, allowPrerelease) => {
    activeUpdater.channel = channel
    activeUpdater.allowPrerelease = allowPrerelease
    // electron-updater's channel setter re-enables downgrades. Ritim never does.
    activeUpdater.allowDowngrade = false
  }
  setProviderChannel(updateChannelName, updateChannelName !== 'latest')
  // Setting a custom channel enables downgrade support inside electron-updater.
  // Ritim channels may advance to a stable release, but must never install an
  // older semantic version over the current app.
  activeUpdater.allowDowngrade = false
  activeUpdater.autoDownload = false
  // A normal app close must not race an already-started NSIS installer.
  // Updates are installed only through the explicit "restart and install" action.
  activeUpdater.autoInstallOnAppQuit = false
  activeUpdater.autoRunAppAfterInstall = true
  activeUpdater.disableWebInstaller = true
  activeUpdater.on('checking-for-update', () => publish({
    state: 'checking', message: 'Güncellemeler kontrol ediliyor…',
    lastCheckedAt: now().toISOString(), percent: 0, downloadedBytes: 0, totalBytes: 0,
    canDownload: false, canInstall: false,
  }))
  activeUpdater.on('update-available', (info) => publish({
    state: 'available', message: `Ritim ${info.version} indirilmeye hazır.`,
    availableVersion: info.version, percent: 0, downloadedBytes: 0, totalBytes: 0,
    canDownload: true, canInstall: false,
  }))
  activeUpdater.on('download-progress', (progress) => publish({
    state: 'downloading',
    message: `Ritim ${status.availableVersion || 'güncellemesi'} indiriliyor… %${Math.round(progress.percent)}`,
    percent: Math.round(progress.percent), downloadedBytes: Number(progress.transferred) || 0,
    totalBytes: Number(progress.total) || 0, canDownload: false, canInstall: false,
  }))
  activeUpdater.on('update-not-available', () => publish({
    state: 'current', message: `Ritim ${app.getVersion()} güncel.`, availableVersion: '',
    percent: 100, downloadedBytes: 0, totalBytes: 0, canDownload: false, canInstall: false,
  }))
  activeUpdater.on('update-downloaded', (info) => {
    publish({
      state: 'ready', message: `Ritim ${info.version} hazır. Yeniden başlatıp kurabilirsin.`,
      availableVersion: info.version, percent: 100, downloadedBytes: status.totalBytes,
      canDownload: false, canInstall: true,
    })
    if (NotificationClass?.isSupported?.()) {
      new NotificationClass({ title: 'Ritim güncellemesi hazır', body: `${info.version} sürümünü kurmak için Ayarlar’ı aç.` }).show()
    }
  })
  activeUpdater.on('error', (error) => {
    logger.error('[Ritim Updater]', error)
    if (installStarted && readyStatusBeforeInstall) {
      installStarted = false
      if (installRecoveryTimer) clearTimeout(installRecoveryTimer)
      installRecoveryTimer = undefined
      publish({
        ...readyStatusBeforeInstall,
        state: 'ready',
        message: 'Güncelleme kurucusu başlatılamadı. Ritim açık kaldı; tekrar deneyebilirsin.',
        canDownload: false,
        canInstall: true,
      })
      return
    }
    publish({ state: 'error', message: 'Güncelleme sunucusuna şu anda ulaşılamıyor.', percent: 0, canDownload: false, canInstall: false })
  })
  const checkForUpdatesByChannelPolicy = async () => {
    if (updateChannelName !== 'rc') return activeUpdater.checkForUpdates()

    // GitHubProvider treats RC as a custom channel. Check it first so RC-to-RC
    // updates work, then explicitly check stable without ever admitting Beta.
    setProviderChannel('rc', true)
    let rcResult
    let rcError
    try { rcResult = await activeUpdater.checkForUpdates() }
    catch (error) { rcError = error }
    if (rcResult?.isUpdateAvailable === true || status.state === 'available') return rcResult

    setProviderChannel('latest', false)
    try {
      const stableResult = await activeUpdater.checkForUpdates()
      if (stableResult?.isUpdateAvailable !== true && status.state !== 'available') {
        setProviderChannel('rc', true)
      }
      return stableResult
    } catch (stableError) {
      setProviderChannel('rc', true)
      throw stableError || rcError
    }
  }
  return {
    getStatus: () => status,
    check: async () => {
      if (!app.isPackaged) return publish({ state: 'development', message: 'Güncelleme denetimi paketlenmiş uygulamada çalışır.' })
      if (status.state === 'checking' || status.state === 'downloading' || status.state === 'installing' || status.state === 'ready') return status
      try { await checkForUpdatesByChannelPolicy() }
      catch (error) {
        logger.error('[Ritim Updater] check failed', error)
        return publish({ state: 'error', message: 'GitHub sürüm bilgisi alınamadı.', lastCheckedAt: now().toISOString(), percent: 0, canDownload: false, canInstall: false })
      }
      return status
    },
    download: async () => {
      if (!app.isPackaged || !status.canDownload || status.state === 'downloading') return status
      publish({ state: 'downloading', message: `Ritim ${status.availableVersion} indiriliyor…`, percent: 0, downloadedBytes: 0, totalBytes: 0, canDownload: false })
      try { await activeUpdater.downloadUpdate() }
      catch (error) {
        logger.error('[Ritim Updater] download failed', error)
        return publish({ state: 'error', message: 'Güncelleme indirilemedi. Tekrar deneyebilirsin.', percent: 0, canDownload: true, canInstall: false })
      }
      return status
    },
    install: async () => {
      if (!status.canInstall || installStarted) return false
      installStarted = true
      readyStatusBeforeInstall = { ...status }
      publish({ state: 'installing', message: 'Ritim kapatılıyor ve güncelleme hazırlanıyor…', canInstall: false })
      try {
        await beforeInstall?.()
        activeUpdater.quitAndInstall(false, true)
        if (!installStarted) return false
        // quitAndInstall() is a void API. If the process is still alive and no
        // updater error arrives, restore a retryable UI instead of stranding it.
        installRecoveryTimer = setTimeout(() => {
          if (!installStarted || !readyStatusBeforeInstall) return
          installStarted = false
          publish({
            ...readyStatusBeforeInstall,
            state: 'ready',
            message: 'Güncelleme kurucusu başlamadı. Ritim açık kaldı; tekrar deneyebilirsin.',
            canDownload: false,
            canInstall: true,
          })
        }, 8_000)
        installRecoveryTimer.unref?.()
        return true
      } catch (error) {
        installStarted = false
        if (installRecoveryTimer) clearTimeout(installRecoveryTimer)
        installRecoveryTimer = undefined
        logger.error('[Ritim Updater] install preparation failed', error)
        publish({
          ...readyStatusBeforeInstall,
          state: 'ready',
          message: 'Güncelleme kuruluma hazırlanamadı. Ritim açık kaldı; tekrar deneyebilirsin.',
          canDownload: false,
          canInstall: true,
        })
        return false
      }
    },
  }
}

module.exports = { createUpdateController }
