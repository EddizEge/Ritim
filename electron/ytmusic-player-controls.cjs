// Beğeni / tekrar / karıştır / reklam durumunu resmi YouTube Music sayfasından
// okuyan ve gerçek düğmeye basan yardımcılar.
//
// Canlı DOM doğrulaması (2026-10-11, Electron 43, girişsiz, tr-TR):
// - Redux deposu `ytmusic-app.getState()` dil bağımsız gerçek kaynaktır:
//   `queue.repeatMode` ('NONE' | 'ALL' | 'ONE'; tekrar düğmesine her basış
//   NONE → ALL → ONE → NONE), `player.adPlaying` (reklamda true),
//   `likeStatus.videos[videoId]` ('LIKE' ...; beğeni tıklamasından sonra dolar)
//   ve `entities.likeStatusEntity[key].likeStatus` (key: videoId'yi içeren
//   base64url protobuf, ör. "EgtkUXc0dzlXZ1hjUSA-KAE%3D" → "\x12\x0bdQw4w9WgXcQ…").
// - Girişsiz oturumda `ytmusic-player-bar` hiç yoktu (ana sayfada da, /watch'ta da);
//   denetimler `ytmusic-miniplayer` içindeydi: `ytmusic-wiz-player-controls` →
//   `.ytmusicPlayerControls{Shuffle,Previous,PlayPause,Next,Repeat}Button button`
//   (tekrar aria-pressed'i yalnız kapalı/açık ayırır; ALL ile ONE'ı depo ayırır) ve
//   `yt-video-action-bar-view-model` → `like-button-view-model button[aria-pressed]`,
//   `dislike-button-view-model button[aria-pressed]`.
// - Reklamda `#movie_player` sınıfında `ad-showing` vardır.
// - Klasik düzen (`ytmusic-player-bar`; kullanıcının girişli oturumunda Beta 3 bununla
//   çalışıyor) bu ortamda görülemedi. Her yerde önce klasik seçici denenir, yeni düzen
//   yedektir; her basışın sonucu depodan / öznitelikten doğrulanır.
// aria-label / title metinleri dile göre değiştiği için kullanılmaz.

const LIKE_STATUSES = new Set(['LIKE', 'DISLIKE', 'INDIFFERENT'])
const REPEAT_MODES = ['NONE', 'ALL', 'ONE']
const RITIM_REPEAT = { NONE: 'off', ALL: 'all', ONE: 'one' }
const YTM_REPEAT = { off: 'NONE', all: 'ALL', one: 'ONE' }

function normalizeLikeStatus(value) {
  const status = String(value || '').trim().toUpperCase()
  return LIKE_STATUSES.has(status) ? status : ''
}

// 'NONE' | 'ALL' | 'ONE' ya da Ritim'in 'off' | 'all' | 'one' biçimini kabul eder.
function normalizeRepeatMode(value) {
  const raw = String(value || '').trim()
  if (YTM_REPEAT[raw.toLowerCase()]) return YTM_REPEAT[raw.toLowerCase()]
  const mode = raw.toUpperCase()
  return REPEAT_MODES.includes(mode) ? mode : ''
}

function toRitimRepeat(mode) {
  return RITIM_REPEAT[normalizeRepeatMode(mode)] || 'off'
}

function nextRepeatMode(mode) {
  const index = REPEAT_MODES.indexOf(normalizeRepeatMode(mode) || 'NONE')
  return REPEAT_MODES[(index + 1) % REPEAT_MODES.length]
}

