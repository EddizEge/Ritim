const { Notification } = require('electron')
const { autoUpdater } = require('electron-updater')
const log = require('electron-log')

function createUpdateController({ app, broadcast, beforeInstall }) {
  let installStarted = false
  let status = {
    state: app.isPackaged ? 'idle' : 'development',
    message: app.isPackaged ? 'Güncellemeler GitHub Releases üzerinden denetlenir.' : 'Güncelleme denetimi paketlenmiş uygulamada çalışır.',
    currentVersion: app.getVersion(), availableVersion: '', percent: 0, canInstall: false,
  }
  const publish = (patch) => {
    status = { ...status, ...patch }
    broadcast?.(status)
    return status
  }
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  // A normal app close must not race an already-started NSIS installer.
  // Updates are installed only through the explicit "restart and install" action.
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.disableWebInstaller = true
  autoUpdater.on('checking-for-update', () => publish({ state: 'checking', message: 'Güncellemeler kontrol ediliyor…', percent: 0, canInstall: false }))
  autoUpdater.on('update-available', (info) => publish({ state: 'downloading', message: `Ritim ${info.version} indiriliyor…`, availableVersion: info.version, percent: 0 }))
  autoUpdater.on('download-progress', (progress) => publish({ state: 'downloading', message: `Ritim ${status.availableVersion || 'güncellemesi'} indiriliyor… %${Math.round(progress.percent)}`, percent: Math.round(progress.percent) }))
  autoUpdater.on('update-not-available', () => publish({ state: 'current', message: `Ritim ${app.getVersion()} güncel.`, availableVersion: '', percent: 100, canInstall: false }))
  autoUpdater.on('update-downloaded', (info) => {
    publish({ state: 'ready', message: `Ritim ${info.version} hazır. Yeniden başlatıp kurabilirsin.`, availableVersion: info.version, percent: 100, canInstall: true })
    if (Notification.isSupported()) new Notification({ title: 'Ritim güncellemesi hazır', body: `${info.version} sürümünü kurmak için Ayarlar’ı aç.` }).show()
  })
  autoUpdater.on('error', (error) => {
    log.error('[Ritim Updater]', error)
    publish({ state: 'error', message: 'Güncelleme sunucusuna şu anda ulaşılamıyor.', percent: 0, canInstall: false })
  })
  return {
    getStatus: () => status,
    check: async () => {
      if (!app.isPackaged) return publish({ state: 'development', message: 'Güncelleme denetimi paketlenmiş uygulamada çalışır.' })
      if (status.state === 'checking' || status.state === 'downloading') return status
      try { await autoUpdater.checkForUpdates() }
      catch (error) {
        log.error('[Ritim Updater] check failed', error)
        return publish({ state: 'error', message: 'GitHub sürüm bilgisi alınamadı.', percent: 0, canInstall: false })
      }
      return status
    },
    install: async () => {
      if (!status.canInstall || installStarted) return false
      installStarted = true
      publish({ state: 'installing', message: 'Ritim kapatılıyor ve güncelleme hazırlanıyor…', canInstall: false })
      try {
        await beforeInstall?.()
        autoUpdater.quitAndInstall(false, true)
        return true
      } catch (error) {
        installStarted = false
        log.error('[Ritim Updater] install preparation failed', error)
        publish({ state: 'error', message: 'Güncelleme kuruluma hazırlanamadı. Ritim’i yeniden başlatıp tekrar dene.', canInstall: true })
        return false
      }
    },
  }
}

module.exports = { createUpdateController }
