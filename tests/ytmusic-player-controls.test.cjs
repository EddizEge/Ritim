const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { io } = require('socket.io-client')
const { startSyncServer } = require('../electron/sync-server.cjs')
const { createYouTubeMusicBridge } = require('../electron/ytmusic-bridge.cjs')
const {
  applyLikeCommand,
  applyRepeatCommand,
  clickPlayerControlInPage,
  nextRepeatMode,
  normalizeLikeStatus,
  normalizeRepeatMode,
  readPlayerControlsInPage,
  toRitimRepeat,
} = require('../electron/ytmusic-player-controls.cjs')

const VIDEO_ID = 'dQw4w9WgXcQ'
// Canlı sayfadan alınan gerçek likeStatusEntity anahtarları (2026-10-11).
const ENTITY_KEY = 'EgtkUXc0dzlXZ1hjUSA-KAE%3D'
const OTHER_ENTITY_KEY = 'EgtTNDg1a1R6YVYtYyA-KAE%3D'

// Köprü, sayfa işlevlerini kaynak metin olarak sayfaya gönderir; testte de öyle çalıştır.
function inPage(fn, ...args) {
  return new Function('document', `return (${fn})(document, ...${JSON.stringify(args)})`)
}

function button(attrs = {}, onClick) {
  return {
    attrs: { ...attrs },
    disabled: false,
    clicks: 0,
    getAttribute(name) {
      return Object.hasOwn(this.attrs, name) ? String(this.attrs[name]) : null
    },
    click() {
      this.clicks += 1
      onClick?.()
    },
  }
}

// Doğrulanmış seçicilere göre çalışan küçük sahte YouTube Music sayfası.
function fakePage({ store = null, likeStatusAttr, miniplayer = true, movieClasses = [], likeAccepted = true } = {}) {
  const repeatValues = ['NONE', 'ALL', 'ONE']
  const page = { store, likeAccepted }
  const repeatButton = button({ 'aria-pressed': 'false' }, () => {
    if (!page.store?.queue) return
    const index = repeatValues.indexOf(page.store.queue.repeatMode)
    page.store.queue.repeatMode = repeatValues[(index + 1) % repeatValues.length]
    repeatButton.attrs['aria-pressed'] = String(page.store.queue.repeatMode !== 'NONE')
  })
  const likeButton = button({ 'aria-pressed': 'false' }, () => {
    if (!page.likeAccepted || !page.store) return
    const videos = page.store.likeStatus.videos
    videos[VIDEO_ID] = videos[VIDEO_ID] === 'LIKE' ? 'INDIFFERENT' : 'LIKE'
    likeButton.attrs['aria-pressed'] = String(videos[VIDEO_ID] === 'LIKE')
  })
  const dislikeButton = button({ 'aria-pressed': 'false' })
  const shuffleButton = button({ 'aria-pressed': 'false' })
  const oldLikeRenderer = likeStatusAttr ? button({ 'like-status': likeStatusAttr }) : null
  const movie = {
    classList: { contains: (name) => movieClasses.includes(name) },
    getVideoData: () => ({ video_id: VIDEO_ID }),
  }
  const selectors = {
    'ytmusic-miniplayer like-button-view-model button[aria-pressed]': miniplayer ? likeButton : null,
    'ytmusic-miniplayer dislike-button-view-model button[aria-pressed]': miniplayer ? dislikeButton : null,
    'ytmusic-miniplayer like-button-view-model button': miniplayer ? likeButton : null,
    '.ytmusicPlayerControlsRepeatButton button[aria-pressed]': miniplayer ? repeatButton : null,
    '.ytmusicPlayerControlsRepeatButton button': miniplayer ? repeatButton : null,
    '.ytmusicPlayerControlsShuffleButton button': miniplayer ? shuffleButton : null,
    'ytmusic-player-bar ytmusic-like-button-renderer': oldLikeRenderer,
    '#movie_player': movie,
  }
  page.document = {
    querySelector(selector) {
      if (selector === 'ytmusic-app') return page.store ? { getState: () => page.store } : null
      return Object.hasOwn(selectors, selector) ? selectors[selector] : null
    },
    getElementById(id) {
      return id === 'movie_player' ? movie : null
    },
  }
  page.buttons = { like: likeButton, dislike: dislikeButton, repeat: repeatButton, shuffle: shuffleButton }
  page.read = () => inPage(readPlayerControlsInPage, VIDEO_ID)(page.document)
  page.click = (kind) => inPage(clickPlayerControlInPage, kind)(page.document)
  return page
}

