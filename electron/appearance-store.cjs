const fs = require('node:fs')
const path = require('node:path')

const THEMES = new Set(['system', 'dark', 'black'])
const DENSITIES = new Set(['comfortable', 'compact'])
const MOTIONS = new Set(['system', 'reduced'])
const ARTWORK_MODES = new Set(['full', 'reduced', 'hidden'])

const DEFAULT_APPEARANCE_PREFERENCES = Object.freeze({
  theme: 'system',
  density: 'comfortable',
  motion: 'system',
  artwork: 'full',
})

function normalizeAppearancePreferences(value = {}) {
  const selected = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    theme: THEMES.has(selected.theme) ? selected.theme : DEFAULT_APPEARANCE_PREFERENCES.theme,
    density: DENSITIES.has(selected.density) ? selected.density : DEFAULT_APPEARANCE_PREFERENCES.density,
    motion: MOTIONS.has(selected.motion) ? selected.motion : DEFAULT_APPEARANCE_PREFERENCES.motion,
    artwork: ARTWORK_MODES.has(selected.artwork) ? selected.artwork : DEFAULT_APPEARANCE_PREFERENCES.artwork,
  }
}

function createAppearanceStore(userDataPath) {
  const filePath = path.join(userDataPath, 'ritim-appearance-preferences.json')
  let current

  function read() {
    if (current) return { ...current }
    try {
      current = normalizeAppearancePreferences(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    } catch {
      current = normalizeAppearancePreferences()
    }
    return { ...current }
  }

  function update(patch = {}) {
    current = normalizeAppearancePreferences({ ...read(), ...patch })
    fs.mkdirSync(userDataPath, { recursive: true })
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
      fs.renameSync(temporaryPath, filePath)
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true })
    }
    return read()
  }

  return { filePath, read, update }
}

module.exports = {
  DEFAULT_APPEARANCE_PREFERENCES,
  createAppearanceStore,
  normalizeAppearancePreferences,
}