// Sayfada çalışır: `(${readPlayerControlsInPage})(document, videoId)`.
// Kendi kendine yeterli olmalı; dış değişken kullanma.
function readPlayerControlsInPage(doc, videoId) {
  const likeValues = ['LIKE', 'DISLIKE', 'INDIFFERENT']
  const repeatValues = ['NONE', 'ALL', 'ONE']
  const pick = (value, allowed) => {
    const text = String(value || '').toUpperCase()
    return allowed.includes(text) ? text : ''
  }
  const id = String(videoId || '')
  let store = null
  try { store = doc.querySelector('ytmusic-app')?.getState?.() || null } catch { store = null }

  let likeStatus = ''
  let likeSource = ''
  if (id && store) {
    likeStatus = pick(store.likeStatus?.videos?.[id], likeValues)
    if (likeStatus) likeSource = 'store'
    if (!likeStatus) {
      const entities = store.entities?.likeStatusEntity || {}
      for (const key of Object.keys(entities)) {
        let decoded = ''
        try {
          decoded = atob(decodeURIComponent(key).replace(/-/g, '+').replace(/_/g, '/'))
        } catch { decoded = '' }
        if (!decoded.includes(id)) continue
        likeStatus = pick(entities[key]?.likeStatus, likeValues)
        if (likeStatus) {
          likeSource = 'entity'
          break
        }
      }
    }
  }
  if (!likeStatus) {
    likeStatus = pick(doc.querySelector('ytmusic-player-bar ytmusic-like-button-renderer')?.getAttribute('like-status'), likeValues)
    if (likeStatus) likeSource = 'player-bar'
  }
  if (!likeStatus) {
    const likeButton = doc.querySelector('ytmusic-miniplayer like-button-view-model button[aria-pressed]')
    const dislikeButton = doc.querySelector('ytmusic-miniplayer dislike-button-view-model button[aria-pressed]')
    if (likeButton || dislikeButton) {
      likeStatus = likeButton?.getAttribute('aria-pressed') === 'true'
        ? 'LIKE'
        : dislikeButton?.getAttribute('aria-pressed') === 'true' ? 'DISLIKE' : 'INDIFFERENT'
      likeSource = 'miniplayer'
    }
  }

  let repeatMode = pick(store?.queue?.repeatMode, repeatValues)
  let repeatSource = repeatMode ? 'store' : ''
  const bar = doc.querySelector('ytmusic-player-bar')
  if (!repeatMode && bar) {
    repeatMode = pick(bar.repeatMode_ ?? bar.repeatMode ?? bar.getAttribute?.('repeat-mode_') ?? bar.getAttribute?.('repeat-mode'), repeatValues)
    if (repeatMode) repeatSource = 'player-bar'
  }
  // Düğmenin aria-pressed değeri yalnız "kapalı"yı kesin söyler.
  for (const [selector, source] of [
    ['ytmusic-player-bar .repeat[aria-pressed]', 'player-bar-button'],
    ['.ytmusicPlayerControlsRepeatButton button[aria-pressed]', 'miniplayer'],
  ]) {
    if (repeatMode) break
    if (doc.querySelector(selector)?.getAttribute('aria-pressed') === 'false') {
      repeatMode = 'NONE'
      repeatSource = source
    }
  }

  const movie = doc.querySelector('#movie_player')
  const adPlaying = Boolean(store?.player?.adPlaying) || Boolean(movie?.classList?.contains('ad-showing'))
  return { likeStatus, likeSource, repeatMode, repeatSource, adPlaying }
}

