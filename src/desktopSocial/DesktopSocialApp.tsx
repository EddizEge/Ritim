import { AppearanceProvider } from '../appearanceContext'
import { DesktopSocialHub } from '../components/SocialHub'
import type { RitimSocialBridge } from './desktopSocialStore'
import { useDesktopAppearance, useDesktopSocialBridge } from './useDesktopSocialBridge'

// Appearance is edited in the PC Settings window, never from this view.
const ignoreAppearanceUpdate = () => {}

export function DesktopSocialApp({ bridge }: { bridge: RitimSocialBridge }) {
  const appearance = useDesktopAppearance(bridge)
  const social = useDesktopSocialBridge(bridge)
  return (
    <AppearanceProvider active preferences={appearance} update={ignoreAppearanceUpdate}>
      <main className="desktop-social-root">
        <DesktopSocialHub state={social.state} actions={social.actions} />
      </main>
    </AppearanceProvider>
  )
}

export function DesktopSocialUnavailable() {
  return (
    <main className="desktop-social-root desktop-social-unavailable">
      <h1>Sosyal</h1>
      <p>Bu sayfa yalnızca Ritim masaüstü uygulamasının içinde çalışır.</p>
    </main>
  )
}
