import { useEffect, useState, useSyncExternalStore } from 'react'
import { normalizeAppearancePreferences, type AppearancePreferences } from '../appearancePreferences'
import type { SocialActions, SocialState } from '../social/types'
import { createDesktopSocialStore, type RitimSocialBridge } from './desktopSocialStore'

// SocialActions over the Electron main-process bridge; the social socket and
// its tokens never enter this renderer.
export function useDesktopSocialBridge(bridge: RitimSocialBridge): { state: SocialState; actions: SocialActions } {
  const [store] = useState(() => createDesktopSocialStore(bridge))
  useEffect(() => store.start(), [store])
  const state = useSyncExternalStore(store.subscribe, store.getState)
  return { state, actions: store.actions }
}

// Theme, density, motion and artwork come from the PC's appearance store
// (Settings › Appearance), applied with the same data attributes as the phone.
export function useDesktopAppearance(bridge: RitimSocialBridge) {
  const [preferences, setPreferences] = useState<AppearancePreferences>(() => normalizeAppearancePreferences(undefined))

  useEffect(() => {
    let disposed = false
    const apply = (value: unknown) => {
      if (!disposed) setPreferences(normalizeAppearancePreferences(value))
    }
    const stop = bridge.onAppearance(apply)
    void bridge.getAppearance().then(apply).catch(() => {})
    return () => {
      disposed = true
      stop()
    }
  }, [bridge])

  useEffect(() => {
    const root = document.documentElement
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
    const applyResolvedTheme = () => {
      root.dataset.ritimResolvedTheme = preferences.theme === 'system'
        ? (systemDark.matches ? 'dark' : 'light')
        : preferences.theme
    }
    root.dataset.ritimTheme = preferences.theme
    root.dataset.ritimDensity = preferences.density
    root.dataset.ritimMotion = preferences.motion
    root.dataset.ritimArtwork = preferences.artwork
    applyResolvedTheme()
    systemDark.addEventListener('change', applyResolvedTheme)
    return () => systemDark.removeEventListener('change', applyResolvedTheme)
  }, [preferences])

  return preferences
}
