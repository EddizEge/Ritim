import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlayerControls } from '../src/components/PlayerControls'
import { initialPlayerState } from '../src/data'
import {
  NEXT_REPEAT,
  TOGGLE_CONFIRM_TIMEOUT_MS,
  canControlPlayback,
  findToggleByCommand,
  isTrackLiked,
  reconcileToggles,
  rollbackToggle,
  withLike,
  type PendingLike,
  type PendingRepeat,
} from '../src/playerToggles'
import type { PlayerActions, PlayerState, Track } from '../src/types'

const TRACK_ID = 'ytmusic:video:dQw4w9WgXcQ'
const OTHER_ID = 'ytmusic:video:S485kTzaV-c'

function ytTrack(id: string, videoId?: string): Track {
  return { id, title: id, artist: 'Rick Astley', collection: 'YouTube Music', duration: 213, cover: 0, youtubeVideoId: videoId, source: 'ytmusic' }
}

function pcState(patch: Partial<PlayerState> = {}): PlayerState {
  return {
    ...initialPlayerState,
    trackId: TRACK_ID,
    liked: [],
    repeat: 'off',
    shuffle: false,
    adPlaying: false,
    queue: [TRACK_ID, OTHER_ID],
    catalog: { [TRACK_ID]: ytTrack(TRACK_ID, 'dQw4w9WgXcQ'), [OTHER_ID]: ytTrack(OTHER_ID, 'S485kTzaV-c') },
    ...patch,
  }
}

const like = (liked: boolean, changedAt = 1000, trackId = TRACK_ID): PendingLike => ({ kind: 'like', trackId, liked, commandId: 'like-1', changedAt })
const repeat = (mode: PendingRepeat['repeat'], changedAt = 1000): PendingRepeat => ({ kind: 'repeat', repeat: mode, commandId: 'repeat-1', changedAt })

test('iyimser beğeni PC doğrulayana dek eski PC durumuyla ezilmez', () => {
  const stale = reconcileToggles(pcState({ liked: [] }), { like: like(true) }, 1500)
  assert.equal(isTrackLiked(stale.state), true)
  assert.equal(stale.state.likeStatus, 'LIKE')
  assert.ok(stale.pending.like)

  const confirmed = reconcileToggles(pcState({ liked: [TRACK_ID], likeStatus: 'LIKE' }), { like: like(true) }, 1600)
  assert.equal(isTrackLiked(confirmed.state), true)
  assert.equal(confirmed.pending.like, undefined)
})

test('zaman aşımı geçince ya da parça değişince PC durumu geçerli olur', () => {
  const expired = reconcileToggles(pcState({ liked: [] }), { like: like(true) }, 1000 + TOGGLE_CONFIRM_TIMEOUT_MS)
  assert.equal(isTrackLiked(expired.state), false)
  assert.equal(expired.pending.like, undefined)

  const changed = reconcileToggles(pcState({ trackId: OTHER_ID, liked: [] }), { like: like(true) }, 1500)
  assert.equal(isTrackLiked(changed.state), false)
  assert.equal(changed.pending.like, undefined)
})

test('iyimser tekrar modu doğrulanınca bırakılır, doğrulanmazsa beklenir', () => {
  const stale = reconcileToggles(pcState({ repeat: 'off' }), { repeat: repeat('all') }, 1200)
  assert.equal(stale.state.repeat, 'all')
  assert.ok(stale.pending.repeat)

  const confirmed = reconcileToggles(pcState({ repeat: 'all' }), { repeat: repeat('all') }, 1300)
  assert.equal(confirmed.state.repeat, 'all')
  assert.equal(confirmed.pending.repeat, undefined)

  const expired = reconcileToggles(pcState({ repeat: 'off' }), { repeat: repeat('all') }, 1000 + TOGGLE_CONFIRM_TIMEOUT_MS)
  assert.equal(expired.state.repeat, 'off')
})

