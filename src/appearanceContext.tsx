import { createContext, useContext, useMemo, type ReactNode } from 'react'
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  type AppearancePreferences,
} from './appearancePreferences'

type AppearanceContextValue = {
  active: boolean
  preferences: AppearancePreferences
  update: (patch: Partial<AppearancePreferences>) => void
}

const AppearanceContext = createContext<AppearanceContextValue>({
  active: false,
  preferences: { ...DEFAULT_APPEARANCE_PREFERENCES },
  update: () => {},
})

export function AppearanceProvider({ active, preferences, update, children }: AppearanceContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ active, preferences, update }), [active, preferences, update])
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
}

export function useAppearance() {
  return useContext(AppearanceContext)
}

export function useMobileArtwork() {
  const { active, preferences } = useAppearance()
  return active ? preferences.artwork : 'full'
}
