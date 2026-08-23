import { useCallback, useEffect, useRef, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import packageMetadata from '../../package.json'
import { isNativeMobile } from '../mobileConfig'
import { RitimUpdate, type NativeUpdateDownload } from '../nativeUpdate'
import { isNewerRitimVersion } from '../versioning'
import {
  githubReleasesApiUrl,
  acceptsReleaseForChannel,
  mobileUpdateChannel,
  normalizeGitHubRepository,
  safeMobileUpdateAssetUrl,
  selectMobileRelease,
  type GitHubRelease,
  type MobileUpdateStatus,
} from '../mobileUpdatePolicy'

const repository = normalizeGitHubRepository(import.meta.env.VITE_GITHUB_REPOSITORY || 'EddizEge/Ritim')

export function useMobileUpdate() {
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [availableVersion, setAvailableVersion] = useState('')
  const [currentVersion, setCurrentVersion] = useState(packageMetadata.version)
  const [channel, setChannel] = useState(mobileUpdateChannel(packageMetadata.version))
  const [lastCheckedAt, setLastCheckedAt] = useState('')
  const [status, setStatus] = useState<MobileUpdateStatus>(isNativeMobile ? 'idle' : 'development')
  const [percent, setPercent] = useState(0)
  const [downloadedBytes, setDownloadedBytes] = useState(0)
  const [totalBytes, setTotalBytes] = useState(0)
  const checkSequenceRef = useRef(0)
  const checkAbortRef = useRef<AbortController | null>(null)

  const applyNativeDownload = useCallback((download: NativeUpdateDownload) => {
    if (download.version) setAvailableVersion(download.version)
    setPercent(Math.max(0, Math.min(100, Number(download.percent) || 0)))
    setDownloadedBytes(Math.max(0, Number(download.downloadedBytes) || 0))
    setTotalBytes(Math.max(0, Number(download.totalBytes) || 0))
    if (download.status === 'downloaded') {
      setStatus('downloaded')
      setMessage('Ritim APK indirildi. Android kurulum ekranını açabilirsin.')
      return true
    }
    if (download.status === 'pending' || download.status === 'downloading' || download.status === 'paused') {
      setStatus('downloading')
      setMessage(download.status === 'paused' ? 'Android indirmeyi duraklattı; ağ bağlantısını kontrol et.' : 'Ritim APK Android tarafından indiriliyor…')
      return true
    }
    if (download.status === 'error') {
      setStatus('error')
      setMessage(`Android APK indirmesini tamamlayamadı${download.reason ? ` (kod ${download.reason})` : ''}.`)
      return true
    }
    if (download.status === 'idle') {
      setStatus('idle')
      setMessage('Android indirme kaydı kaldırıldı; güncelleme yeniden denetleniyor…')
    }
    return false
  }, [])

  const check = useCallback(async () => {
    if (!isNativeMobile) {
      setStatus('development')
      return 'Güncelleme denetimi Android uygulamasında çalışır.'
    }
    const sequence = checkSequenceRef.current + 1
    checkSequenceRef.current = sequence
    checkAbortRef.current?.abort()
    const controller = new AbortController()
    checkAbortRef.current = controller
    const isCurrent = () => checkSequenceRef.current === sequence && !controller.signal.aborted
    setChecking(true)
    setStatus('checking')
    try {
      const appInfo = await CapacitorApp.getInfo()
      if (!isCurrent()) return 'Daha yeni güncelleme denetimi kullanılıyor.'
      setCurrentVersion(appInfo.version)
      setChannel(mobileUpdateChannel(appInfo.version))
      setLastCheckedAt(new Date().toISOString())
      const releases: GitHubRelease[] = []
      for (let page = 1; page <= 5; page += 1) {
        const response = await fetch(githubReleasesApiUrl(repository, page), {
          headers: { Accept: 'application/vnd.github+json' },
          signal: controller.signal,
        })
        if (!isCurrent()) return 'Daha yeni güncelleme denetimi kullanılıyor.'
        if (!response.ok) throw new Error(`GitHub ${response.status}`)
        const pageReleases = await response.json()
        if (!isCurrent()) return 'Daha yeni güncelleme denetimi kullanılıyor.'
        if (!Array.isArray(pageReleases)) throw new Error('GitHub yayın yanıtı geçersiz.')
        releases.push(...pageReleases as GitHubRelease[])
        if (pageReleases.length < 100) break
      }
      const release = selectMobileRelease(releases, appInfo.version)
      const latest = String(release?.tag_name || '').replace(/^v/i, '')
      if (!latest) {
        setDownloadUrl('')
        setAvailableVersion('')
        setStatus('current')
        const nextMessage = `Ritim ${appInfo.version} güncel.`
        setMessage(nextMessage)
        return nextMessage
      }
      const canonicalApkName = `ritim-android-v${latest}.apk`.toLocaleLowerCase('en-US')
      const safeApkUrl = (release?.assets || [])
        .filter((asset) => asset.name.toLocaleLowerCase('en-US') === canonicalApkName)
        .map((asset) => safeMobileUpdateAssetUrl(asset.browser_download_url, repository, latest))
        .find(Boolean) || ''
      if (!safeApkUrl) throw new Error('Yayında güvenli Ritim APK dosyası bulunamadı.')
      setDownloadUrl(safeApkUrl)
      setAvailableVersion(latest)
      setStatus('available')
      setPercent(0)
      setDownloadedBytes(0)
      setTotalBytes(0)
      const nextMessage = `Ritim ${latest} Android güncellemesi hazır.`
      setMessage(nextMessage)
      return nextMessage
    } catch (error) {
      if (!isCurrent() || (error instanceof DOMException && error.name === 'AbortError')) {
        return 'Daha yeni güncelleme denetimi kullanılıyor.'
      }
      setStatus('error')
      const nextMessage = error instanceof Error && /güvenli Ritim APK/i.test(error.message)
        ? error.message
        : 'GitHub güncelleme bilgisine ulaşılamadı.'
      setMessage(nextMessage)
      return nextMessage
    } finally {
      if (isCurrent()) {
        setChecking(false)
        checkAbortRef.current = null
      }
    }
  }, [])

  const openUpdate = useCallback(async () => {
    if (status === 'downloaded') {
      setStatus('installing')
      try {
        const result = await RitimUpdate.install()
        setStatus('downloaded')
        const nextMessage = result.openedSettings
          ? 'Önce “Bu kaynaktan izin ver” seçeneğini aç; sonra Ritim’e dönüp kurulumu tekrar başlat.'
          : 'Android kurulum ekranı açıldı. Mevcut Ritim verileri korunarak güncellemeyi onayla.'
        setMessage(nextMessage)
        return nextMessage
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : ''
        const invalidApk = code === 'UPDATE_APK_INVALID'
        setStatus(invalidApk ? 'available' : 'downloaded')
        if (invalidApk) {
          setPercent(0)
          setDownloadedBytes(0)
          setTotalBytes(0)
        }
        const nextMessage = error instanceof Error ? error.message : 'Android kurulum ekranı açılamadı.'
        const recoverableMessage = invalidApk
          ? 'APK güvenlik doğrulamasından geçmedi ve temizlendi. Güncellemeyi yeniden indirebilirsin.'
          : nextMessage
        setMessage(recoverableMessage)
        return recoverableMessage
      }
    }
    if (!downloadUrl) return message || 'Yeni güncelleme bulunamadı.'
    setStatus('downloading')
    setMessage(`Ritim ${availableVersion} APK indiriliyor…`)
    try {
      const result = await RitimUpdate.start({ url: downloadUrl, fileName: `Ritim-${availableVersion}.apk`, version: availableVersion })
      if (!result.version || result.version !== availableVersion) {
        await RitimUpdate.clear()
        throw new Error('Android indirme kaydı hedef Ritim sürümüyle eşleşmiyor.')
      }
      applyNativeDownload(result)
      return `Ritim ${availableVersion} APK indirmesi Android indirme yöneticisinde başladı.`
    } catch (error) {
      setStatus('available')
      const nextMessage = error instanceof Error ? error.message : 'APK indirmesi başlatılamadı.'
      setMessage(nextMessage)
      return nextMessage
    }
  }, [applyNativeDownload, availableVersion, downloadUrl, message, status])

  useEffect(() => {
    if (!isNativeMobile) return
    let disposed = false
    void Promise.all([RitimUpdate.status(), CapacitorApp.getInfo()])
      .then(async ([download, appInfo]) => {
        if (disposed) return
        if (download.status !== 'idle' && (!download.version
          || !isNewerRitimVersion(download.version, appInfo.version)
          || !acceptsReleaseForChannel(download.version, appInfo.version))) {
          await RitimUpdate.clear()
          if (!disposed) await check()
          return
        }
        if (applyNativeDownload(download)) return
        await check()
      })
      .catch(() => { if (!disposed) void check() })
    return () => { disposed = true }
  }, [applyNativeDownload, check])

  useEffect(() => () => {
    checkSequenceRef.current += 1
    checkAbortRef.current?.abort()
    checkAbortRef.current = null
  }, [])

  useEffect(() => {
    if (!isNativeMobile || status !== 'downloading') return
    let disposed = false
    const refresh = () => void RitimUpdate.status()
      .then((download) => {
        if (disposed) return
        if (!applyNativeDownload(download)) void check()
      })
      .catch(() => {})
    const timer = window.setInterval(refresh, 1_000)
    refresh()
    return () => { disposed = true; window.clearInterval(timer) }
  }, [applyNativeDownload, check, status])

  return {
    checking,
    status,
    message,
    currentVersion,
    availableVersion,
    channel,
    lastCheckedAt,
    percent,
    downloadedBytes,
    totalBytes,
    updateAvailable: Boolean(downloadUrl) || status === 'downloading' || status === 'downloaded' || status === 'installing',
    downloadManagedByAndroid: true,
    check,
    openUpdate,
  }
}