function liveStore({ likeStatus = undefined, entityStatus = 'INDIFFERENT', repeatMode = 'NONE', adPlaying = false } = {}) {
  return {
    queue: { repeatMode, shuffleEnabled: false, items: [] },
    player: { adPlaying, isPlaying: true },
    likeStatus: { videos: likeStatus ? { [VIDEO_ID]: likeStatus } : {}, playlists: {} },
    entities: {
      likeStatusEntity: {
        [OTHER_ENTITY_KEY]: { key: OTHER_ENTITY_KEY, likeStatus: 'LIKE' },
        [ENTITY_KEY]: { key: ENTITY_KEY, likeStatus: entityStatus },
      },
    },
  }
}

test('beğeni ve tekrar dil bağımsız değerlere normalize edilir', () => {
  assert.equal(normalizeLikeStatus('like'), 'LIKE')
  assert.equal(normalizeLikeStatus('Beğen'), '')
  assert.equal(normalizeRepeatMode('ONE'), 'ONE')
  assert.equal(normalizeRepeatMode('all'), 'ALL')
  assert.equal(normalizeRepeatMode('off'), 'NONE')
  assert.equal(normalizeRepeatMode('REPEAT_MODE_UNKNOWN'), '')
  assert.equal(toRitimRepeat('NONE'), 'off')
  assert.equal(toRitimRepeat('ALL'), 'all')
  assert.equal(toRitimRepeat('ONE'), 'one')
  assert.deepEqual(['NONE', 'ALL', 'ONE'].map(nextRepeatMode), ['ALL', 'ONE', 'NONE'])
})

test('beğeni durumu önce depodaki video kaydından, sonra varlık anahtarından okunur', () => {
  const fromVideos = fakePage({ store: liveStore({ likeStatus: 'LIKE', entityStatus: 'INDIFFERENT' }) }).read()
  assert.equal(fromVideos.likeStatus, 'LIKE')
  assert.equal(fromVideos.likeSource, 'store')

  // Varlık anahtarı videoId'yi içeren base64url protobuf'tur; başka videonun LIKE kaydı karışmamalı.
  const fromEntity = fakePage({ store: liveStore({ entityStatus: 'INDIFFERENT' }) }).read()
  assert.equal(fromEntity.likeStatus, 'INDIFFERENT')
  assert.equal(fromEntity.likeSource, 'entity')
})

test('depo yoksa yeni düzenin aria-pressed değeri, o da yoksa eski like-status okunur', () => {
  const liked = fakePage()
  liked.buttons.like.attrs['aria-pressed'] = 'true'
  assert.equal(liked.read().likeStatus, 'LIKE')
  assert.equal(liked.read().likeSource, 'miniplayer')

  const disliked = fakePage()
  disliked.buttons.dislike.attrs['aria-pressed'] = 'true'
  assert.equal(disliked.read().likeStatus, 'DISLIKE')

  assert.equal(fakePage().read().likeStatus, 'INDIFFERENT')

  const oldLayout = fakePage({ miniplayer: false, likeStatusAttr: 'LIKE' }).read()
  assert.equal(oldLayout.likeStatus, 'LIKE')
  assert.equal(oldLayout.likeSource, 'player-bar')

  assert.equal(fakePage({ miniplayer: false }).read().likeStatus, '')
})

