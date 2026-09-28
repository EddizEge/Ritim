const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  DEFAULT_APPEARANCE_PREFERENCES,
  createAppearanceStore,
  normalizeAppearancePreferences,
} = require('../electron/appearance-store.cjs')

test('Electron görünüm deposu yalnız izinli değerleri kabul eder', () => {
  assert.deepEqual(normalizeAppearancePreferences({
    theme: 'black',
    density: 'compact',
    motion: 'reduced',
    artwork: 'hidden',
    secret: 'sunucuya-gitmemeli',
  }), {
    theme: 'black',
    density: 'compact',
    motion: 'reduced',
    artwork: 'hidden',
  })
  assert.deepEqual(normalizeAppearancePreferences({
    theme: 'neon',
    density: 1,
    motion: null,
    artwork: ['full'],
  }), DEFAULT_APPEARANCE_PREFERENCES)
})

test('Electron görünüm deposu mevcut dosyanın üzerine tekrar tekrar atomik yazılır', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ritim-appearance-store-'))
  try {
    const store = createAppearanceStore(directory)
    assert.deepEqual(store.read(), DEFAULT_APPEARANCE_PREFERENCES)

    for (let index = 0; index < 20; index += 1) {
      const expectedTheme = index % 2 === 0 ? 'dark' : 'black'
      const expectedDensity = index % 3 === 0 ? 'compact' : 'comfortable'
      const updated = store.update({ theme: expectedTheme, density: expectedDensity })
      assert.equal(updated.theme, expectedTheme)
      assert.equal(updated.density, expectedDensity)
      assert.deepEqual(JSON.parse(fs.readFileSync(store.filePath, 'utf8')), updated)
    }

    const reopened = createAppearanceStore(directory)
    assert.deepEqual(reopened.read(), {
      theme: 'black',
      density: 'comfortable',
      motion: 'system',
      artwork: 'full',
    })
    assert.deepEqual(fs.readdirSync(directory), ['ritim-appearance-preferences.json'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('bozuk Electron görünüm dosyası güvenli varsayılanlara döner', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ritim-appearance-corrupt-'))
  try {
    const store = createAppearanceStore(directory)
    fs.writeFileSync(store.filePath, '{bozuk-json', 'utf8')
    assert.deepEqual(store.read(), DEFAULT_APPEARANCE_PREFERENCES)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
