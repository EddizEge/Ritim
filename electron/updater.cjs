const { Notification } = require('electron')
const log = require('electron-log')
const { parseVersion, selectUpdateVersion, updateChannel } = require('./version-policy.cjs')

const RELEASE_TAG_PATTERN = /\/tag\/(v?[^/]+)$/

// electron-updater's GitHubProvider walks the release feed in date order and
// treats RC as a custom channel: a Beta client never sees an RC and an Alpha
// client stops at the first entry. Ritim instead takes the highest release the
// current channel accepts (version-policy.cjs) and reads that release's own
// update file (alpha.yml, beta.yml, rc.yml or latest.yml), so release asset
// names stay unchanged. Stable clients keep the stock /releases/latest path.
function createChannelPolicyProviderClass() {
  const updaterRoot = require.resolve('electron-updater')
  const { GitHubProvider, computeReleaseNotes } = require('electron-updater/out/providers/GitHubProvider')
  const { parseUpdateInfo } = require('electron-updater/out/providers/Provider')
  const { getChannelFilename, newUrlFromBase } = require('electron-updater/out/util')
  const { CancellationToken, HttpError, newError, parseXml } = require(require.resolve('builder-util-runtime', { paths: [updaterRoot] }))

  return class RitimGitHubProvider extends GitHubProvider {
    async getLatestVersion() {
      const currentVersion = this.updater.currentVersion.version
      if (updateChannel(currentVersion) === 'latest') return super.getLatestVersion()

      const cancellationToken = new CancellationToken()
      const feedXml = await this.httpRequest(newUrlFromBase(`${this.basePath}.atom`, this.baseUrl), {
        accept: 'application/xml, application/atom+xml, text/xml, */*',
      }, cancellationToken)
      let feed
      const entriesByVersion = new Map()
      try {
        feed = parseXml(feedXml)
        for (const entry of feed.getElements('entry')) {
          const match = RELEASE_TAG_PATTERN.exec(entry.element('link').attribute('href'))
          if (!match) continue
          try { entriesByVersion.set(parseVersion(match[1]).normalized, { tag: match[1], entry }) } catch {}
        }
      } catch (error) {
        throw newError(`Cannot parse releases feed: ${error.stack || error.message}`, 'ERR_UPDATER_INVALID_RELEASE_FEED')
      }

      let selected = entriesByVersion.get(selectUpdateVersion([...entriesByVersion.keys()], currentVersion))
      if (!selected) {
        // The feed lists only the newest releases; fall back to the stable one.
        const tag = await this.getLatestTagName(cancellationToken)
        if (tag) selected = { tag, entry: null }
      }
      if (!selected) throw newError('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS')

      const releaseVersion = parseVersion(selected.tag)
      const channelFile = getChannelFilename(this.getCustomChannelName(updateChannel(releaseVersion.normalized)))
      const channelFileUrl = newUrlFromBase(this.getBaseDownloadPath(selected.tag, channelFile), this.baseUrl)
      let rawData
      try {
        rawData = await this.executor.request(this.createRequestOptions(channelFileUrl), cancellationToken)
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 404) {
          throw newError(`Cannot find ${channelFile} in the release artifacts (${channelFileUrl}): ${error.stack || error.message}`, 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')
        }
        throw error
      }
      const result = parseUpdateInfo(rawData, channelFile, channelFileUrl)
      if (String(result.version || '').replace(/^v/i, '') !== releaseVersion.normalized) {
        throw newError(`${channelFile} version ${result.version} does not match release ${selected.tag}`, 'ERR_UPDATER_INVALID_UPDATE_INFO')
      }
      if (selected.entry && result.releaseName == null) result.releaseName = selected.entry.elementValueOrEmpty('title')
      if (selected.entry && result.releaseNotes == null) {
        result.releaseNotes = computeReleaseNotes(this.updater.currentVersion, this.updater.fullChangelog, feed, selected.entry)
      }
      return { tag: selected.tag, ...result }
    }
  }
}

// Replaces the provider that app-update.yml describes with the channel policy
// provider, keeping owner/repo/host from that file. Updaters without an on-disk
// config (tests, development) are left as they are.
async function installChannelPolicyProvider(updater) {
  if (typeof updater?.setFeedURL !== 'function' || !updater.configOnDisk?.value) return false
  const config = await updater.configOnDisk.value
  if (config?.provider !== 'github') return false
  updater.setFeedURL({ ...config, provider: 'custom', updateProvider: createChannelPolicyProviderClass() })
  return true
}

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
  let channelPolicyProvider
  const checkForUpdatesByChannelPolicy = async () => {
    channelPolicyProvider ||= installChannelPolicyProvider(activeUpdater).catch((error) => {
      channelPolicyProvider = undefined
      throw error
    })
    await channelPolicyProvider
    return activeUpdater.checkForUpdates()
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

module.exports = { createChannelPolicyProviderClass, createUpdateController, installChannelPolicyProvider }
