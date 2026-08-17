import { useCallback, useEffect, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { isNativeMobile } from '../mobileConfig'
import { acceptsPrereleaseUpdates, compareRitimVersions, isNewerRitimVersion, parseRitimVersion } from '../versioning'

const repository = import.meta.env.VITE_GITHUB_REPOSITORY || 'EddizEge/Ritim'

type GitHubRelease = {
  tag_name?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  assets?: Array<{ name: string; browser_download_url: string }>
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
      const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=20`, { headers: { Accept: 'application/vnd.github+json' } })
      if (!response.ok) throw new Error(`GitHub ${response.status}`)
      const allowPrerelease = acceptsPrereleaseUpdates(appInfo.version)
      const releases = await response.json() as GitHubRelease[]
      const release = releases
        .filter((candidate) => {
          const version = String(candidate.tag_name || '').replace(/^v/i, '')
          return !candidate.draft
            && Boolean(parseRitimVersion(version))
            && (!candidate.prerelease || allowPrerelease)
            && isNewerRitimVersion(version, appInfo.version)
        })
        .sort((left, right) => {
          const leftVersion = String(left.tag_name || '').replace(/^v/i, '')
          const rightVersion = String(right.tag_name || '').replace(/^v/i, '')
          return -compareRitimVersions(leftVersion, rightVersion)
        })[0]
      const latest = String(release?.tag_name || '').replace(/^v/i, '')
      if (!latest) {
        setDownloadUrl('')
        setAvailableVersion('')
        const nextMessage = `Ritim ${appInfo.version} güncel.`
        setMessage(nextMessage)
        return nextMessage
      }
      const apk = release?.assets?.find((asset) => asset.name.toLocaleLowerCase('tr').endsWith('.apk'))
      setDownloadUrl(apk?.browser_download_url || release?.html_url || '')
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
