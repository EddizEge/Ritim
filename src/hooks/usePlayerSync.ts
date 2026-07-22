import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { getTrack, initialPlayerState } from '../data'
import type { PlayerActions, PlayerState, RepeatMode, SyncCommand, SyncCommandAck, SyncHealth, Track } from '../types'

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
const VOLUME_ACK_TIMEOUT_MS = 6000
const PLAYER_CACHE_KEY = 'ritim-player-cache-v2'
const COMMAND_TIMEOUT_MS = 20000
const TRACK_ACK_TIMEOUT_MS = 15000
let commandSequence = 0

function readCachedPlayerState() {
  try {
    const cached = JSON.parse(localStorage.getItem(PLAYER_CACHE_KEY) || '') as { version?: number; state?: PlayerState }
    if (cached.version !== 2 || !cached.state?.catalog || !Array.isArray(cached.state.queue)) return null
    return cached.state
  } catch {
    return null
  }
}

function writeCachedPlayerState(state: PlayerState) {
  try {
    const browse = state.browse ? {
      ...state.browse,
      sections: state.browse.sections.slice(0, 18).map((section) => ({ ...section, items: section.items.slice(0, 80) })),
    } : undefined
    localStorage.setItem(PLAYER_CACHE_KEY, JSON.stringify({
      version: 2,
      savedAt: Date.now(),
      state: { ...state, browse, position: 0, isPlaying: false },
    }))
  } catch {}
}

function createCommand(type: string, value?: number | string): SyncCommand {
  return { id: `${Date.now().toString(36)}-${(++commandSequence).toString(36)}`, type, value, issuedAt: Date.now() }
}

