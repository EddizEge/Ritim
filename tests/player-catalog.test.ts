import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { CATALOG_RECENT_LIMIT, mergeCatalogTracks, pruneCatalog } from '../shared/player-catalog.mjs'
import { getTrack, initialPlayerState } from '../src/data'
import { PLAYER_CACHE_KEY, readCachedPlayerState, writeCachedPlayerState } from '../src/playerCache'
import type { PlayerState, Track } from '../src/types'

const require = createRequire(import.meta.url)

const track = (index: number): Track => ({
  id: `ytmusic:video:v${String(index).padStart(10, '0')}`,
  title: `Parça ${index}`,
  artist: 'Sanatçı',
  collection: 'Sıradaki',
  duration: 200,
  cover: 0,
  youtubeVideoId: `v${String(index).padStart(10, '0')}`,
  source: 'ytmusic',
})

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

// Köprünün capture adımıyla aynı birleştirme: sıra eklenir, çalan parça güncellenir, budanır.
function simulateSession(steps: number, likedEvery = 0) {
  let catalog: Record<string, Track> = {}
  let liked: string[] = []
  let current = track(0)
  let queueIds: string[] = []
  let maxSize = 0
  for (let index = 0; index < steps; index += 1) {
    current = track(index)
    const queue = Array.from({ length: 20 }, (_, offset) => track(index + offset))
    catalog = mergeCatalogTracks(catalog, queue)
    catalog[current.id] = { ...catalog[current.id], ...current }
    queueIds = queue.map((item) => item.id)
    if (likedEvery && index % likedEvery === 0) liked = [...liked, current.id]
    catalog = pruneCatalog(catalog, { trackId: current.id, queue: queueIds, liked })
    maxSize = Math.max(maxSize, Object.keys(catalog).length)
  }
  return { catalog, liked, current, queueIds, maxSize }
}

test('1000 parçalık oturumdan sonra katalog sınırda kalır', () => {
  const session = simulateSession(1000)
  // Sıra (20) çalan parçayı içerir; zorunlu kayıtlar + en yeni 150.
  assert.ok(session.maxSize <= CATALOG_RECENT_LIMIT + 20, `katalog ${session.maxSize} kayda çıktı`)
  assert.equal(Object.keys(session.catalog).length, CATALOG_RECENT_LIMIT + 20)
})

test('çalan parça, sıra ve beğenilenler her zaman katalogda kalır', () => {
  const session = simulateSession(1000, 97)
  assert.ok(session.catalog[session.current.id])
  for (const id of session.queueIds) assert.ok(session.catalog[id], `${id} sıradan düştü`)
  assert.ok(session.liked.length >= 10)
  for (const id of session.liked) assert.ok(session.catalog[id], `${id} beğenilenlerden düştü`)
  assert.ok(Object.keys(session.catalog).length <= CATALOG_RECENT_LIMIT + 20 + session.liked.length)
})

test('güncellenen kayıt en yeni sayılır; eskiler ekleme sırasıyla düşer', () => {
  let catalog = mergeCatalogTracks({}, [track(1), track(2), track(3)])
  catalog = mergeCatalogTracks(catalog, [{ ...track(1), title: 'Yeni başlık' }])
  assert.deepEqual(Object.keys(catalog), [track(2).id, track(3).id, track(1).id])
  assert.equal(catalog[track(1).id].title, 'Yeni başlık')

  const pruned = pruneCatalog(catalog, { trackId: track(2).id }, 1)
  assert.deepEqual(Object.keys(pruned), [track(2).id, track(1).id])
  // Sınırın altındaysa aynı nesne döner (gereksiz kopya yok).
  assert.equal(pruneCatalog(catalog, {}, 10), catalog)
})

test('köprü katalog yardımcısını require(esm) ile yükler', () => {
  const shared = require('../shared/player-catalog.mjs') as { CATALOG_RECENT_LIMIT: number }
  assert.equal(shared.CATALOG_RECENT_LIMIT, CATALOG_RECENT_LIMIT)
  assert.doesNotThrow(() => require('../electron/ytmusic-bridge.cjs'))
})

function bigState(): PlayerState {
  const tracks = Array.from({ length: 1000 }, (_, index) => track(index))
  const catalog = Object.fromEntries(tracks.map((item) => [item.id, item]))
  return {
    ...initialPlayerState,
    trackId: tracks[500].id,
    queue: tracks.slice(500, 520).map((item) => item.id),
    liked: [tracks[3].id],
    catalog,
    position: 42,
    isPlaying: true,
  }
}

test('telefon önbelleği budanmış ama eksiksiz yazılır ve okunur', () => {
  const storage = memoryStorage()
  const state = bigState()
  writeCachedPlayerState(state, storage)
  const raw = JSON.parse(storage.values.get(PLAYER_CACHE_KEY) || '{}')
  assert.equal(raw.version, 2)
  assert.ok(Object.keys(raw.state.catalog).length <= CATALOG_RECENT_LIMIT + 21)

  const cached = readCachedPlayerState(storage)
  assert.ok(cached)
  assert.equal(cached.trackId, state.trackId)
  assert.deepEqual(cached.queue, state.queue)
  assert.equal(cached.position, 0)
  assert.equal(cached.isPlaying, false)
  for (const id of [state.trackId, ...state.queue, ...state.liked]) assert.deepEqual(cached.catalog[id], state.catalog[id])
  assert.equal(getTrack(cached).title, 'Parça 500')
})

test('eski sürümün büyük önbelleği okurken budanır; bozuk önbellek yok sayılır', () => {
  const storage = memoryStorage()
  const state = bigState()
  storage.setItem(PLAYER_CACHE_KEY, JSON.stringify({ version: 2, savedAt: 1, state }))
  const cached = readCachedPlayerState(storage)
  assert.ok(cached)
  assert.ok(Object.keys(cached.catalog).length <= CATALOG_RECENT_LIMIT + 21)
  assert.ok(cached.catalog[state.trackId])

  storage.setItem(PLAYER_CACHE_KEY, '{bozuk')
  assert.equal(readCachedPlayerState(storage), null)
  storage.setItem(PLAYER_CACHE_KEY, JSON.stringify({ version: 2, state: { ...state, liked: undefined } }))
  assert.deepEqual(readCachedPlayerState(storage)?.liked, [])
})

test('katalogda olmayan kimlik telefonda çökmeye yol açmaz', () => {
  const state = { ...bigState(), trackId: 'ytmusic:video:budanmis000' }
  assert.doesNotThrow(() => getTrack(state))
  assert.ok(getTrack(state).title)
})
