import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { DesktopApp } from './components/DesktopApp'
import { MobileApp } from './components/MobileApp'
import { usePlayerSync } from './hooks/usePlayerSync'
import { useNativeMediaSession } from './hooks/useNativeMediaSession'
import { useYouTubeLibrary } from './hooks/useYouTubeLibrary'
import { App as CapacitorApp } from '@capacitor/app'
import { NativePairing } from './components/NativePairing'
import {
  clearMobilePairing,
  clearMobilePairingCaches,
  classifyMobilePairingChange,
  createPairingMutationQueue,
  isNativeMobile,
  parsePairingLink,
  readMobilePairing,
  saveMobilePairing,
  webDevelopmentPairing,
  type MobilePairingConfig,
} from './mobileConfig'
import { getTrack } from './data'
import { configuredSocialUrl, useSocial } from './hooks/useSocial'
import { useSocialAccount } from './hooks/useSocialAccount'
import { clearSocialIdentityForPairingReset, signOutExistingSocialSession } from './social/auth'
import { AppearanceProvider, useAppearance } from './appearanceContext'
import { readAppearancePreferences, writeAppearancePreferences } from './appearancePreferences'

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

function RitimApp({ isCompanion, pairing, onRefreshPairing, onRemovePairing }: {
  isCompanion: boolean
  pairing: MobilePairingConfig
  onRefreshPairing: (pairing: MobilePairingConfig) => Promise<MobilePairingConfig | null>
  onRemovePairing: () => Promise<void>
}) {
  const player = usePlayerSync(isCompanion, pairing)
  const { preferences: appearance } = useAppearance()
  useNativeMediaSession(player.state, player.actions, player.connected, appearance.artwork)
  const youtube = useYouTubeLibrary()
  const track = getTrack(player.state)
  const social = useSocial({
    displayName: player.state.accountProfile?.displayName || youtube.status.channelTitle,
    avatarUrl: player.state.accountProfile?.avatarUrl,
    isCompanion,
    pairing,
    currentTrack: {
      id: track.id,
      videoId: track.youtubeVideoId,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      position: player.state.position,
      cover: track.cover,
      thumbnailUrl: track.thumbnailUrl,
      isPlaying: player.state.isPlaying,
    },
  })
  const socialUrl = configuredSocialUrl(pairing.syncUrl)
  const socialAccount = useSocialAccount({
    pairing,
    socialUrl,
    isCompanion,
  })
  const props = { ...player }
  return isCompanion
    ? <MobileApp state={player.state} actions={player.actions} connected={player.connected} peerCount={player.peerCount} room={player.room} pairingError={player.pairingError} syncHealth={player.syncHealth} socialState={social.state} socialActions={social.actions} socialAccount={socialAccount.state} socialAccountActions={socialAccount.actions} pairing={pairing} onRefreshPairing={onRefreshPairing} onRemovePairing={onRemovePairing} />
    : <DesktopApp {...props} youtube={youtube} socialState={social.state} socialActions={social.actions} />
}

