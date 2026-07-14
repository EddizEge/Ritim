import { formatTime } from '../data'

type Props = {
  position: number
  duration: number
  onSeek: (position: number) => void
  compact?: boolean
}

export function Progress({ position, duration, onSeek, compact = false }: Props) {
  const knownDuration = duration > 0
  return (
    <div className={`progress-wrap ${compact ? 'progress-wrap--compact' : ''}`}>
      <span>{knownDuration ? formatTime(position) : '--:--'}</span>
      <input
        className="range range--progress"
        type="range"
        min="0"
        max={knownDuration ? duration : 1}
        step="1"
        value={knownDuration ? Math.min(position, duration) : 0}
        disabled={!knownDuration}
        style={{ '--range-value': `${knownDuration ? (position / duration) * 100 : 0}%` } as React.CSSProperties}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label="Şarkıda ilerle"
      />
      <span>{knownDuration ? formatTime(duration) : '--:--'}</span>
    </div>
  )
}
