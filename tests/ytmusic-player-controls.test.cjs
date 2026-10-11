const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { io } = require('socket.io-client')
const { createDesktopKey, desktopSyncUrl, startSyncServer } = require('../electron/sync-server.cjs')
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

test('depo yoksa önce klasik like-status, o da yoksa yeni düzenin aria-pressed değeri okunur', () => {
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

// Klasik düzen: ytmusic-player-bar (kullanıcının girişli oturumunda beklenen yapı).
function classicPage({ store = null, repeatMode = 'NONE', likeStatus = 'INDIFFERENT', likeSelector = '#button-shape-like button', repeatAttr = false } = {}) {
  const repeatValues = ['NONE', 'ALL', 'ONE']
  const bar = {
    attrs: {},
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null },
  }
  if (repeatAttr) bar.attrs['repeat-mode'] = repeatMode
  else bar.repeatMode_ = repeatMode
  const page = { store, bar }
  const renderer = button({ 'like-status': likeStatus })
  const likeButton = button({}, () => {
    renderer.attrs['like-status'] = renderer.attrs['like-status'] === 'LIKE' ? 'INDIFFERENT' : 'LIKE'
  })
  const repeatButton = button({}, () => {
    if (page.store?.queue) {
      page.store.queue.repeatMode = repeatValues[(repeatValues.indexOf(page.store.queue.repeatMode) + 1) % 3]
      return
    }
    const current = repeatAttr ? bar.attrs['repeat-mode'] : bar.repeatMode_
    const next = repeatValues[(repeatValues.indexOf(current) + 1) % 3]
    if (repeatAttr) bar.attrs['repeat-mode'] = next
    else bar.repeatMode_ = next
  })
  const shuffleButton = button()
  const selectors = {
    'ytmusic-player-bar': bar,
    'ytmusic-player-bar ytmusic-like-button-renderer': renderer,
    [`ytmusic-player-bar ytmusic-like-button-renderer ${likeSelector}`]: likeButton,
    'ytmusic-player-bar tp-yt-paper-icon-button.repeat': repeatButton,
    'ytmusic-player-bar tp-yt-paper-icon-button.shuffle': shuffleButton,
  }
  page.document = {
    querySelector(selector) {
      if (selector === 'ytmusic-app') return page.store ? { getState: () => page.store } : null
      return Object.hasOwn(selectors, selector) ? selectors[selector] : null
    },
    getElementById: () => null,
  }
  page.buttons = { like: likeButton, repeat: repeatButton, shuffle: shuffleButton, renderer }
  page.read = () => inPage(readPlayerControlsInPage, VIDEO_ID)(page.document)
  page.click = (kind) => inPage(clickPlayerControlInPage, kind)(page.document)
  return page
}

test('klasik düzen: beğeni like-status özniteliğinden, tekrar player-bar özelliğinden okunur', () => {
  const page = classicPage({ repeatMode: 'ALL', likeStatus: 'LIKE' })
  assert.deepEqual(
    (({ likeStatus, likeSource, repeatMode, repeatSource }) => ({ likeStatus, likeSource, repeatMode, repeatSource }))(page.read()),
    { likeStatus: 'LIKE', likeSource: 'player-bar', repeatMode: 'ALL', repeatSource: 'player-bar' },
  )
  assert.equal(classicPage({ repeatMode: 'ONE', repeatAttr: true }).read().repeatMode, 'ONE')
  // Depo varsa depo önceliklidir.
  assert.equal(classicPage({ store: liveStore({ repeatMode: 'ONE' }), repeatMode: 'NONE' }).read().repeatMode, 'ONE')
})

test('klasik düzen: .repeat düğmesinin aria-pressed=false değeri tekrarı kapalı sayar', () => {
  const page = classicPage()
  delete page.bar.repeatMode_
  const pressed = button({ 'aria-pressed': 'false' })
  const original = page.document.querySelector
  page.document.querySelector = (selector) => selector === 'ytmusic-player-bar .repeat[aria-pressed]' ? pressed : original(selector)
  assert.equal(page.read().repeatMode, 'NONE')
  assert.equal(page.read().repeatSource, 'player-bar-button')
  pressed.attrs['aria-pressed'] = 'true'
  assert.equal(page.read().repeatMode, '')
})

test('klasik düzen: beğen, tekrar ve karıştır player-bar düğmelerine basar, sonuç öznitelikten doğrulanır', async () => {
  const page = classicPage()
  const liked = await applyLikeCommand({ target: 'LIKE', videoId: VIDEO_ID, read: page.read, click: page.click, timeoutMs: 60, intervalMs: 5 })
  assert.equal(liked.likeStatus, 'LIKE')
  assert.equal(page.buttons.like.clicks, 1)

  const one = await applyRepeatCommand({ target: 'one', read: page.read, click: page.click, timeoutMs: 60, intervalMs: 5 })
  assert.equal(one.repeatMode, 'ONE')
  assert.equal(page.buttons.repeat.clicks, 2)

  assert.equal(page.click('shuffle'), true)
  assert.equal(page.buttons.shuffle.clicks, 1)

  const alternative = classicPage({ likeSelector: '.like button' })
  await applyLikeCommand({ target: 'LIKE', videoId: VIDEO_ID, read: alternative.read, click: alternative.click, timeoutMs: 60, intervalMs: 5 })
  assert.equal(alternative.buttons.like.clicks, 1)
})

test('iki düzen birden varsa önce klasik düğmeye basılır', () => {
  const modern = fakePage({ store: liveStore() })
  const classic = classicPage({ store: modern.store })
  const both = {
    querySelector: (selector) => classic.document.querySelector(selector) || modern.document.querySelector(selector),
  }
  for (const kind of ['like', 'repeat', 'shuffle']) assert.equal(inPage(clickPlayerControlInPage, kind)(both), true)
  assert.deepEqual([classic.buttons.like.clicks, classic.buttons.repeat.clicks, classic.buttons.shuffle.clicks], [1, 1, 1])
  assert.deepEqual([modern.buttons.like.clicks, modern.buttons.repeat.clicks, modern.buttons.shuffle.clicks], [0, 0, 0])
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
    sendInputEvent(event) { page.onInput?.(event) },
    on() {},
    off() {},
  }
}

test('telefon komutu sync sunucusu ve köprü üzerinden gerçek düğmeye basar, durum ve ack döner', async (context) => {
  const distPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-kalp-'))
  await fs.writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>Ritim test</title>')
  // The desktop role needs the per-launch key (sync-server.cjs), as in main.cjs.
  const desktopKey = createDesktopKey()
  const server = startSyncServer(distPath, 0, { desktopKey })
  await new Promise((resolve) => server.once('listening', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const desktopUrl = desktopSyncUrl(baseUrl, desktopKey)
  const room = 'KALP-ROOM'
  const trackId = `ytmusic:video:${VIDEO_ID}`
  const page = fakePage({ store: liveStore() })
  const seed = await connectClient(desktopUrl)
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
      syncUrl: desktopUrl,
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

function offlineBridge(page) {
  // Komutlar doğrudan çağrılır; sync sunucusu gerekmez (bağlantı kurulamaz, sessizce yeniden dener).
  return createYouTubeMusicBridge({ webContents: fakeWebContents(page), room: 'KALP-OFFLINE', syncUrl: 'http://127.0.0.1:9' })
}

test('tekrar düğmesi hiç yoksa R kısayolu basılır ve sonuç depodan doğrulanır', async (context) => {
  const page = fakePage({ store: liveStore(), miniplayer: false })
  const keys = []
  page.onInput = (event) => {
    keys.push(`${event.type}:${event.keyCode}`)
    if (event.type === 'keyDown' && event.keyCode === 'R') page.store.queue.repeatMode = nextRepeatMode(page.store.queue.repeatMode)
  }
  const bridge = offlineBridge(page)
  context.after(() => bridge.destroy())
  await bridge.command({ type: 'repeat', value: 'all' })
  assert.equal(page.store.queue.repeatMode, 'ALL')
  assert.deepEqual(keys, ['keyDown:R', 'keyUp:R'])

  // Kısayol etki etmezse basış başarı sayılmaz.
  page.onInput = () => {}
  await assert.rejects(bridge.command({ type: 'repeat', value: 'one' }), /değiştirmedi/)
})

// Yeni düzen: ytmusic-player.playerApi yok, yalnız #movie_player ve ytmusic-wiz-player-controls.
function modernPlayerPage({ media = false, api = true, classicApi = null } = {}) {
  const videos = ['vid-one____', 'vid-two____']
  const page = { index: 0, calls: [], position: 10, volume: 100, playing: true }
  const call = (name, ...args) => page.calls.push([name, ...args])
  const movie = {
    classList: { contains: () => false },
    ...(api ? {
      getVideoData: () => ({ video_id: videos[page.index], title: `Parça ${page.index + 1}` }),
      getCurrentTime: () => page.position,
      seekTo: (seconds, allowSeekAhead) => { call('seekTo', seconds, allowSeekAhead); page.position = seconds },
      getVolume: () => page.volume,
      setVolume: (level) => { call('setVolume', level); page.volume = level },
      isMuted: () => false,
      unMute: () => call('unMute'),
      getPlayerState: () => (page.playing ? 1 : 2),
      playVideo: () => { call('playVideo'); page.playing = true },
      pauseVideo: () => { call('pauseVideo'); page.playing = false },
    } : {}),
  }
  const mediaElement = { duration: 213, currentTime: 10, paused: false, pause() { this.paused = true }, play() { this.paused = false; return Promise.resolve() } }
  const buttons = {
    next: button({}, () => { page.index = Math.min(videos.length - 1, page.index + 1); page.position = 0 }),
    previous: button({}, () => { page.index = Math.max(0, page.index - 1); page.position = 0 }),
    playPause: button({}, () => { page.playing = !page.playing }),
  }
  const queueItems = videos.map((videoId) => ({ data: { videoId }, querySelector: () => null }))
  const selectors = {
    '.ytmusicPlayerControlsNextButton button': buttons.next,
    '.ytmusicPlayerControlsPreviousButton button': buttons.previous,
    '.ytmusicPlayerControlsPlayPauseButton button': buttons.playPause,
    'ytmusic-player': classicApi ? { playerApi: classicApi } : null,
  }
  page.document = {
    querySelector: (selector) => (Object.hasOwn(selectors, selector) ? selectors[selector] : null),
    querySelectorAll: (selector) => {
      if (selector === 'video, audio') return media ? [mediaElement] : []
      if (selector === 'ytmusic-player-queue ytmusic-player-queue-item') return queueItems
      return []
    },
    getElementById: (id) => (id === 'movie_player' ? movie : null),
  }
  page.buttons = buttons
  page.media = mediaElement
  return page
}

test('yeni düzen: sonraki / önceki wiz düğmelerine basar, videoId #movie_player’dan doğrulanır', async (context) => {
  const page = modernPlayerPage()
  const bridge = offlineBridge(page)
  context.after(() => bridge.destroy())
  await bridge.command({ type: 'next' })
  assert.equal(page.buttons.next.clicks, 1)
  assert.equal(page.index, 1)
  await bridge.command({ type: 'previous' })
  assert.equal(page.buttons.previous.clicks, 1)
  assert.equal(page.index, 0)
})

test('yeni düzen: medya öğesi yokken oynat / duraklat #movie_player API’siyle, API yoksa wiz düğmesiyle', async (context) => {
  const page = modernPlayerPage()
  const bridge = offlineBridge(page)
  context.after(() => bridge.destroy())
  await bridge.command({ type: 'togglePlay' })
  await bridge.command({ type: 'togglePlay' })
  assert.deepEqual(page.calls, [['pauseVideo'], ['playVideo']])

  const noApi = modernPlayerPage({ api: false })
  const keys = []
  const bridgeNoApi = createYouTubeMusicBridge({
    webContents: { ...fakeWebContents(noApi), sendInputEvent: (event) => keys.push(event.keyCode) },
    room: 'KALP-OFFLINE',
    syncUrl: 'http://127.0.0.1:9',
  })
  context.after(() => bridgeNoApi.destroy())
  await bridgeNoApi.command({ type: 'togglePlay' })
  assert.equal(noApi.buttons.playPause.clicks, 1)
  assert.deepEqual(keys, [])
})

test('medya öğesi varsa oynat / duraklat ve sarma eskisi gibi medya öğesiyle yapılır', async (context) => {
  const page = modernPlayerPage({ media: true })
  const bridge = offlineBridge(page)
  context.after(() => bridge.destroy())
  await bridge.command({ type: 'togglePlay' })
  assert.equal(page.media.paused, true)
  await bridge.command({ type: 'seek', value: 42 })
  assert.equal(page.media.currentTime, 42)
  assert.deepEqual(page.calls, [])
})

test('yeni düzen: medya öğesi yokken sarma seekTo, ses seviyesi setVolume ile uygulanır', async (context) => {
  const page = modernPlayerPage()
  const bridge = offlineBridge(page)
  context.after(() => bridge.destroy())
  await bridge.command({ type: 'seek', value: 42 })
  assert.deepEqual(page.calls[0], ['seekTo', 42, true])
  await bridge.command({ type: 'setVolume', value: 30 })
  assert.ok(page.calls.some(([name, level]) => name === 'setVolume' && level === 30))
  assert.equal(page.volume, 30)
})

test('klasik ytmusic-player.playerApi varsa #movie_player yerine o kullanılır', async (context) => {
  const classicCalls = []
  const classicApi = {
    getVideoData: () => ({ video_id: 'classic____' }),
    setVolume: (level) => classicCalls.push(['setVolume', level]),
    getVolume: () => 55,
    isMuted: () => false,
    unMute: () => {},
  }
  const page = modernPlayerPage({ classicApi })
  const bridge = offlineBridge(page)
  context.after(() => bridge.destroy())
  await bridge.command({ type: 'setVolume', value: 55 })
  assert.deepEqual(classicCalls[0], ['setVolume', 55])
  assert.ok(!page.calls.some(([name]) => name === 'setVolume'))
})
