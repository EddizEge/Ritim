import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { formatTime } from '../../data'
import type { SocialUser } from '../../social/types'

// Small building blocks of the social screens (styles: social.css, `rs-`).

const AVATAR_TONES = ['#3d2028', '#4b2832', '#243649', '#39304d', '#4a3426', '#273e37']

export function Avatar({ user, size = 44, presence = true, owner = false, badge, className = '' }: {
  user: Pick<SocialUser, 'displayName' | 'initials' | 'avatarUrl' | 'avatarTone' | 'presence'>
  size?: number
  presence?: boolean
  owner?: boolean
  badge?: ReactNode
  className?: string
}) {
  const tone = AVATAR_TONES[Math.abs(Number(user.avatarTone) || 0) % AVATAR_TONES.length]
  const style = { '--rs-avatar-size': `${size}px`, '--rs-avatar-tone': tone } as CSSProperties
  return (
    <span className={`rs-avatar ${owner ? 'is-owner' : ''} ${size >= 72 ? 'is-large' : ''} ${className}`} style={style} aria-hidden="true">
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <span className="rs-avatar-initials">{user.initials || 'R'}</span>}
      {presence && user.presence !== 'offline' ? <i className={`rs-presence is-${user.presence}`} /> : null}
      {badge}
    </span>
  )
}

export function CountBadge({ count, className = '' }: { count: number; className?: string }) {
  if (!(count > 0)) return null
  return <span className={`rs-count ${className}`} aria-hidden="true">{count > 99 ? '99+' : count}</span>
}

export function StatusChip({ label, tone, compact = false }: { label: string; tone: string; compact?: boolean }) {
  return <span className={`rs-chip is-${tone} ${compact ? 'is-compact' : ''}`}><i aria-hidden="true" />{label}</span>
}

type ProgressSource = { key: string; position: number; duration: number; isPlaying: boolean }

// Reported positions arrive every few seconds at most, so playback advances
// locally from the last known position until the next update.
export function useLivePosition(source?: ProgressSource) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    setElapsed(0)
    if (!source?.isPlaying || !(source.duration > 0)) return
    const startedAt = Date.now()
    const timer = window.setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 1000)
    return () => window.clearInterval(timer)
  }, [source?.key, source?.position, source?.isPlaying, source?.duration])
  if (!source) return { position: 0, duration: 0, fraction: 0 }
  const duration = Math.max(0, source.duration)
  const position = duration > 0 ? Math.min(duration, Math.max(0, source.position + elapsed)) : Math.max(0, source.position)
  return { position, duration, fraction: duration > 0 ? position / duration : 0 }
}

// The bar is scaled, not resized: transform on a linear one-second step.
export function ProgressBar({ fraction, label, className = '' }: { fraction: number; label?: string; className?: string }) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  return (
    <div className={`rs-progress ${className}`} role={label ? 'progressbar' : undefined} aria-label={label} aria-valuemin={label ? 0 : undefined} aria-valuemax={label ? 100 : undefined} aria-valuenow={label ? Math.round(clamped * 100) : undefined}>
      <span style={{ transform: `scaleX(${clamped})` }} />
    </div>
  )
}

export function TrackProgress({ source, withTimes = false, className = '' }: { source?: ProgressSource; withTimes?: boolean; className?: string }) {
  const { position, duration, fraction } = useLivePosition(source)
  const label = duration > 0 ? `${formatTime(position)} / ${formatTime(duration)}` : undefined
  return (
    <>
      <ProgressBar key={source?.key} fraction={fraction} label={label} className={className} />
      {withTimes && duration > 0 ? <div className="rs-times"><span>{formatTime(position)}</span><span>{formatTime(duration)}</span></div> : null}
    </>
  )
}

export function EqualizerIcon() {
  return (
    <svg className="rs-eq" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="0.5" y="5" width="2.6" height="6.5" rx="1" />
      <rect x="4.7" y="1" width="2.6" height="10.5" rx="1" />
      <rect x="8.9" y="3.5" width="2.6" height="8" rx="1" />
    </svg>
  )
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="rs-empty">
      {icon}
      <b>{title}</b>
      {children ? <p>{children}</p> : null}
    </div>
  )
}
