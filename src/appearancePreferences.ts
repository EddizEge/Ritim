export type AppearanceTheme = 'system' | 'dark' | 'black'
export type AppearanceDensity = 'comfortable' | 'compact'
export type AppearanceMotion = 'system' | 'reduced'
export type AppearanceArtwork = 'full' | 'reduced' | 'hidden'

export type AppearancePreferences = {
  theme: AppearanceTheme
  density: AppearanceDensity
  motion: AppearanceMotion
  artwork: AppearanceArtwork
}

export type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'>

export const APPEARANCE_STORAGE_KEY = 'ritim-appearance-v1'

export const DEFAULT_APPEARANCE_PREFERENCES: Readonly<AppearancePreferences> = Object.freeze({
  theme: 'system',
  density: 'comfortable',
  motion: 'system',
  artwork: 'full',
})

const THEMES = new Set<AppearanceTheme>(['system', 'dark', 'black'])
const DENSITIES = new Set<AppearanceDensity>(['comfortable', 'compact'])
const MOTIONS = new Set<AppearanceMotion>(['system', 'reduced'])
const ARTWORK_MODES = new Set<AppearanceArtwork>(['full', 'reduced', 'hidden'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  const selected = isRecord(value) ? value : {}
  return {
    theme: THEMES.has(selected.theme as AppearanceTheme)
      ? selected.theme as AppearanceTheme
      : DEFAULT_APPEARANCE_PREFERENCES.theme,
    density: DENSITIES.has(selected.density as AppearanceDensity)
      ? selected.density as AppearanceDensity
      : DEFAULT_APPEARANCE_PREFERENCES.density,
    motion: MOTIONS.has(selected.motion as AppearanceMotion)
      ? selected.motion as AppearanceMotion
      : DEFAULT_APPEARANCE_PREFERENCES.motion,
    artwork: ARTWORK_MODES.has(selected.artwork as AppearanceArtwork)
      ? selected.artwork as AppearanceArtwork
      : DEFAULT_APPEARANCE_PREFERENCES.artwork,
  }
}

function browserStorage() {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function readAppearancePreferences(storage: AppearanceStorage | undefined = browserStorage()) {
  if (!storage) return normalizeAppearancePreferences(undefined)
  try {
    const stored = storage.getItem(APPEARANCE_STORAGE_KEY)
    return stored ? normalizeAppearancePreferences(JSON.parse(stored)) : normalizeAppearancePreferences(undefined)
  } catch {
    return normalizeAppearancePreferences(undefined)
  }
}

export function writeAppearancePreferences(
  value: unknown,
  storage: AppearanceStorage | undefined = browserStorage(),
) {
  const normalized = normalizeAppearancePreferences(value)
  try {
    storage?.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Görünüm tercihi kritik değildir; depolama kapalıysa güvenli varsayılanlarla devam edilir.
  }
  return normalized
}

export function visibleArtworkUrl(value: string | undefined, mode: AppearanceArtwork) {
  if (mode === 'hidden') return undefined
  const url = value?.trim()
  return url || undefined
}
