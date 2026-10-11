import { pruneCatalog } from '../shared/player-catalog.mjs'
import type { PlayerState } from './types'

export const PLAYER_CACHE_KEY = 'ritim-player-cache-v2'

type CacheStorage = Pick<Storage, 'getItem' | 'setItem'>

// Çalan parça, sıra ve beğenilenler kalır; diğer katalog kayıtlarından yalnız en yenileri.
export function boundedCatalog(state: Pick<PlayerState, 'catalog' | 'trackId' | 'queue' | 'liked'>) {
  return pruneCatalog(state.catalog, { trackId: state.trackId, queue: state.queue, liked: state.liked })
}

export function readCachedPlayerState(storage: CacheStorage = localStorage): PlayerState | null {
  try {
    const cached = JSON.parse(storage.getItem(PLAYER_CACHE_KEY) || '') as { version?: number; state?: PlayerState }
    if (cached.version !== 2 || !cached.state?.catalog || !Array.isArray(cached.state.queue)) return null
    // Eski sürümlerin sınırsız büyümüş önbelleği de okurken budanır.
    const liked = Array.isArray(cached.state.liked) ? cached.state.liked : []
    return { ...cached.state, liked, catalog: boundedCatalog({ ...cached.state, liked }) }
  } catch {
    return null
  }
}

export function writeCachedPlayerState(state: PlayerState, storage: CacheStorage = localStorage) {
  try {
    const browse = state.browse ? {
      ...state.browse,
      sections: state.browse.sections.slice(0, 18).map((section) => ({ ...section, items: section.items.slice(0, 80) })),
    } : undefined
    storage.setItem(PLAYER_CACHE_KEY, JSON.stringify({
      version: 2,
      savedAt: Date.now(),
      state: { ...state, catalog: boundedCatalog(state), browse, position: 0, isPlaying: false },
    }))
  } catch {}
}
