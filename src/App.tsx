import { useEffect, useState } from 'react'
import { DesktopApp } from './components/DesktopApp'
import { MobileApp } from './components/MobileApp'
import { usePlayerSync } from './hooks/usePlayerSync'
import { useYouTubeLibrary } from './hooks/useYouTubeLibrary'
import { App as CapacitorApp } from '@capacitor/app'
import { NativePairing } from './components/NativePairing'
import { isNativeMobile, parsePairingLink, readMobilePairing, saveMobilePairing } from './mobileConfig'

function useCompanionMode() {
  const forced = new URLSearchParams(window.location.search).get('companion') === '1'
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const update = () => setIsNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return forced || isNarrow
}

function RitimApp({ isCompanion }: { isCompanion: boolean }) {
  const player = usePlayerSync(isCompanion)
  const youtube = useYouTubeLibrary()
  const props = { ...player }
  return isCompanion
    ? <MobileApp state={player.state} actions={player.actions} connected={player.connected} peerCount={player.peerCount} room={player.room} pairingError={player.pairingError} />
    : <DesktopApp {...props} youtube={youtube} />
}

export default function App() {
  const responsiveCompanion = useCompanionMode()

  useEffect(() => {
    if (!isNativeMobile) return
    const acceptUrl = (value?: string) => {
      if (!value) return
      try {
        saveMobilePairing(parsePairingLink(value))
        window.location.reload()
      } catch {}
    }
    let removeListener: (() => Promise<void>) | undefined
    void CapacitorApp.getLaunchUrl().then((launch) => acceptUrl(launch?.url))
    void CapacitorApp.addListener('appUrlOpen', ({ url }) => acceptUrl(url)).then((handle) => { removeListener = () => handle.remove() })
    return () => { void removeListener?.() }
  }, [])

  if (isNativeMobile && !readMobilePairing()) return <NativePairing />
  return <RitimApp isCompanion={isNativeMobile || responsiveCompanion} />
}