test('tekrar modu depodan okunur; depo yoksa düğme yalnız kapalıyı kesin söyler', () => {
  assert.equal(fakePage({ store: liveStore({ repeatMode: 'ONE' }) }).read().repeatMode, 'ONE')
  const noStore = fakePage()
  assert.equal(noStore.read().repeatMode, 'NONE')
  noStore.buttons.repeat.attrs['aria-pressed'] = 'true'
  assert.equal(noStore.read().repeatMode, '')
})

test('reklam depodan ya da #movie_player.ad-showing sınıfından anlaşılır', () => {
  assert.equal(fakePage({ store: liveStore({ adPlaying: true }) }).read().adPlaying, true)
  assert.equal(fakePage({ movieClasses: ['html5-video-player', 'ad-showing'] }).read().adPlaying, true)
  assert.equal(fakePage({ store: liveStore() }).read().adPlaying, false)
})

test('düğme tıklaması devre dışı ya da bilinmeyen düğmeye basmaz', () => {
  const page = fakePage({ store: liveStore() })
  page.buttons.repeat.disabled = true
  assert.equal(page.click('repeat'), false)
  assert.equal(page.buttons.repeat.clicks, 0)
  assert.equal(page.click('shuffle'), true)
  assert.equal(page.buttons.shuffle.clicks, 1)
  assert.equal(page.click('unknown'), false)
})

const fast = { timeoutMs: 60, intervalMs: 5 }

test('beğen komutu gerçek düğmeye basar ve depodan doğrular', async () => {
  const page = fakePage({ store: liveStore() })
  const result = await applyLikeCommand({ target: 'LIKE', videoId: VIDEO_ID, read: page.read, click: page.click, ...fast })
  assert.equal(result.likeStatus, 'LIKE')
  assert.equal(page.buttons.like.clicks, 1)

  // Zaten beğenilmişse yeniden basmaz (beğeniyi kaldırmaz).
  await applyLikeCommand({ target: 'LIKE', videoId: VIDEO_ID, read: page.read, click: page.click, ...fast })
  assert.equal(page.buttons.like.clicks, 1)

  const removed = await applyLikeCommand({ target: 'INDIFFERENT', videoId: VIDEO_ID, read: page.read, click: page.click, ...fast })
  assert.equal(removed.likeStatus, 'INDIFFERENT')
  assert.equal(page.buttons.like.clicks, 2)
})

test('kalp kapatma beğenilmemiş (DISLIKE) parçaya dokunmaz', async () => {
  const page = fakePage({ store: liveStore({ likeStatus: 'DISLIKE' }) })
  const result = await applyLikeCommand({ target: 'INDIFFERENT', videoId: VIDEO_ID, read: page.read, click: page.click, ...fast })
  assert.equal(result.likeStatus, 'DISLIKE')
  assert.equal(page.buttons.like.clicks, 0)
})

test('beğen komutu reklamda, parça yokken ve durum bilinmezken basmadan reddedilir', async () => {
  const ad = fakePage({ store: liveStore({ adPlaying: true }) })
  await assert.rejects(applyLikeCommand({ target: 'LIKE', videoId: VIDEO_ID, read: ad.read, click: ad.click, ...fast }), /Reklam/)
  assert.equal(ad.buttons.like.clicks, 0)

  const idle = fakePage({ store: liveStore() })
  await assert.rejects(applyLikeCommand({ target: 'LIKE', videoId: '', read: idle.read, click: idle.click, ...fast }), /çalan parça yok/)

  const unknown = fakePage({ miniplayer: false })
  await assert.rejects(applyLikeCommand({ target: 'LIKE', videoId: VIDEO_ID, read: unknown.read, click: unknown.click, ...fast }), /okunamadı/)

  await assert.rejects(applyLikeCommand({ target: 'TOGGLE', videoId: VIDEO_ID, read: idle.read, click: idle.click, ...fast }), /Geçersiz/)
})

