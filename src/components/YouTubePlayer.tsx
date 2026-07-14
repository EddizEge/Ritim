import { useEffect, useRef, useState } from 'react'
import type { PlayerActions, PlayerState, Track } from '../types'
import { YouTubeMark } from './YouTubeMark'

let youtubeApiPromise: Promise<void> | undefined

function loadYouTubeApi() {
  const globalWindow = window as typeof window & { YT?: { Player: new (...args: unknown[]) => unknown }; onYouTubeIframeAPIReady?: () => void }
  if (globalWindow.YT?.Player) return Promise.resolve()
  if (youtubeApiPromise) return youtubeApiPromise
  youtubeApiPromise = new Promise((resolve, reject) => {
    const previousReady = globalWindow.onYouTubeIframeAPIReady
    globalWindow.onYouTubeIframeAPIReady = () => {
      previousReady?.()
      resolve()
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onerror = () => reject(new Error('YouTube oynatıcı yüklenemedi.'))
    document.head.appendChild(script)
  })
  return youtubeApiPromise
}

type Props = {
  track: Track
  state: PlayerState
  actions: PlayerActions
}

export function YouTubePlayer({ track, state, actions }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<any>(null)
  const stateRef = useRef(state)
  const actionsRef = useRef(actions)
  const loadedVideoRef = useRef('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  stateRef.current = state
  actionsRef.current = actions

  useEffect(() => {
    let disposed = false
    let progressTimer: number | undefined
    loadYouTubeApi().then(() => {
      if (disposed || !hostRef.current || !track.youtubeVideoId) return
      const YT = (window as any).YT
      playerRef.current = new YT.Player(hostRef.current, {
        width: '100%',
        height: '100%',
        videoId: track.youtubeVideoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: any) => {
            if (disposed) return
            loadedVideoRef.current = track.youtubeVideoId || ''
            event.target.setVolume(stateRef.current.volume)
            event.target.seekTo(stateRef.current.position, true)
            if (stateRef.current.isPlaying) event.target.playVideo()
            setReady(true)
            progressTimer = window.setInterval(() => {
              const player = playerRef.current
              if (!player?.getCurrentTime) return
              const position = Number(player.getCurrentTime() || 0)
              if (Math.abs(position - stateRef.current.position) >= .6) actionsRef.current.syncFromMedia({ position })
            }, 1000)
          },
          onStateChange: (event: any) => {
            if (event.data === 0) {
              actionsRef.current.next()
              return
            }
            if (event.data === 1 && !stateRef.current.isPlaying) actionsRef.current.syncFromMedia({ isPlaying: true })
            if (event.data === 2 && stateRef.current.isPlaying) actionsRef.current.syncFromMedia({ isPlaying: false })
          },
          onError: () => setError('Bu video YouTube dışında oynatılamıyor.'),
        },
      })
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))

    return () => {
      disposed = true
      if (progressTimer) window.clearInterval(progressTimer)
      try { playerRef.current?.destroy() } catch { /* Player may already be gone. */ }
      playerRef.current = null
    }
  }, [])

  useEffect(() => {
    const player = playerRef.current
    if (!ready || !player || !track.youtubeVideoId || loadedVideoRef.current === track.youtubeVideoId) return
    loadedVideoRef.current = track.youtubeVideoId
    const input = { videoId: track.youtubeVideoId, startSeconds: state.position }
    if (state.isPlaying) player.loadVideoById(input)
    else player.cueVideoById(input)
  }, [ready, state.isPlaying, state.position, track.youtubeVideoId])

  useEffect(() => {
    const player = playerRef.current
    if (!ready || !player) return
    if (state.isPlaying && player.getPlayerState() !== 1) player.playVideo()
    if (!state.isPlaying && player.getPlayerState() === 1) player.pauseVideo()
  }, [ready, state.isPlaying])

  useEffect(() => {
    if (ready) playerRef.current?.setVolume(state.volume)
  }, [ready, state.volume])

  useEffect(() => {
    const player = playerRef.current
    if (!ready || !player?.getCurrentTime) return
    if (Math.abs(Number(player.getCurrentTime()) - state.position) > 3) player.seekTo(state.position, true)
  }, [ready, state.position])

  return (
    <section className="youtube-player-panel" aria-label="YouTube oynatıcı">
      <div className="youtube-player-heading"><YouTubeMark /><span>Resmî YouTube oynatıcı</span></div>
      <div className="youtube-player-frame" ref={hostRef} />
      {error ? <div className="youtube-player-error">{error}</div> : null}
    </section>
  )
}
