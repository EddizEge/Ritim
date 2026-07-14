import { Pause, Play, Repeat2, Shuffle, SkipBack, SkipForward } from 'lucide-react'
import type { PlayerActions, PlayerState } from '../types'

type Props = {
  state: PlayerState
  actions: PlayerActions
  large?: boolean
}

export function PlayerControls({ state, actions, large = false }: Props) {
  return (
    <div className={`player-controls ${large ? 'player-controls--large' : ''}`}>
      <button className={state.shuffle ? 'is-active' : ''} onClick={actions.toggleShuffle} aria-label="Karıştır"><Shuffle /></button>
      <button onClick={actions.previous} aria-label="Önceki"><SkipBack fill="currentColor" /></button>
      <button className="play-button" onClick={actions.togglePlay} aria-label={state.isPlaying ? 'Duraklat' : 'Oynat'}>
        {state.isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
      </button>
      <button onClick={actions.next} aria-label="Sonraki"><SkipForward fill="currentColor" /></button>
      <button className={state.repeat !== 'off' ? 'is-active' : ''} onClick={actions.cycleRepeat} aria-label="Tekrar">
        <Repeat2 />{state.repeat === 'one' ? <span className="repeat-one">1</span> : null}
      </button>
    </div>
  )
}
