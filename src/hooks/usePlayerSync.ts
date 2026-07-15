import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { getTrack, initialPlayerState } from '../data'
import type { PlayerActions, PlayerState, RepeatMode, Track } from '../types'

const roomFromUrl = new URLSearchParams(window.location.search).get('room')
const ROOM = roomFromUrl || localStorage.getItem('ritim-room') || 'EDIZ-4821'
localStorage.setItem('ritim-room', ROOM)
const tokenFromUrl = new URLSearchParams(window.location.search).get('token')
const PAIRING_TOKEN = tokenFromUrl || localStorage.getItem('ritim-pairing-token') || ''
if (tokenFromUrl) localStorage.setItem('ritim-pairing-token', tokenFromUrl)

const savedSyncUrl = localStorage.getItem('ritim-sync-url')
const syncUrl = import.meta.env.VITE_SYNC_URL || savedSyncUrl || `${window.location.protocol}//${window.location.hostname}:8787`
export const ritimSocket = io(syncUrl, {
  autoConnect: false,
  timeout: 2500,
  reconnectionDelay: 800,
  auth: { token: PAIRING_TOKEN },
})
export const ritimRoom = ROOM
export const ritimPairingToken = PAIRING_TOKEN

export function usePlayerSync(isCompanion: boolean) {
  const [state, setState] = useState<PlayerState>(initialPlayerState)
  const [connected, setConnected] = useState(false)
  const [peerCount, setPeerCount] = useState(1)
  const [pairingError, setPairingError] = useState('')
  const pendingVolumeRef = useRef<{ value: number; changedAt: number } | null>(null)

  useEffect(() => {
    const onConnect = () => {
      setConnected(true)
      setPairingError('')
      ritimSocket.emit('room:join', {
        room: ROOM,
        role: isCompanion ? 'companion' : 'desktop',
        state: initialPlayerState,
        token: PAIRING_TOKEN,
      })
    }
    const onDisconnect = () => setConnected(false)
    const onConnectError = (error: Error) => {
      setConnected(false)
      const detail = error.message === 'timeout' ? 'PC yanıt vermedi' : error.message
      setPairingError(`PC bağlantısı kurulamadı • ${detail}`)
    }
    const onState = (incoming: PlayerState) => {
      const pending = pendingVolumeRef.current
      if (isCompanion && pending && Date.now() - pending.changedAt < 1800) {
        if (Math.abs(incoming.volume - pending.value) <= 1) pendingVolumeRef.current = null
        else {
          setState({ ...incoming, volume: pending.value })
          return
        }
      } else if (pending) {
        pendingVolumeRef.current = null
      }
      setState(incoming)
    }
    const onPeers = (count: number) => setPeerCount(count)
    const onPairingError = (message: string) => {
      setPairingError(message)
      setConnected(false)
    }
    ritimSocket.on('connect', onConnect)
    ritimSocket.on('connect_error', onConnectError)
    ritimSocket.on('disconnect', onDisconnect)
    ritimSocket.on('player:state', onState)
    ritimSocket.on('room:peers', onPeers)
    ritimSocket.on('pairing:error', onPairingError)
    ritimSocket.connect()
    if (ritimSocket.connected) onConnect()

    return () => {
      ritimSocket.off('connect', onConnect)
      ritimSocket.off('connect_error', onConnectError)
      ritimSocket.off('disconnect', onDisconnect)
      ritimSocket.off('player:state', onState)
      ritimSocket.off('room:peers', onPeers)
      ritimSocket.off('pairing:error', onPairingError)
      ritimSocket.disconnect()
    }
  }, [isCompanion])

  const commit = useCallback((producer: (previous: PlayerState) => PlayerState) => {
    setState((previous) => {
      const next = { ...producer(previous), updatedAt: Date.now() }
      ritimSocket.emit('player:update', { room: ROOM, state: next })
      return next
    })
  }, [])

  const sendMusicCommand = useCallback((type: string, value?: number | string) => {
    if (isCompanion) ritimSocket.emit('player:command', { room: ROOM, command: { type, value } })
    else window.ritimDesktop?.music.command({ type, value })
  }, [isCompanion])

  const isYouTubeMusic = getTrack(state).source === 'ytmusic'

  useEffect(() => {
    if (!state.isPlaying || isCompanion) return
    const timer = window.setInterval(() => {
      commit((previous) => {
        const track = getTrack(previous)
        if (track.source === 'youtube') return previous
        if (previous.position + 1 < track.duration) return { ...previous, position: previous.position + 1 }
        const index = previous.queue.indexOf(previous.trackId)
        const nextId = previous.repeat === 'one'
          ? previous.trackId
          : previous.queue[(index + 1) % previous.queue.length]
        return { ...previous, trackId: nextId, position: 0 }
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [commit, isCompanion, state.isPlaying])

  const actions = useMemo<PlayerActions>(() => ({
    togglePlay: () => {
      if (isYouTubeMusic) sendMusicCommand('togglePlay')
      commit((previous) => ({ ...previous, isPlaying: !previous.isPlaying }))
    },
    next: () => {
      if (isYouTubeMusic) {
        sendMusicCommand('next')
        setState((previous) => ({ ...previous, position: 0, isPlaying: true }))
        return
      }
      commit((previous) => {
      const index = previous.queue.indexOf(previous.trackId)
      const nextIndex = previous.shuffle
        ? Math.floor(Math.random() * previous.queue.length)
        : (index + 1) % previous.queue.length
        return { ...previous, trackId: previous.queue[nextIndex], position: 0, isPlaying: true }
      })
    },
    previous: () => {
      if (isYouTubeMusic) {
        sendMusicCommand('previous')
        setState((previous) => ({ ...previous, position: 0 }))
        return
      }
      commit((previous) => {
        if (previous.position > 4) return { ...previous, position: 0 }
        const index = previous.queue.indexOf(previous.trackId)
        return { ...previous, trackId: previous.queue[(index - 1 + previous.queue.length) % previous.queue.length], position: 0 }
      })
    },
    selectTrack: (trackId) => {
      if (isYouTubeMusic) {
        setState((previous) => {
          const selected = previous.catalog[trackId]
          if (selected?.youtubeVideoId) sendMusicCommand('playTrack', selected.youtubeVideoId)
          return { ...previous, trackId, position: 0, isPlaying: true }
        })
        return
      }
      commit((previous) => ({ ...previous, trackId, position: 0, isPlaying: true }))
    },
    seek: (position) => {
      if (isYouTubeMusic) {
        sendMusicCommand('seek', position)
        setState((previous) => ({ ...previous, position }))
        return
      }
      commit((previous) => ({ ...previous, position }))
    },
    setVolume: (volume) => {
      const safeVolume = Math.max(0, Math.min(100, Math.round(volume)))
      if (isYouTubeMusic) {
        pendingVolumeRef.current = { value: safeVolume, changedAt: Date.now() }
        sendMusicCommand('setVolume', safeVolume)
        setState((previous) => ({ ...previous, volume: safeVolume }))
        return
      }
      commit((previous) => ({ ...previous, volume: safeVolume }))
    },
    requestLyrics: () => {
      if (!isYouTubeMusic) return
      setState((previous) => ({
        ...previous,
        lyrics: { trackId: previous.trackId, status: 'loading', lines: [] },
      }))
      sendMusicCommand('requestLyrics')
    },
    navigateMusic: (destination, query) => sendMusicCommand(`navigate:${destination}`, query),
    openMusicItem: (item) => {
      if (item.videoId) sendMusicCommand('playTrack', item.videoId)
      else if (item.href) sendMusicCommand('navigateUrl', item.href)
    },
    openMusicFilter: (filter) => {
      if (filter.href) sendMusicCommand('navigateUrl', filter.href)
    },
    goBackMusic: () => sendMusicCommand('goBack'),
    toggleShuffle: () => {
      if (isYouTubeMusic) sendMusicCommand('toggleShuffle')
      commit((previous) => ({ ...previous, shuffle: !previous.shuffle }))
    },
    cycleRepeat: () => {
      if (isYouTubeMusic) sendMusicCommand('cycleRepeat')
      commit((previous) => {
        const next: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' }
        return { ...previous, repeat: next[previous.repeat] }
      })
    },
    toggleLike: () => commit((previous) => ({
      ...previous,
      liked: previous.liked.includes(previous.trackId)
        ? previous.liked.filter((id) => id !== previous.trackId)
        : [...previous.liked, previous.trackId],
    })),
    replaceQueue: (newTracks: Track[], startTrackId?: string) => commit((previous) => {
      if (newTracks.length === 0) return previous
      const newCatalog = { ...previous.catalog, ...Object.fromEntries(newTracks.map((track) => [track.id, track])) }
      return {
        ...previous,
        catalog: newCatalog,
        queue: newTracks.map((track) => track.id),
        trackId: startTrackId && newCatalog[startTrackId] ? startTrackId : newTracks[0].id,
        position: 0,
        isPlaying: true,
      }
    }),
    syncFromMedia: (patch) => commit((previous) => ({ ...previous, ...patch })),
  }), [commit, isYouTubeMusic, sendMusicCommand])

  useEffect(() => {
    const track = getTrack(state)
    if (!window.ritimDesktop) return
    window.ritimDesktop.updatePresence({
      title: track.title,
      artist: track.artist,
      isPlaying: state.isPlaying,
      startedAt: state.isPlaying ? Date.now() - state.position * 1000 : undefined,
    })
  }, [state.isPlaying, state.position, state.trackId, state.catalog])

  return { state, actions, connected, peerCount, room: ROOM, pairingError }
}
