import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { io } from 'socket.io-client'
import { getTrack, initialPlayerState } from '../data'
import { isNativeMobile, type MobilePairingConfig } from '../mobileConfig'
import {
  NEXT_REPEAT,
  TOGGLE_CONFIRM_TIMEOUT_MS,
  canControlPlayback,
  findToggleByCommand,
  isTrackLiked,
  reconcileToggles,
  rollbackToggle,
  withLike,
  type PendingToggle,
  type PendingToggles,
} from '../playerToggles'
import type { PlayerActions, PlayerState, SyncCommand, SyncCommandAck, SyncHealth, Track } from '../types'

const VOLUME_ACK_TIMEOUT_MS = 6000
const PLAYER_CACHE_KEY = 'ritim-player-cache-v2'
const COMMAND_TIMEOUT_MS = 20000
const TRACK_ACK_TIMEOUT_MS = 15000
const REPLACEABLE_COMMAND_DELAY_MS = 120
const REPLACEABLE_COMMANDS = new Set(['seek', 'setVolume'])
const COALESCIBLE_COMMANDS = new Set(['loadMoreBrowse', 'requestLyrics', 'requestRelated'])
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

export function usePlayerSync(isCompanion: boolean, pairing: MobilePairingConfig) {
  const { room, syncUrl, token } = pairing
  const socket = useMemo(() => io(syncUrl, {
    autoConnect: false,
    timeout: 2500,
    reconnectionDelay: 800,
    auth: { token },
  }), [syncUrl, token])
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
  const pendingCommandsRef = useRef(new Map<string, {
    type: string
    value?: number | string
    signature: string
    sentAt: number
    timer: number
  }>())
  const deferredCommandsRef = useRef(new Map<string, number>())
  const pendingTogglesRef = useRef<PendingToggles>({})
  const toggleTimersRef = useRef(new Map<string, number>())
  const authoritativeStateRef = useRef<PlayerState | null>(null)
  const latestRevisionRef = useRef(0)
  const lastCacheWriteRef = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state

  const clearToggle = useCallback((toggle: PendingToggle) => {
    const timer = toggleTimersRef.current.get(toggle.commandId)
    if (timer) window.clearTimeout(timer)
    toggleTimersRef.current.delete(toggle.commandId)
    if (pendingTogglesRef.current[toggle.kind] === toggle) {
      pendingTogglesRef.current = { ...pendingTogglesRef.current, [toggle.kind]: undefined }
    }
  }, [])

  // Kalp / tekrar komutu başarısız olur ya da PC durumu zamanında doğrulamazsa iyimser değeri geri al.
  const rollbackToggleCommand = useCallback((commandId: string) => {
    const toggle = findToggleByCommand(pendingTogglesRef.current, commandId)
    if (!toggle) return
    clearToggle(toggle)
    setState((current) => rollbackToggle(current, authoritativeStateRef.current, toggle))
  }, [clearToggle])

  const trackToggle = useCallback((toggle: PendingToggle) => {
    const previous = pendingTogglesRef.current[toggle.kind]
    if (previous) clearToggle(previous)
    pendingTogglesRef.current = { ...pendingTogglesRef.current, [toggle.kind]: toggle }
    toggleTimersRef.current.set(toggle.commandId, window.setTimeout(() => {
      toggleTimersRef.current.delete(toggle.commandId)
      rollbackToggleCommand(toggle.commandId)
    }, TOGGLE_CONFIRM_TIMEOUT_MS))
  }, [clearToggle, rollbackToggleCommand])

  const dropAllToggles = useCallback(() => {
    for (const timer of toggleTimersRef.current.values()) window.clearTimeout(timer)
    toggleTimersRef.current.clear()
    const hadPending = Boolean(pendingTogglesRef.current.like || pendingTogglesRef.current.repeat)
    pendingTogglesRef.current = {}
    return hadPending
  }, [])

  useEffect(() => {
    const onConnect = () => {
      setConnected(true)
      setPairingError('')
      socket.emit('room:join', {
        room,
        role: isCompanion ? 'companion' : 'desktop',
        state: initialPlayerState,
        token: token,
      })
      socket.emit('room:request-state', { room })
    }
    const onDisconnect = () => {
      const hadPendingCommands = pendingCommandsRef.current.size > 0 || deferredCommandsRef.current.size > 0
      for (const pending of pendingCommandsRef.current.values()) window.clearTimeout(pending.timer)
      pendingCommandsRef.current.clear()
      for (const timer of deferredCommandsRef.current.values()) window.clearTimeout(timer)
      deferredCommandsRef.current.clear()
      pendingTrackRef.current = null
      pendingVolumeRef.current = null
      const authoritative = authoritativeStateRef.current
      if (dropAllToggles() && authoritative) {
        setState((current) => ({ ...current, liked: authoritative.liked, likeStatus: authoritative.likeStatus, repeat: authoritative.repeat }))
      }
      setConnected(false)
      latestRevisionRef.current = 0
      setSyncHealth((current) => ({ ...current, desktopOnline: false, pendingCommands: 0 }))
      if (hadPendingCommands) {
        setState((current) => ({
          ...current,
          actionFeedback: {
            id: `sync-disconnected-${Date.now()}`,
            status: 'error',
            message: 'PC bağlantısı kesildi; yeniden bağlanınca durum eşitlenecek',
          },
        }))
      }
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
      authoritativeStateRef.current = incoming
      let nextState = incoming
      if (isCompanion && (pendingTogglesRef.current.like || pendingTogglesRef.current.repeat)) {
        const reconciled = reconcileToggles(incoming, pendingTogglesRef.current)
        for (const kind of ['like', 'repeat'] as const) {
          const toggle = pendingTogglesRef.current[kind]
          if (toggle && !reconciled.pending[kind]) clearToggle(toggle)
        }
        nextState = reconciled.state
      }
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
      if (ack.status === 'failed') {
        pendingTrackRef.current = null
        pendingVolumeRef.current = null
        rollbackToggleCommand(ack.id)
        socket.emit('room:request-state', { room })
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
    socket.on('connect', onConnect)
    socket.on('connect_error', onConnectError)
    socket.on('disconnect', onDisconnect)
    socket.on('player:state', onState)
    socket.on('room:peers', onPeers)
    socket.on('room:status', onRoomStatus)
    socket.on('player:command:ack', onCommandAck)
    socket.on('pairing:error', onPairingError)
    socket.connect()
    if (socket.connected) onConnect()

    return () => {
      socket.off('connect', onConnect)
      socket.off('connect_error', onConnectError)
      socket.off('disconnect', onDisconnect)
      socket.off('player:state', onState)
      socket.off('room:peers', onPeers)
      socket.off('room:status', onRoomStatus)
      socket.off('player:command:ack', onCommandAck)
      socket.off('pairing:error', onPairingError)
      for (const pending of pendingCommandsRef.current.values()) window.clearTimeout(pending.timer)
      pendingCommandsRef.current.clear()
      for (const timer of deferredCommandsRef.current.values()) window.clearTimeout(timer)
      deferredCommandsRef.current.clear()
      dropAllToggles()
      socket.disconnect()
    }
  }, [clearToggle, dropAllToggles, isCompanion, rollbackToggleCommand, room, socket, token])

  useEffect(() => {
    if (!isCompanion || !isNativeMobile) return
    let disposed = false
    let removeListener: (() => Promise<void>) | undefined
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return
      latestRevisionRef.current = 0
      if (socket.connected) {
        socket.emit('room:request-state', { room })
      } else {
        socket.connect()
      }
    }).then((handle) => {
      if (disposed) void handle.remove()
      else removeListener = () => handle.remove()
    }).catch(() => {})
    return () => {
      disposed = true
      void removeListener?.()
    }
  }, [isCompanion, room, socket])

  const commit = useCallback((producer: (previous: PlayerState) => PlayerState) => {
    setState((previous) => {
      const next = { ...producer(previous), updatedAt: Date.now() }
      if (!isCompanion) socket.emit('player:update', { room, state: next })
      return next
    })
  }, [isCompanion, room, socket])

  // Gönderilen komutun kimliğini döndürür; gönderilemezse false.
  const emitMusicCommand = useCallback((type: string, value?: number | string): string | false => {
    if (!isCompanion) {
      window.ritimDesktop?.music.command({ type, value })
      return 'desktop'
    }
    if (!socket.connected) {
      setSyncHealth((current) => ({ ...current, desktopOnline: false }))
      setState((current) => ({
        ...current,
        actionFeedback: {
          id: `sync-offline-${Date.now()}`,
          status: 'error',
          message: 'PC bağlantısı yok; yeniden bağlanılıyor',
        },
      }))
      socket.connect()
      return false
    }
    const signature = `${type}\u0000${String(value ?? '')}`
    const canCoalesce = COALESCIBLE_COMMANDS.has(type) || type.startsWith('navigate:')
    if (canCoalesce) {
      const existing = [...pendingCommandsRef.current.entries()].find(([, pending]) => pending.signature === signature)
      if (existing) return existing[0]
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
      pendingTrackRef.current = null
      pendingVolumeRef.current = null
      rollbackToggleCommand(command.id)
      setState((current) => ({
        ...current,
        lastCommandAck: ack,
        actionFeedback: { id: `sync-${command.id}`, status: 'error', message: ack.message || 'Komut zaman aşımına uğradı' },
      }))
      setSyncHealth((current) => ({ ...current, pendingCommands: pendingCommandsRef.current.size }))
      if (socket.connected) socket.emit('room:request-state', { room })
    }, COMMAND_TIMEOUT_MS)
    pendingCommandsRef.current.set(command.id, { type, value, signature, sentAt: Date.now(), timer })
    setSyncHealth((current) => ({ ...current, pendingCommands: pendingCommandsRef.current.size }))
    socket.emit('player:command', { room, command })
    return command.id
  }, [isCompanion, rollbackToggleCommand, room, socket])

  const sendMusicCommand = useCallback((type: string, value?: number | string): string | boolean => {
    if (!isCompanion || !REPLACEABLE_COMMANDS.has(type)) return emitMusicCommand(type, value)
    if (!socket.connected) return emitMusicCommand(type, value)
    const existingTimer = deferredCommandsRef.current.get(type)
    if (existingTimer) window.clearTimeout(existingTimer)
    const timer = window.setTimeout(() => {
      deferredCommandsRef.current.delete(type)
      emitMusicCommand(type, value)
    }, REPLACEABLE_COMMAND_DELAY_MS)
    deferredCommandsRef.current.set(type, timer)
    return true
  }, [emitMusicCommand, isCompanion])

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
      if (isYouTubeMusic && !sendMusicCommand('togglePlay')) return
      commit((previous) => ({ ...previous, isPlaying: !previous.isPlaying }))
    },
    next: () => {
      if (isYouTubeMusic) {
        if (!sendMusicCommand('next')) return
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
        if (!sendMusicCommand('previous')) return
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
          const sent = sendMusicCommand('playQueueTrack', JSON.stringify({
            id: selected.id,
            videoId: selected.youtubeVideoId,
            title: selected.title,
          }))
          if (!sent) return
          pendingTrackRef.current = { videoId: selected.youtubeVideoId, changedAt: Date.now() }
        }
        setState((previous) => ({ ...previous, trackId, position: 0, isPlaying: true }))
        return
      }
      commit((previous) => ({ ...previous, trackId, position: 0, isPlaying: true }))
    },
    seek: (position) => {
      if (isYouTubeMusic) {
        if (!sendMusicCommand('seek', position)) return
        setState((previous) => ({ ...previous, position }))
        return
      }
      commit((previous) => ({ ...previous, position }))
    },
    setVolume: (volume) => {
      const safeVolume = Math.max(0, Math.min(100, Math.round(volume)))
      if (isYouTubeMusic) {
        if (!sendMusicCommand('setVolume', safeVolume)) return
        pendingVolumeRef.current = { value: safeVolume, changedAt: Date.now() }
        setState((previous) => ({ ...previous, volume: safeVolume }))
        return
      }
      commit((previous) => ({ ...previous, volume: safeVolume }))
    },
    requestLyrics: () => {
      if (!isYouTubeMusic) return
      if (!sendMusicCommand('requestLyrics')) return
      setState((previous) => ({
        ...previous,
        lyrics: { trackId: previous.trackId, status: 'loading', lines: [] },
      }))
    },
    requestRelated: () => {
      if (!isYouTubeMusic) return
      if (!sendMusicCommand('requestRelated')) return
      setState((previous) => ({
        ...previous,
        related: { trackId: previous.trackId, status: 'loading', items: [] },
      }))
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
        const sent = sendMusicCommand('playItem', JSON.stringify(item))
        if (!sent) return
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
      if (socket.connected) socket.disconnect()
      socket.connect()
    },
    openMusicFilter: (filter) => {
      if (filter.href) sendMusicCommand('navigateUrl', filter.href)
    },
    goBackMusic: () => sendMusicCommand('goBack'),
    toggleShuffle: () => {
      // YouTube Music'te karıştır tek seferlik eylemdir; kalıcı bir mod gibi tutulmaz.
      if (isYouTubeMusic) {
        if (canControlPlayback(stateRef.current)) sendMusicCommand('toggleShuffle')
        return
      }
      commit((previous) => ({ ...previous, shuffle: !previous.shuffle }))
    },
    cycleRepeat: () => {
      if (!isYouTubeMusic) {
        commit((previous) => ({ ...previous, repeat: NEXT_REPEAT[previous.repeat] }))
        return
      }
      const current = stateRef.current
      if (!canControlPlayback(current)) return
      const repeat = NEXT_REPEAT[current.repeat]
      const commandId = sendMusicCommand('repeat', repeat)
      if (typeof commandId !== 'string' || !isCompanion) return
      trackToggle({ kind: 'repeat', repeat, commandId, changedAt: Date.now() })
      setState((previous) => ({ ...previous, repeat }))
    },
    toggleLike: () => {
      if (!isYouTubeMusic) {
        commit((previous) => withLike(previous, previous.trackId, !isTrackLiked(previous)))
        return
      }
      const current = stateRef.current
      if (!canControlPlayback(current)) return
      const liked = !isTrackLiked(current)
      const commandId = sendMusicCommand('like', liked ? 'LIKE' : 'INDIFFERENT')
      if (typeof commandId !== 'string' || !isCompanion) return
      trackToggle({ kind: 'like', trackId: current.trackId, liked, commandId, changedAt: Date.now() })
      setState((previous) => withLike(previous, current.trackId, liked))
    },
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
  }), [commit, isCompanion, isYouTubeMusic, sendMusicCommand, socket, trackToggle])

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

  return { state, actions, connected, peerCount, room, pairingError, syncHealth }
}
