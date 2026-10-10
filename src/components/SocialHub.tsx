// The shared social interface (phone and PC) lives in ./social; this module
// keeps the original import path for MobileApp, DesktopApp and the Electron
// Social view.
export { MobileSocialHub, type MobileSocialHubProps } from './social/MobileSocialHub'
export { DesktopSocialHub, type DesktopSocialHubProps } from './social/DesktopSocialHub'
