import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopSocialApp, DesktopSocialUnavailable } from './DesktopSocialApp'
import type { RitimSocialBridge } from './desktopSocialStore'
import '../styles.css'
import './desktopSocial.css'

declare global {
  interface Window {
    ritimSocial?: RitimSocialBridge
  }
}

// Electron's Social view (electron/social-preload.cjs) provides the bridge;
// opened anywhere else (e.g. from the Sync server's dist/) the page explains
// itself instead of trying to reach Ritim Social.
const bridge = window.ritimSocial

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {bridge ? <DesktopSocialApp bridge={bridge} /> : <DesktopSocialUnavailable />}
  </StrictMode>,
)