export function usePlayerSync(isCompanion: boolean) {
  const [state, setState] = useState<PlayerState>(() => isCompanion ? readCachedPlayerState() || initialPlayerState : initialPlayerState)
  const [connected, setConnected] = useState(false)
  const [peerCount, setPeerCount] = useState(1)
  const [pairingError, setPairingError] = useState('')
  const [syncHealth, setSyncHealth] = useState<SyncHealth>(() => ({
    desktopOnline: false,
    companionCount: 0,
    latencyMs: null,
    lastSyncedAt: 0,
    pendingCommands: 0,
    usingCache: Boolean(isCompanion && readCachedPlayerState()),
  }))
  const pendingVolumeRef = useRef<{ value: number; changedAt: number } | null>(null)
  const pendingTrackRef = useRef<{ videoId: string; changedAt: number } | null>(null)
  const pendingCommandsRef = useRef(new Map<string, { type: string; sentAt: number; timer: number }>())
  const latestRevisionRef = useRef(0)
  const lastCacheWriteRef = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state

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
      ritimSocket.emit('room:request-state', { room: ROOM })
    }
    const onDisconnect = () => {
      setConnected(false)
      latestRevisionRef.current = 0
      setSyncHealth((current) => ({ ...current, desktopOnline: false }))
    }
    const onConnectError = (error: Error) => {
      setConnected(false)
      const detail = error.message === 'timeout' ? 'PC yanıt vermedi' : error.message
      setPairingError(`PC bağlantısı kurulamadı • ${detail}`)
    }
    const onState = (incoming: PlayerState) => {
      const revision = Number(incoming.syncRevision) || 0
      if (revision > 0 && latestRevisionRef.current > 0 && revision < latestRevisionRef.current) return
      if (revision > 0) latestRevisionRef.current = revision
      let nextState = incoming
      const pendingVolume = pendingVolumeRef.current
      if (isCompanion && pendingVolume && Date.now() - pendingVolume.changedAt < VOLUME_ACK_TIMEOUT_MS) {
        if (Math.abs(incoming.volume - pendingVolume.value) <= 1) pendingVolumeRef.current = null
        else nextState = { ...nextState, volume: pendingVolume.value }
      } else if (pendingVolume) {
        pendingVolumeRef.current = null
      }
      const pendingTrack = pendingTrackRef.current
      if (isCompanion && pendingTrack && Date.now() - pendingTrack.changedAt < TRACK_ACK_TIMEOUT_MS) {
        const incomingVideoId = incoming.catalog?.[incoming.trackId]?.youtubeVideoId || incoming.trackId?.replace(/^ytmusic:video:/, '') || ''
        if (incomingVideoId === pendingTrack.videoId) {
          pendingTrackRef.current = null
        } else {
          setState((current) => ({
            ...nextState,
            trackId: current.trackId,
            isPlaying: true,
            position: current.position,
            queue: current.queue,
            catalog: { ...nextState.catalog, ...current.catalog },
          }))
          return
        }
      } else if (pendingTrack) {
        pendingTrackRef.current = null
      }
      setState(nextState)
      const now = Date.now()
      if (isCompanion && now - lastCacheWriteRef.current >= 5000) {
        lastCacheWriteRef.current = now
        writeCachedPlayerState(nextState)
      }
      setSyncHealth((current) => ({
        ...current,
        lastSyncedAt: Number(incoming.syncedAt) || now,
        usingCache: false,
      }))
    }
    const onPeers = (count: number) => setPeerCount(count)
    const onRoomStatus = (status: { desktopOnline?: boolean; companionCount?: number; peerCount?: number }) => {
      if (typeof status.peerCount === 'number') setPeerCount(status.peerCount)
      setSyncHealth((current) => ({
        ...current,
        desktopOnline: Boolean(status.desktopOnline),
        companionCount: Math.max(0, Number(status.companionCount) || 0),
      }))
    }
    const onCommandAck = (ack: SyncCommandAck) => {
      if (!ack?.id) return
      const pending = pendingCommandsRef.current.get(ack.id)
      if (pending) {
        window.clearTimeout(pending.timer)
        pendingCommandsRef.current.delete(ack.id)
      }
      if (ack.status === 'failed' && (pending?.type === 'playItem' || pending?.type === 'playQueueTrack' || pending?.type === 'playTrack')) {
        pendingTrackRef.current = null
        ritimSocket.emit('room:request-state', { room: ROOM })
      }
      setState((current) => ({
        ...current,
        lastCommandAck: ack,
        ...(ack.status === 'failed' ? {
          actionFeedback: {
            id: `sync-${ack.id}`,
            status: 'error' as const,
            message: ack.message || 'Komut Ritim PC tarafından uygulanamadı',
          },
        } : {}),
      }))
      setSyncHealth((current) => ({
        ...current,
        latencyMs: pending ? Math.max(0, Date.now() - pending.sentAt) : current.latencyMs,
        pendingCommands: pendingCommandsRef.current.size,
      }))
    }
    const onPairingError = (message: string) => {
      setPairingError(message)
      setConnected(false)
    }
    ritimSocket.on('connect', onConnect)
    ritimSocket.on('connect_error', onConnectError)
    ritimSocket.on('disconnect', onDisconnect)
    ritimSocket.on('player:state', onState)
    ritimSocket.on('room:peers', onPeers)
    ritimSocket.on('room:status', onRoomStatus)
    ritimSocket.on('player:command:ack', onCommandAck)
    ritimSocket.on('pairing:error', onPairingError)
    ritimSocket.connect()
    if (ritimSocket.connected) onConnect()

    return () => {
      ritimSocket.off('connect', onConnect)
      ritimSocket.off('connect_error', onConnectError)
      ritimSocket.off('disconnect', onDisconnect)
      ritimSocket.off('player:state', onState)
      ritimSocket.off('room:peers', onPeers)
      ritimSocket.off('room:status', onRoomStatus)
      ritimSocket.off('player:command:ack', onCommandAck)
      ritimSocket.off('pairing:error', onPairingError)
      for (const pending of pendingCommandsRef.current.values()) window.clearTimeout(pending.timer)
      pendingCommandsRef.current.clear()
      ritimSocket.disconnect()
    }
  }, [isCompanion])

  const commit = useCallback((producer: (previous: PlayerState) => PlayerState) => {
    setState((previous) => {
      const next = { ...producer(previous), updatedAt: Date.now() }
      if (!isCompanion) ritimSocket.emit('player:update', { room: ROOM, state: next })
      return next
    })
  }, [isCompanion])

  const sendMusicCommand = useCallback((type: string, value?: number | string) => {
    if (!isCompanion) {
      window.ritimDesktop?.music.command({ type, value })
      return
    }
    const command = createCommand(type, value)
    const timer = window.setTimeout(() => {
      const pending = pendingCommandsRef.current.get(command.id)
      if (!pending) return
      pendingCommandsRef.current.delete(command.id)
      const ack: SyncCommandAck = {
        id: command.id,
        type: command.type,
        status: 'failed',
        message: 'Ritim PC zamanında yanıt vermedi',
        appliedAt: Date.now(),
      }
      setState((current) => ({
        ...current,
        lastCommandAck: ack,
        actionFeedback: { id: `sync-${command.id}`, status: 'error', message: ack.message || 'Komut zaman aşımına uğradı' },
      }))
      setSyncHealth((current) => ({ ...current, pendingCommands: pendingCommandsRef.current.size }))
    }, COMMAND_TIMEOUT_MS)
    pendingCommandsRef.current.set(command.id, { type, sentAt: Date.now(), timer })
    setSyncHealth((current) => ({ ...current, pendingCommands: pendingCommandsRef.current.size }))
    ritimSocket.emit('player:command', { room: ROOM, command })
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
        const selected = stateRef.current.catalog[trackId]
        if (selected?.youtubeVideoId) {
          pendingTrackRef.current = { videoId: selected.youtubeVideoId, changedAt: Date.now() }
          sendMusicCommand('playQueueTrack', JSON.stringify({
            id: selected.id,
            videoId: selected.youtubeVideoId,
            title: selected.title,
          }))
        }
        setState((previous) => ({ ...previous, trackId, position: 0, isPlaying: true }))
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
    requestRelated: () => {
      if (!isYouTubeMusic) return
      setState((previous) => ({
        ...previous,
        related: { trackId: previous.trackId, status: 'loading', items: [] },
      }))
      sendMusicCommand('requestRelated')
    },
    loadMoreMusic: () => sendMusicCommand('loadMoreBrowse'),
    navigateMusic: (destination, query) => sendMusicCommand(`navigate:${destination}`, query),
    openMusicItem: (item) => {
      const opensDetail = ['artist', 'profile', 'album', 'playlist', 'mix', 'podcast'].includes(item.kind)
      if (opensDetail && item.href) {
        sendMusicCommand('navigateUrl', item.href)
        return
      }
      if (item.videoId) {
        const optimisticId = `ytmusic:video:${item.videoId}`
        const optimisticTrack: Track = {
          id: optimisticId,
          title: item.title,
          artist: item.subtitle.split(' • ')[0].trim() || 'YouTube Music',
          collection: 'YouTube Music',
          duration: 0,
          cover: 0,
          thumbnailUrl: item.thumbnailUrl,
          youtubeVideoId: item.videoId,
          source: 'ytmusic',
        }
        pendingTrackRef.current = { videoId: item.videoId, changedAt: Date.now() }
        setState((previous) => ({
          ...previous,
          trackId: optimisticId,
          isPlaying: true,
          position: 0,
          catalog: { ...previous.catalog, [optimisticId]: optimisticTrack },
          queue: [optimisticId],
          lyrics: { trackId: optimisticId, status: 'idle', lines: [] },
          related: { trackId: optimisticId, status: 'idle', items: [] },
        }))
        sendMusicCommand('playItem', JSON.stringify(item))
      } else if (item.href) sendMusicCommand('navigateUrl', item.href)
    },
    performMusicItemAction: (item, action) => sendMusicCommand('itemAction', JSON.stringify({ item, action })),
    selectMusicPlaylist: (playlistId) => sendMusicCommand('selectPlaylist', playlistId),
    cancelMusicPlaylist: () => sendMusicCommand('cancelPlaylistPicker'),
    moveQueueItem: (trackId, direction) => {
      const track = stateRef.current.catalog[trackId]
      if (!track) return
      sendMusicCommand('queueAction', JSON.stringify({
        action: direction === 'next' ? 'playNext' : direction === 'up' ? 'moveUp' : 'moveDown',
        track: { id: track.id, videoId: track.youtubeVideoId, title: track.title },
      }))
    },
    removeQueueItem: (trackId) => {
      const track = stateRef.current.catalog[trackId]
      if (!track) return
      sendMusicCommand('queueAction', JSON.stringify({
        action: 'remove',
        track: { id: track.id, videoId: track.youtubeVideoId, title: track.title },
      }))
    },
    clearQueue: () => sendMusicCommand('clearQueue'),
    reconnectSync: () => {
      setPairingError('')
      setSyncHealth((current) => ({ ...current, desktopOnline: false }))
      latestRevisionRef.current = 0
      if (ritimSocket.connected) ritimSocket.disconnect()
      ritimSocket.connect()
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

  return { state, actions, connected, peerCount, room: ROOM, pairingError, syncHealth }
}
