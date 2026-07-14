import { useCallback, useEffect, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { isNativeMobile } from '../mobileConfig'

const repository = import.meta.env.VITE_GITHUB_REPOSITORY || 'EddizEge/Ritim'

function versionParts(value: string) {
  return value.replace(/^v/i, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
}

function isNewerVersion(latest: string, current: string) {
  const left = versionParts(latest)
  const right = versionParts(current)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) > (right[index] || 0)) return true
    if ((left[index] || 0) < (right[index] || 0)) return false
  }
  return false
}

export function useMobileUpdate() {
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [availableVersion, setAvailableVersion] = useState('')

  const check = useCallback(async () => {
    if (!isNativeMobile) return 'Güncelleme denetimi Android uygulamasında çalışır.'
    setChecking(true)
    try {
      const appInfo = await CapacitorApp.getInfo()
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
      if (!response.ok) throw new Error(`GitHub ${response.status}`)
      const release = await response.json() as { tag_name?: string; html_url?: string; assets?: Array<{ name: string; browser_download_url: string }> }
      const latest = String(release.tag_name || '').replace(/^v/i, '')
      if (!latest || !isNewerVersion(latest, appInfo.version)) {
        setDownloadUrl('')
        setAvailableVersion('')
        const nextMessage = `Ritim ${appInfo.version} güncel.`
        setMessage(nextMessage)
        return nextMessage
      }
      const apk = release.assets?.find((asset) => asset.name.toLocaleLowerCase('tr').endsWith('.apk'))
      setDownloadUrl(apk?.browser_download_url || release.html_url || '')
      setAvailableVersion(latest)
      const nextMessage = `Ritim ${latest} Android güncellemesi hazır.`
      setMessage(nextMessage)
      return nextMessage
    } catch {
      const nextMessage = 'GitHub güncelleme bilgisine ulaşılamadı.'
      setMessage(nextMessage)
      return nextMessage
    } finally {
      setChecking(false)
    }
  }, [])

  const openUpdate = useCallback(async () => {
    if (!downloadUrl) return message || 'Yeni güncelleme bulunamadı.'
    await Browser.open({ url: downloadUrl })
    return `Ritim ${availableVersion} APK indirmesi açıldı. Android kurulum ekranında onayla.`
  }, [availableVersion, downloadUrl, message])

  useEffect(() => { if (isNativeMobile) void check() }, [check])
  return { checking, message, availableVersion, updateAvailable: Boolean(downloadUrl), check, openUpdate }
}
