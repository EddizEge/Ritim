import { useCallback, useEffect, useState } from 'react'
import type { Track, YouTubePlaylist, YouTubeStatus } from '../types'

const unavailableStatus: YouTubeStatus = {
  available: false,
  configured: false,
  authenticated: false,
}

const devQuery = new URLSearchParams(window.location.search)
const mockEnabled = import.meta.env.DEV && devQuery.get('youtubeMock') === '1'
const setupMockEnabled = import.meta.env.DEV && devQuery.get('youtubeSetupMock') === '1'
const mockTracks: Track[] = mockEnabled ? [{
  id: 'yt:M7lc1UVf-VE',
  youtubeVideoId: 'M7lc1UVf-VE',
  title: 'YouTube Player API Demo',
  artist: 'Google for Developers',
  collection: 'Entegrasyon testi',
  duration: 34,
  cover: 0,
  thumbnailUrl: 'https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg',
  source: 'youtube',
}] : []

function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export type YouTubeLibraryController = {
  status: YouTubeStatus
  playlists: YouTubePlaylist[]
  tracks: Track[]
  sectionTitle: string
  loading: boolean
  error: string
  setupOpen: boolean
  setSetupOpen: (open: boolean) => void
  configureAndConnect: (credentials: { clientId: string; clientSecret?: string }) => Promise<void>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  loadPlaylist: (playlist: YouTubePlaylist) => Promise<void>
  search: (query: string) => Promise<void>
  openConsole: () => Promise<void>
}

export function useYouTubeLibrary(): YouTubeLibraryController {
  const api = window.ritimDesktop?.youtube
  const [status, setStatus] = useState<YouTubeStatus>(mockEnabled
    ? { available: true, configured: true, authenticated: true, channelTitle: 'Google for Developers' }
    : api || setupMockEnabled ? { ...unavailableStatus, available: true } : unavailableStatus)
  const [playlists, setPlaylists] = useState<YouTubePlaylist[]>(mockEnabled ? [{ id: 'mock', title: 'Entegrasyon testi', itemCount: 1, thumbnailUrl: mockTracks[0].thumbnailUrl }] : [])
  const [tracks, setTracks] = useState<Track[]>(mockTracks)
  const [sectionTitle, setSectionTitle] = useState(mockEnabled ? 'YouTube entegrasyon testi' : 'Beğendiğim videolar')
  const [loading, setLoading] = useState(Boolean(api) && !mockEnabled)
  const [error, setError] = useState('')
  const [setupOpen, setSetupOpen] = useState(false)

  const loadHome = useCallback(async () => {
    if (!api || mockEnabled) return
    const home = await api.home()
    setPlaylists(home.playlists)
    setTracks(home.tracks)
    setSectionTitle('Beğendiğim videolar')
  }, [api])

  useEffect(() => {
    let active = true
    if (!api) return
    api.status()
      .then(async (nextStatus) => {
        if (!active) return
        setStatus(nextStatus)
        if (nextStatus.authenticated) await loadHome()
      })
      .catch((reason) => active && setError(errorMessage(reason)))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [api, loadHome])

  const configureAndConnect = useCallback(async (credentials: { clientId: string; clientSecret?: string }) => {
    if (!api) return
    setLoading(true)
    setError('')
    try {
      await api.configure(credentials)
      const nextStatus = await api.signIn()
      setStatus(nextStatus)
      setSetupOpen(false)
      await loadHome()
    } catch (reason) {
      setError(errorMessage(reason))
      throw reason
    } finally {
      setLoading(false)
    }
  }, [api, loadHome])

  const connect = useCallback(async () => {
    if (!api) {
      if (setupMockEnabled) setSetupOpen(true)
      return
    }
    if (!status.configured) {
      setSetupOpen(true)
      return
    }
    setLoading(true)
    setError('')
    try {
      const nextStatus = await api.signIn()
      setStatus(nextStatus)
      await loadHome()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [api, loadHome, status.configured])

  const disconnect = useCallback(async () => {
    if (!api) return
    setLoading(true)
    setError('')
    try {
      setStatus(await api.signOut())
      setPlaylists([])
      setTracks([])
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [api])

  const loadPlaylist = useCallback(async (playlist: YouTubePlaylist) => {
    if (!api) return
    setLoading(true)
    setError('')
    try {
      setTracks(await api.playlist({ playlistId: playlist.id, title: playlist.title }))
      setSectionTitle(playlist.title)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [api])

  const search = useCallback(async (query: string) => {
    if (!api || !status.authenticated) return
    setLoading(true)
    setError('')
    try {
      setTracks(await api.search(query))
      setSectionTitle(`“${query.trim()}” sonuçları`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [api, status.authenticated])

  const openConsole = useCallback(async () => {
    await api?.openConsole()
  }, [api])

  return {
    status, playlists, tracks, sectionTitle, loading, error, setupOpen, setSetupOpen,
    configureAndConnect, connect, disconnect, loadPlaylist, search, openConsole,
  }
}
