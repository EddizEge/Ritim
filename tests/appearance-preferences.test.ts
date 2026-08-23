import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE_PREFERENCES,
  normalizeAppearancePreferences,
  readAppearancePreferences,
  visibleArtworkUrl,
  writeAppearancePreferences,
  type AppearanceStorage,
} from '../src/appearancePreferences'

function memoryStorage(initial?: string): AppearanceStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(APPEARANCE_STORAGE_KEY, initial)
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }
}

test('web görünüm tercihi sürümlü anahtarla normalize edilerek saklanır', () => {
  const storage = memoryStorage()
  const saved = writeAppearancePreferences({
    theme: 'black',
    density: 'compact',
    motion: 'reduced',
    artwork: 'hidden',
    accessToken: 'saklanmamali',
  }, storage)

  assert.deepEqual(saved, {
    theme: 'black',
    density: 'compact',
    motion: 'reduced',
    artwork: 'hidden',
  })
  assert.equal(storage.values.size, 1)
  assert.equal(storage.values.has(APPEARANCE_STORAGE_KEY), true)
  assert.equal(storage.values.get(APPEARANCE_STORAGE_KEY)?.includes('accessToken'), false)
  assert.deepEqual(readAppearancePreferences(storage), saved)
})

test('bozuk veya izin verilmeyen web tercihleri güvenli varsayılanlara döner', () => {
  assert.deepEqual(readAppearancePreferences(memoryStorage('{bozuk-json')), DEFAULT_APPEARANCE_PREFERENCES)
  assert.deepEqual(normalizeAppearancePreferences({
    theme: 'light',
    density: 'tiny',
    motion: true,
    artwork: 'remote',
  }), DEFAULT_APPEARANCE_PREFERENCES)
  assert.deepEqual(readAppearancePreferences(undefined), DEFAULT_APPEARANCE_PREFERENCES)
})

test('web depolaması kapalı olsa bile görünüm yardımcıları hata fırlatmaz', () => {
  const unavailableStorage: AppearanceStorage = {
    getItem() {
      throw new Error('storage disabled')
    },
    setItem() {
      throw new Error('storage disabled')
    },
  }
  assert.deepEqual(readAppearancePreferences(unavailableStorage), DEFAULT_APPEARANCE_PREFERENCES)
  assert.deepEqual(writeAppearancePreferences({ theme: 'dark' }, unavailableStorage), {
    theme: 'dark',
    density: 'comfortable',
    motion: 'system',
    artwork: 'full',
  })
})

test('gizli kapak tercihi uzak görsel adresini DOM katmanına göndermez', () => {
  const remote = 'https://lh3.googleusercontent.com/album-cover'
  assert.equal(visibleArtworkUrl(remote, 'full'), remote)
  assert.equal(visibleArtworkUrl(remote, 'reduced'), remote)
  assert.equal(visibleArtworkUrl(remote, 'hidden'), undefined)
  assert.equal(visibleArtworkUrl('   ', 'full'), undefined)
})