test('başarısız komut iyimser değeri PC’nin son değerine geri alır', () => {
  const optimistic = withLike(pcState(), TRACK_ID, true)
  const authoritative = pcState({ liked: [], likeStatus: 'INDIFFERENT' })
  const reverted = rollbackToggle(optimistic, authoritative, like(true))
  assert.equal(isTrackLiked(reverted), false)
  assert.equal(reverted.likeStatus, 'INDIFFERENT')

  // PC durumu hiç gelmediyse iyimser değişikliğin tersi uygulanır.
  assert.equal(isTrackLiked(rollbackToggle(optimistic, null, like(true))), false)

  const repeated = rollbackToggle(pcState({ repeat: 'one' }), pcState({ repeat: 'all' }), repeat('one'))
  assert.equal(repeated.repeat, 'all')
  assert.equal(rollbackToggle(pcState({ repeat: 'all' }), null, repeat('all')).repeat, 'off')
})

test('ack kimliği bekleyen doğru komutu bulur', () => {
  const pending = { like: like(true), repeat: repeat('one') }
  assert.equal(findToggleByCommand(pending, 'like-1')?.kind, 'like')
  assert.equal(findToggleByCommand(pending, 'repeat-1')?.kind, 'repeat')
  assert.equal(findToggleByCommand(pending, 'seek-9'), undefined)
  assert.deepEqual(['off', 'all', 'one'].map((mode) => NEXT_REPEAT[mode as PendingRepeat['repeat']]), ['all', 'one', 'off'])
})

test('kalp/tekrar/karıştır parça yokken ve reklamda devre dışıdır', () => {
  assert.equal(canControlPlayback(pcState()), true)
  assert.equal(canControlPlayback(pcState({ adPlaying: true })), false)
  const idle = ytTrack('ytmusic:idle')
  assert.equal(canControlPlayback(pcState({ trackId: idle.id, catalog: { [idle.id]: idle } })), false)
  const hashed = ytTrack('ytmusic:abc')
  assert.equal(canControlPlayback(pcState({ trackId: hashed.id, catalog: { [hashed.id]: hashed } })), false)
  assert.equal(canControlPlayback(initialPlayerState), true)
})

const actions = new Proxy({}, { get: () => () => {} }) as PlayerActions
const render = (state: PlayerState) => renderToStaticMarkup(h(PlayerControls, { state, actions, large: true }))
const buttonFor = (markup: string, label: RegExp) => markup.match(new RegExp(`<button[^>]*aria-label="${label.source}"[^>]*>`))?.[0] || ''

test('telefon tekrar düğmesi gerçek modu gösterir, ONE için 1 işareti çıkar', () => {
  const off = render(pcState({ repeat: 'off' }))
  assert.match(buttonFor(off, /Tekrar kapalı/), /aria-pressed="false"/)
  assert.doesNotMatch(off, /repeat-one/)

  const all = render(pcState({ repeat: 'all' }))
  assert.match(buttonFor(all, /Tümünü tekrarla/), /class="is-active"/)
  assert.doesNotMatch(all, /repeat-one/)

  const one = render(pcState({ repeat: 'one' }))
  assert.match(buttonFor(one, /Bir parçayı tekrarla/), /aria-pressed="true"/)
  assert.match(one, /<span class="repeat-one">1<\/span>/)
})

test('karıştır YouTube Music’te basılı mod gibi görünmez; reklamda düğmeler kapalı', () => {
  const shuffled = render(pcState({ shuffle: true }))
  const shuffle = buttonFor(shuffled, /Karıştır/)
  assert.doesNotMatch(shuffle, /is-active/)
  assert.doesNotMatch(shuffle, /aria-pressed/)
  assert.doesNotMatch(shuffle, /disabled/)

  const ad = render(pcState({ adPlaying: true, repeat: 'all' }))
  assert.match(buttonFor(ad, /Karıştır/), /disabled=""/)
  assert.match(buttonFor(ad, /Tümünü tekrarla/), /disabled=""/)
  assert.doesNotMatch(buttonFor(ad, /Sonraki/), /disabled/)
})