test('YouTube Music beğeniyi kabul etmezse bir kez daha basılır, yine olmazsa komut başarısız olur', async () => {
  const page = fakePage({ store: liveStore(), likeAccepted: false })
  await assert.rejects(applyLikeCommand({ target: 'LIKE', videoId: VIDEO_ID, read: page.read, click: page.click, ...fast }), /onaylamadı/)
  assert.equal(page.buttons.like.clicks, 2)
})

test('yutulan ilk beğeni tıklamasından sonra ikinci basış durumu değiştirir', async () => {
  const page = fakePage({ store: liveStore({ likeStatus: 'LIKE' }), likeAccepted: false })
  const click = (kind) => {
    const clicked = page.click(kind)
    page.likeAccepted = true
    return clicked
  }
  const result = await applyLikeCommand({ target: 'INDIFFERENT', videoId: VIDEO_ID, read: page.read, click, ...fast })
  assert.equal(result.likeStatus, 'INDIFFERENT')
  assert.equal(page.buttons.like.clicks, 2)
})

test('tekrar komutu hedef moda kadar basar: NONE → ONE iki, ONE → ALL iki basış', async () => {
  const page = fakePage({ store: liveStore() })
  const one = await applyRepeatCommand({ target: 'one', read: page.read, click: page.click, ...fast })
  assert.equal(one.repeatMode, 'ONE')
  assert.equal(page.buttons.repeat.clicks, 2)

  const all = await applyRepeatCommand({ target: 'ALL', read: page.read, click: page.click, ...fast })
  assert.equal(all.repeatMode, 'ALL')
  assert.equal(page.buttons.repeat.clicks, 4)

  await applyRepeatCommand({ target: 'all', read: page.read, click: page.click, ...fast })
  assert.equal(page.buttons.repeat.clicks, 4)
})

test('tekrar düğmesi tepki vermezse ya da reklam varsa komut başarısız olur', async () => {
  const stuck = fakePage({ store: liveStore() })
  stuck.buttons.repeat.click = function click() { this.clicks += 1 }
  await assert.rejects(applyRepeatCommand({ target: 'ALL', read: stuck.read, click: stuck.click, ...fast }), /değiştirmedi/)

  const ad = fakePage({ store: liveStore({ adPlaying: true }) })
  await assert.rejects(applyRepeatCommand({ target: 'ALL', read: ad.read, click: ad.click, ...fast }), /Reklam/)
  assert.equal(ad.buttons.repeat.clicks, 0)

  await assert.rejects(applyRepeatCommand({ target: 'SOMETIMES', read: ad.read, click: ad.click, ...fast }), /Geçersiz/)
})

function waitForEvent(socket, event, predicate = () => true, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent)
      reject(new Error(`${event} olayı zamanında gelmedi`))
    }, timeoutMs)
    const onEvent = (payload) => {
      if (!predicate(payload)) return
      clearTimeout(timer)
      socket.off(event, onEvent)
      resolve(payload)
    }
    socket.on(event, onEvent)
  })
}

async function connectClient(baseUrl) {
  const socket = io(baseUrl, { forceNew: true, reconnection: false })
  if (!socket.connected) await waitForEvent(socket, 'connect')
  return socket
}

// Electron webContents yerine: köprünün gönderdiği betiği sahte sayfada çalıştırır.
function fakeWebContents(page) {
  return {
    isDestroyed: () => false,
    getURL: () => 'about:blank',
    executeJavaScript: async (code) => new Function('document', `return (${code.trim()})`)(page.document),
    isCurrentlyAudible: () => false,
    focus() {},
    sendInputEvent() {},
    on() {},
    off() {},
  }
}

