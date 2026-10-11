import { getTrack } from './data'
import type { PlayerState, RepeatMode } from './types'

// Telefondaki kalp ve tekrar düğmelerinin iyimser durumu. PC yetkilidir:
// iyimser değer, PC'den aynı değer gelene dek gösterilir; komut başarısız
// olursa ya da bu süre içinde doğrulanmazsa PC'nin son değerine dönülür.
export const TOGGLE_CONFIRM_TIMEOUT_MS = 8000

export const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' }

export type PendingLike = { kind: 'like'; trackId: string; liked: boolean; commandId: string; changedAt: number }
export type PendingRepeat = { kind: 'repeat'; repeat: RepeatMode; commandId: string; changedAt: number }
export type PendingToggle = PendingLike | PendingRepeat
export type PendingToggles = { like?: PendingLike; repeat?: PendingRepeat }

export function isTrackLiked(state: PlayerState, trackId = state.trackId) {
  return state.liked.includes(trackId)
}

// Kalp / tekrar / karıştır yalnız gerçek bir parça çalarken ve reklam yokken çalışır.
export function canControlPlayback(state: PlayerState) {
  const track = getTrack(state)
  if (track.source !== 'ytmusic') return true
  return Boolean(track.youtubeVideoId) && track.id !== 'ytmusic:idle' && !state.adPlaying
}

export function withLike(state: PlayerState, trackId: string, liked: boolean): PlayerState {
  const others = state.liked.filter((id) => id !== trackId)
  return {
    ...state,
    liked: liked ? [...others, trackId] : others,
    ...(trackId === state.trackId ? { likeStatus: liked ? 'LIKE' as const : 'INDIFFERENT' as const } : {}),
  }
}

// PC'den gelen durumu bekleyen iyimser değerlerle birleştirir.
export function reconcileToggles(incoming: PlayerState, pending: PendingToggles, now = Date.now()) {
  let state = incoming
  const next: PendingToggles = {}
  const like = pending.like
  if (like && like.trackId === incoming.trackId && now - like.changedAt < TOGGLE_CONFIRM_TIMEOUT_MS) {
    if (isTrackLiked(incoming, like.trackId) !== like.liked) {
      state = withLike(state, like.trackId, like.liked)
      next.like = like
    }
  }
  const repeat = pending.repeat
  if (repeat && now - repeat.changedAt < TOGGLE_CONFIRM_TIMEOUT_MS && incoming.repeat !== repeat.repeat) {
    state = { ...state, repeat: repeat.repeat }
    next.repeat = repeat
  }
  return { state, pending: next }
}

// Başarısız / zaman aşımına uğrayan komutun iyimser değerini PC'nin son değerine döndürür.
export function rollbackToggle(current: PlayerState, authoritative: PlayerState | null, toggle: PendingToggle): PlayerState {
  if (toggle.kind === 'repeat') return { ...current, repeat: authoritative?.repeat ?? NEXT_REPEAT[NEXT_REPEAT[toggle.repeat]] }
  if (authoritative && authoritative.trackId === toggle.trackId) {
    return { ...current, liked: authoritative.liked, likeStatus: authoritative.likeStatus }
  }
  return withLike(current, toggle.trackId, !toggle.liked)
}

export function findToggleByCommand(pending: PendingToggles, commandId: string): PendingToggle | undefined {
  if (pending.like?.commandId === commandId) return pending.like
  if (pending.repeat?.commandId === commandId) return pending.repeat
  return undefined
}
