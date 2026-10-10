const musicButton = document.getElementById('music-button')
const socialButton = document.getElementById('social-button')
const settingsButton = document.getElementById('settings-button')
const connectionStatus = document.getElementById('connection-status')
const socialCount = document.getElementById('social-count')

let appearancePreferences = { theme: 'system', density: 'comfortable', motion: 'system', artwork: 'full' }
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
const appearanceValues = {
  theme: new Set(['system', 'dark', 'black']),
  density: new Set(['comfortable', 'compact']),
  motion: new Set(['system', 'reduced']),
  artwork: new Set(['full', 'reduced', 'hidden']),
}

function applyAppearancePreferences(value = {}) {
  appearancePreferences = {
    theme: appearanceValues.theme.has(value.theme) ? value.theme : 'system',
    density: appearanceValues.density.has(value.density) ? value.density : 'comfortable',
    motion: appearanceValues.motion.has(value.motion) ? value.motion : 'system',
    artwork: appearanceValues.artwork.has(value.artwork) ? value.artwork : 'full',
  }
  const root = document.documentElement
  root.dataset.theme = appearancePreferences.theme
  root.dataset.resolvedTheme = appearancePreferences.theme === 'system'
    ? systemThemeQuery.matches ? 'dark' : 'light'
    : appearancePreferences.theme
  root.dataset.density = appearancePreferences.density
  root.dataset.motion = appearancePreferences.motion
  root.dataset.artwork = appearancePreferences.artwork
}

systemThemeQuery.addEventListener('change', () => {
  if (appearancePreferences.theme === 'system') applyAppearancePreferences(appearancePreferences)
})

function setView(view) {
  const isSocial = view === 'social'
  musicButton.classList.toggle('is-active', !isSocial)
  socialButton.classList.toggle('is-active', isSocial)
}

// The Social view itself is a separate React renderer (desktop-social.html);
// the app bar only shows its badge: unread conversations + incoming requests.
function renderSocialSummary(summary = {}) {
  const unreadCount = Math.max(0, Math.floor(Number(summary.unreadCount) || 0))
  socialCount.hidden = unreadCount === 0
  socialCount.textContent = unreadCount > 99 ? '99+' : String(unreadCount)
  socialButton.setAttribute('aria-label', unreadCount ? `Sosyal, ${unreadCount} okunmamış` : 'Sosyal')
  connectionStatus.classList.toggle('is-online', Boolean(summary.companionConnected))
  connectionStatus.querySelector('span').textContent = summary.companionConnected ? 'Telefon senkron' : 'Telefon bağlı değil'
}

musicButton.addEventListener('click', () => window.ritimShell?.setView('music'))
socialButton.addEventListener('click', () => window.ritimShell?.setView('social'))
settingsButton.addEventListener('click', () => window.ritimShell?.openSettings())

window.ritimShell?.onViewChanged(setView)
window.ritimShell?.onAppearance(applyAppearancePreferences)
window.ritimShell?.onSocialSummary(renderSocialSummary)
window.ritimShell?.getSocialSummary().then(renderSocialSummary).catch(() => {})
window.ritimShell?.getAppearance().then(applyAppearancePreferences).catch(() => {})
window.ritimShell?.setView('music').then(setView)
applyAppearancePreferences(appearancePreferences)
renderSocialSummary()