test('telefon komutu sync sunucusu ve köprü üzerinden gerçek düğmeye basar, durum ve ack döner', async (context) => {
  const distPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-kalp-'))
  await fs.writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>Ritim test</title>')
  const server = startSyncServer(distPath, 0)
  await new Promise((resolve) => server.once('listening', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const room = 'KALP-ROOM'
  const trackId = `ytmusic:video:${VIDEO_ID}`
  const page = fakePage({ store: liveStore() })
  const seed = await connectClient(baseUrl)
  const companion = await connectClient(baseUrl)
  let bridge
  context.after(async () => {
    bridge?.destroy()
    seed.close()
    companion.close()
    await server.io.close()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(distPath, { recursive: true, force: true })
  })

  // Çalan parça bilgisini köprüye odadaki son durum olarak ver (gerçekte capture yazar).
  const seeded = waitForEvent(seed, 'room:status')
  seed.emit('room:join', {
    room,
    role: 'desktop',
    state: {
      trackId,
      catalog: { [trackId]: { id: trackId, title: 'Never Gonna Give You Up', artist: 'Rick Astley', youtubeVideoId: VIDEO_ID, source: 'ytmusic' } },
      liked: [],
      repeat: 'off',
      shuffle: false,
      queue: [trackId],
    },
  })
  await seeded

  const bridgeStates = []
  const bridgeReady = new Promise((resolve) => {
    bridge = createYouTubeMusicBridge({
      webContents: fakeWebContents(page),
      room,
      syncUrl: baseUrl,
      onState: (state) => {
        bridgeStates.push(state)
        if (state.trackId === trackId) resolve()
      },
    })
  })
  await bridgeReady

  const companionJoined = waitForEvent(companion, 'room:status')
  companion.emit('room:join', { room, role: 'companion', state: {} })
  await companionJoined

  const likedState = waitForEvent(companion, 'player:state', (state) => state.liked?.includes(trackId))
  const likeAck = waitForEvent(companion, 'player:command:ack', (ack) => ack.id === 'like-1')
  companion.emit('player:command', { room, command: { id: 'like-1', type: 'like', value: 'LIKE', issuedAt: Date.now() } })
  const [state, ack] = await Promise.all([likedState, likeAck])
  assert.equal(ack.status, 'applied')
  assert.equal(state.likeStatus, 'LIKE')
  assert.equal(page.buttons.like.clicks, 1)
  assert.equal(page.store.likeStatus.videos[VIDEO_ID], 'LIKE')

  const repeatState = waitForEvent(companion, 'player:state', (next) => next.repeat === 'one')
  const repeatAck = waitForEvent(companion, 'player:command:ack', (next) => next.id === 'repeat-1')
  companion.emit('player:command', { room, command: { id: 'repeat-1', type: 'repeat', value: 'one', issuedAt: Date.now() } })
  const [afterRepeat, ackRepeat] = await Promise.all([repeatState, repeatAck])
  assert.equal(ackRepeat.status, 'applied')
  assert.equal(afterRepeat.shuffle, false)
  assert.equal(page.buttons.repeat.clicks, 2)

  // Eski telefon sürümünün cycleRepeat komutu da gerçek düğmeye basar: ONE → NONE.
  const cycledState = waitForEvent(companion, 'player:state', (next) => next.repeat === 'off')
  companion.emit('player:command', { room, command: { id: 'cycle-1', type: 'cycleRepeat', issuedAt: Date.now() } })
  await cycledState
  assert.equal(page.buttons.repeat.clicks, 3)

  page.store.player.adPlaying = true
  const adAck = waitForEvent(companion, 'player:command:ack', (next) => next.id === 'like-ad')
  companion.emit('player:command', { room, command: { id: 'like-ad', type: 'like', value: 'INDIFFERENT', issuedAt: Date.now() } })
  const failed = await adAck
  assert.equal(failed.status, 'failed')
  assert.match(failed.message, /Reklam/)
  assert.equal(page.buttons.like.clicks, 1)
})