export default function App() {
  const responsiveCompanion = useCompanionMode()
  const companion = isNativeMobile || responsiveCompanion
  const [pairing, setPairing] = useState<MobilePairingConfig | null | undefined>(undefined)
  const [appearance, setAppearance] = useState(readAppearancePreferences)
  const pairingMutationRef = useRef(createPairingMutationQueue())

  const enqueuePairingMutation = useCallback(function enqueue<T>(operation: () => Promise<T>) {
    return pairingMutationRef.current.run(operation)
  }, [])

  const updateAppearance = useCallback((patch: Partial<typeof appearance>) => {
    setAppearance((current) => writeAppearancePreferences({ ...current, ...patch }))
  }, [])

  const applyIncomingPairing = useCallback(async (
    incoming: MobilePairingConfig,
    canUpdateState: () => boolean = () => true,
  ): Promise<MobilePairingConfig | null> => {
    let current: MobilePairingConfig | null = null
    try {
      current = await readMobilePairing()
      const change = classifyMobilePairingChange(current, incoming)
      if (change === 'unchanged') return current

      if (change === 'switch_computer') {
        const confirmed = window.confirm(`${current?.computerName || 'Mevcut PC'} eşlemesi kaldırılıp ${incoming.computerName} bağlansın mı? Eski Ritim oturumu ve çevrimdışı müzik önbelleği temizlenecek.`)
        if (!confirmed) return null
      } else if (change === 'same_computer_reauthorization') {
        const confirmed = window.confirm(`${current?.computerName || incoming.computerName} eşleme anahtarı veya oda bilgisi değişmiş. Bu PC ile güvenli bağlantı yenilensin mi? Ritim hesabın ve çevrimdışı müzik önbelleğin korunacak.`)
        if (!confirmed) return null
      }

      const saved = await saveMobilePairing(incoming)
      if (change === 'switch_computer') {
        if (canUpdateState()) flushSync(() => setPairing(undefined))
        void signOutExistingSocialSession({
          socialUrl: configuredSocialUrl(current?.syncUrl || incoming.syncUrl),
        }).catch((error) => console.warn('[Ritim] Eski PC sosyal oturumu kapatılamadı:', error))
        clearMobilePairingCaches()
        await clearSocialIdentityForPairingReset()
      }
      if (canUpdateState()) setPairing(saved)
      return saved
    } catch (error) {
      if (canUpdateState() && current) setPairing(current)
      throw error
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.ritimTheme = companion ? appearance.theme : 'system'
    root.dataset.ritimDensity = companion ? appearance.density : 'comfortable'
    root.dataset.ritimMotion = companion ? appearance.motion : 'system'
    root.dataset.ritimArtwork = companion ? appearance.artwork : 'full'
    root.style.colorScheme = companion
      ? (appearance.theme === 'system' ? 'light dark' : 'dark')
      : 'dark'
  }, [appearance, companion])

  useEffect(() => {
    let disposed = false
    const processUrl = async (value?: string) => {
      if (!value) return null
      try {
        const incoming = parsePairingLink(value)
        return await enqueuePairingMutation(() => applyIncomingPairing(incoming, () => !disposed))
      } catch (error) {
        console.warn('[Ritim] Telefon eşlemesi değiştirilemedi:', error)
        return null
      }
    }
    let removeListener: (() => Promise<void>) | undefined
    void (async () => {
      let initial: MobilePairingConfig | null = null
      if (isNativeMobile) {
        const launch = await CapacitorApp.getLaunchUrl().catch(() => undefined)
        initial = await processUrl(launch?.url)
      }
      if (!initial) initial = await enqueuePairingMutation(() => readMobilePairing())
      if (!initial && !isNativeMobile) initial = webDevelopmentPairing()
      if (!disposed) setPairing(initial)
    })().catch((error) => {
      console.warn('[Ritim] Kayıtlı telefon eşlemesi okunamadı:', error)
      if (!disposed) setPairing(null)
    })
    if (isNativeMobile) {
      void CapacitorApp.addListener('appUrlOpen', ({ url }) => { void processUrl(url) })
        .then((handle) => {
          if (disposed) void handle.remove()
          else removeListener = () => handle.remove()
        })
        .catch((error) => console.warn('[Ritim] Uygulama bağlantı dinleyicisi açılamadı:', error))
    }
    return () => {
      disposed = true
      void removeListener?.()
    }
  }, [applyIncomingPairing, enqueuePairingMutation])

  const acceptPairing = useCallback((next: MobilePairingConfig) => (
    enqueuePairingMutation(() => applyIncomingPairing(next))
  ), [applyIncomingPairing, enqueuePairingMutation])

  const removePairing = async () => {
    await enqueuePairingMutation(async () => {
      const current = await readMobilePairing()
      try {
        flushSync(() => setPairing(undefined))
        if (current) {
          void signOutExistingSocialSession({
            socialUrl: configuredSocialUrl(current.syncUrl),
          }).catch((error) => console.warn('[Ritim] Eski PC sosyal oturumu kapatılamadı:', error))
        }
        await clearMobilePairing()
        await clearSocialIdentityForPairingReset()
        setPairing(null)
      } catch (error) {
        if (current) setPairing(current)
        throw error
      }
    })
  }

  if (pairing === undefined) {
    return <main className="native-pairing-shell"><section className="native-pairing-card"><p>Ritim bağlantısı hazırlanıyor…</p></section></main>
  }
  if (isNativeMobile && !pairing) return <NativePairing onPaired={acceptPairing} />
  if (!pairing) return null
  const pairingKey = `${pairing.syncUrl}|${pairing.room}|${pairing.token}|${pairing.installationId}`
  return (
    <AppearanceProvider active={companion} preferences={appearance} update={updateAppearance}>
      <RitimApp key={pairingKey} isCompanion={companion} pairing={pairing} onRefreshPairing={acceptPairing} onRemovePairing={removePairing} />
    </AppearanceProvider>
  )
}