// Sayfada çalışır: `(${clickPlayerControlInPage})(document, 'like')`.
// Önce klasik `ytmusic-player-bar`, sonra canlıda doğrulanan yeni düzen düğmesi.
// next / previous / playPause yalnız yeni düzen yedeğidir; klasik yolları köprüdedir.
function clickPlayerControlInPage(doc, kind) {
  const selectors = {
    like: [
      'ytmusic-player-bar ytmusic-like-button-renderer #button-shape-like button',
      'ytmusic-player-bar ytmusic-like-button-renderer .like button',
      'ytmusic-player-bar ytmusic-like-button-renderer tp-yt-paper-icon-button.like',
      'ytmusic-miniplayer like-button-view-model button',
    ],
    repeat: [
      'ytmusic-player-bar tp-yt-paper-icon-button.repeat',
      'ytmusic-player-bar .repeat button',
      'ytmusic-player-bar .repeat',
      '.ytmusicPlayerControlsRepeatButton button',
    ],
    shuffle: [
      'ytmusic-player-bar tp-yt-paper-icon-button.shuffle',
      'ytmusic-player-bar .shuffle button',
      'ytmusic-player-bar .shuffle',
      '.ytmusicPlayerControlsShuffleButton button',
    ],
    next: ['.ytmusicPlayerControlsNextButton button'],
    previous: ['.ytmusicPlayerControlsPreviousButton button'],
    playPause: ['.ytmusicPlayerControlsPlayPauseButton button'],
  }[kind] || []
  for (const selector of selectors) {
    const button = doc.querySelector(selector)
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') continue
    button.click()
    return true
  }
  return false
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForControls(read, predicate, { timeoutMs = 2500, intervalMs = 120 } = {}) {
  const startedAt = Date.now()
  let latest = await read()
  while (!predicate(latest) && Date.now() - startedAt < timeoutMs) {
    await delay(intervalMs)
    latest = await read()
  }
  return latest
}

function assertControllable(controls, videoId) {
  if (!videoId) throw new Error('YouTube Music’te çalan parça yok')
  if (controls?.adPlaying) throw new Error('Reklam sırasında kullanılamaz')
}

// Hedef: 'LIKE' ya da 'INDIFFERENT'. Kalp yalnız beğeniyi açar/kapatır;
// beğenilmemiş (DISLIKE) parçayı INDIFFERENT'e çekmek için tıklamaz.
// read(): readPlayerControlsInPage sonucu; click(kind): gerçek düğmeye basar.
async function applyLikeCommand({ target, videoId, read, click, timeoutMs, intervalMs }) {
  const desired = normalizeLikeStatus(target)
  if (desired !== 'LIKE' && desired !== 'INDIFFERENT') throw new Error('Geçersiz beğeni komutu')
  const before = await read()
  assertControllable(before, videoId)
  // Durum bilinmeden basmak beğenilmiş parçanın beğenisini kaldırabilir.
  if (!before.likeStatus) throw new Error('YouTube Music beğeni durumu okunamadı')
  const isDone = (controls) => desired === 'LIKE' ? controls?.likeStatus === 'LIKE' : controls?.likeStatus !== 'LIKE'
  if (isDone(before)) return before
  // Canlı denemede beğeniden hemen sonraki ikinci tıklama yutuldu, birkaç saniye
  // sonra basınca çalıştı. Durum hiç değişmediyse bir kez daha basılır.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await click('like'))) throw new Error('YouTube Music beğen düğmesi bulunamadı')
    const after = await waitForControls(read, (controls) => isDone(controls) && Boolean(controls.likeStatus), { timeoutMs, intervalMs })
    if (isDone(after) && after.likeStatus) return after
    if (after.likeStatus !== before.likeStatus) break
  }
  throw new Error('YouTube Music beğeniyi onaylamadı')
}

// Hedef moda ulaşana dek tekrar düğmesine basar (en çok iki basış).
async function applyRepeatCommand({ target, read, click, timeoutMs, intervalMs }) {
  const desired = normalizeRepeatMode(target)
  if (!desired) throw new Error('Geçersiz tekrar modu')
  let current = await read()
  if (current?.adPlaying) throw new Error('Reklam sırasında kullanılamaz')
  for (let step = 0; step < REPEAT_MODES.length; step += 1) {
    if (current.repeatMode === desired) return current
    const previous = current.repeatMode
    if (!(await click('repeat'))) throw new Error('YouTube Music tekrar düğmesi bulunamadı')
    current = await waitForControls(read, (controls) => controls?.repeatMode && controls.repeatMode !== previous, { timeoutMs, intervalMs })
    if (!current.repeatMode || current.repeatMode === previous) throw new Error('YouTube Music tekrar modunu değiştirmedi')
  }
  if (current.repeatMode === desired) return current
  throw new Error('YouTube Music tekrar modu hedefe ulaşmadı')
}

module.exports = {
  applyLikeCommand,
  applyRepeatCommand,
  clickPlayerControlInPage,
  nextRepeatMode,
  normalizeLikeStatus,
  normalizeRepeatMode,
  readPlayerControlsInPage,
  toRitimRepeat,
}
