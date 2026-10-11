import { Pause, Play, Repeat2, Shuffle, SkipBack, SkipForward } from 'lucide-react'
import { getTrack } from '../data'
import { canControlPlayback } from '../playerToggles'
import type { PlayerActions, PlayerState, RepeatMode } from '../types'

type Props = {
  state: PlayerState
  actions: PlayerActions
  large?: boolean
}

const REPEAT_LABELS: Record<RepeatMode, string> = {
  off: 'Tekrar kapalı',
  all: 'Tümünü tekrarla',
  one: 'Bir parçayı tekrarla',
}

export function PlayerControls({ state, actions, large = false }: Props) {
  const isYouTubeMusic = getTrack(state).source === 'ytmusic'
  const controllable = canControlPlayback(state)
  // YouTube Music'te karıştır tek seferlik eylemdir; basılı kalan bir mod gibi gösterme.
  const shuffleActive = !isYouTubeMusic && state.shuffle
  return (
    <div className={`player-controls ${large ? 'player-controls--large' : ''}`}>
      <button className={shuffleActive ? 'is-active' : ''} onClick={actions.toggleShuffle} disabled={!controllable} aria-label="Karıştır"><Shuffle /></button>
      <button onClick={actions.previous} aria-label="Önceki"><SkipBack fill="currentColor" /></button>
      <button className="play-button" onClick={actions.togglePlay} aria-label={state.isPlaying ? 'Duraklat' : 'Oynat'}>
        {state.isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
      </button>
      <button onClick={actions.next} aria-label="Sonraki"><SkipForward fill="currentColor" /></button>
      <button
        className={state.repeat !== 'off' ? 'is-active' : ''}
        onClick={actions.cycleRepeat}
        disabled={!controllable}
        aria-label={REPEAT_LABELS[state.repeat]}
        aria-pressed={state.repeat !== 'off'}
        data-repeat={state.repeat}
      >
        <Repeat2 />{state.repeat === 'one' ? <span className="repeat-one">1</span> : null}
      </button>
    </div>
  )
}
