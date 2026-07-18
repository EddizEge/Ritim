import { useEffect, useRef } from 'react'
import { getTrack } from '../data'
import { isNativeMobile } from '../mobileConfig'
import { RitimMedia } from '../nativeMedia'
import type { PlayerActions, PlayerState } from '../types'

const NOTIFICATION_PERMISSION_KEY = 'ritim-notification-permission-requested-v1'

export function useNativeMediaSession(state: PlayerState, actions: PlayerActions, connected: boolean) {
  const actionsRef = useRef(actions)
  const lastUpdateRef = useRef({ trackId: '', playing: false, sentAt: 0 })
  actionsRef.current = actions

  useEffect(() => {
    if (!isNativeMobile) return
    let removeListener: (() => Promise<void>) | undefined
    void RitimMedia.addListener('mediaAction', ({ action }) => {
      if (action === 'playPause') actionsRef.current.togglePlay()
      if (action === 'next') actionsRef.current.next()
      if (action === 'previous') actionsRef.current.previous()
    }).then((handle) => { removeListener = () => handle.remove() })
    if (!localStorage.getItem(NOTIFICATION_PERMISSION_KEY)) {
      localStorage.setItem(NOTIFICATION_PERMISSION_KEY, '1')
      void RitimMedia.requestNotificationPermission().catch(() => {})
    }
    return () => { void removeListener?.() }
  }, [])

  useEffect(() => {
    if (!isNativeMobile) return
    if (!connected || state.trackId === 'ytmusic:idle') {
      void RitimMedia.stop().catch(() => {})
      return
    }
    const now = Date.now()
    const previous = lastUpdateRef.current
    if (previous.trackId === state.trackId && previous.playing === state.isPlaying && now - previous.sentAt < 9000) return
    const track = getTrack(state)
    lastUpdateRef.current = { trackId: state.trackId, playing: state.isPlaying, sentAt: now }
    void RitimMedia.update({
      title: track.title,
      artist: track.artist,
      artwork: track.thumbnailUrl,
      playing: state.isPlaying,
      position: Math.max(0, Math.round(state.position * 1000)),
      duration: Math.max(0, Math.round(track.duration * 1000)),
    }).catch(() => {})
  }, [connected, state.catalog, state.isPlaying, state.position, state.trackId])
}
