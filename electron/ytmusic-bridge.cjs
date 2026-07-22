const crypto = require('node:crypto')
const { io } = require('socket.io-client')

function trackId(title, artist) {
  return `ytmusic:${crypto.createHash('sha1').update(`${title}|${artist}`).digest('hex').slice(0, 14)}`
}

function parseDuration(value) {
  const parts = String(value || '').trim().split(':').map(Number)
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return 0
  return parts.reduce((total, part) => total * 60 + part, 0)
}

function createYouTubeMusicBridge({ webContents, presence, room = 'EDIZ-4821', syncUrl = 'http://127.0.0.1:8787' }) {
  const idleTrack = {
    id: 'ytmusic:idle', title: 'YouTube Music', artist: 'Bir parça çal', collection: 'music.youtube.com',
    duration: 0, cover: 0, source: 'ytmusic',
  }
  let state = {
    trackId: idleTrack.id, isPlaying: false, position: 0, volume: 68, shuffle: false, repeat: 'off',
    liked: [], queue: [idleTrack.id], catalog: { [idleTrack.id]: idleTrack },
    browse: { route: 'home', title: 'Ana Sayfa', url: 'https://music.youtube.com/', filters: [], sections: [], updatedAt: 0 },
    lyrics: { trackId: idleTrack.id, status: 'idle', lines: [] },
    related: { trackId: idleTrack.id, status: 'idle', items: [] },
    playlistPicker: { status: 'idle', itemTitle: '', playlists: [] },
    updatedAt: Date.now(),
  }
  let lastSignature = ''
  let destroyed = false
  let timer
  let pendingNavigation = null
  let navigationTask = null
  let expectedVideoId = ''
  let expectedTrackTitle = ''
  let expectedVideoDeadline = 0
  let playerTransitionActive = false
  let expectedVolume = null
  let expectedVolumeDeadline = 0
  let volumeCommandSequence = 0
  let lastVolumeReapplyAt = 0
  let actionSequence = 0
  let loadMoreTask = null
  let commandQueue = Promise.resolve()
  const appliedCommandIds = new Set()
  const inFlightCommandIds = new Set()
  const socket = io(syncUrl, { timeout: 3000, reconnectionDelay: 900 })

  const join = () => socket.emit('room:join', { room, role: 'desktop', state })
  socket.on('connect', join)
  socket.on('player:state', (incoming) => {
    if (!incoming || typeof incoming !== 'object') return
    state = { ...state, ...incoming }
  })

  function sendKey(keyCode) {
    if (webContents.isDestroyed()) return
    webContents.focus()
    webContents.sendInputEvent({ type: 'keyDown', keyCode })
    webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  async function waitForPlayerTrack(videoId, title = '', timeout = 7500) {
    const startedAt = Date.now()
    let stableSamples = 0
    let stableTitle = ''
    while (!destroyed && !webContents.isDestroyed() && Date.now() - startedAt < timeout) {
      const snapshot = await webContents.executeJavaScript(`(() => {
        const playerApi = document.querySelector('ytmusic-player')?.playerApi;
        const data = typeof playerApi?.getVideoData === 'function' ? playerApi.getVideoData() || {} : {};
        const currentVideoId = String(data.video_id || data.videoId || '');
        const currentTitle = String(data.title || navigator.mediaSession?.metadata?.title || '').trim();
        const roots = [...document.querySelectorAll('ytmusic-player-queue ytmusic-player-queue-item')];
        const queueVideoId = (root) => {
          const item = root?.data || root?.__data?.data || {};
          let id = item.videoId || item.navigationEndpoint?.watchEndpoint?.videoId || '';
          try { id = id || new URL(root.querySelector('a[href*="watch?v="]')?.href || '').searchParams.get('v') || ''; } catch {}
          return String(id || '');
        };
        const selectedIndex = roots.findIndex((root) => Boolean(root.data?.selected || root.__data?.data?.selected));
        const videoIndex = roots.findIndex((root) => queueVideoId(root) === currentVideoId);
        return { currentVideoId, currentTitle, queueReady: roots.length > 0 && videoIndex >= 0 };
      })()`, true)
      const normalizedCurrentTitle = String(snapshot?.currentTitle || '').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim()
      if (snapshot?.currentVideoId === videoId && normalizedCurrentTitle && snapshot.queueReady) {
        if (normalizedCurrentTitle === stableTitle) stableSamples += 1
        else {
          stableTitle = normalizedCurrentTitle
          stableSamples = 1
        }
        if (stableSamples >= 3) return snapshot
      } else {
        stableTitle = ''
        stableSamples = 0
      }
      await delay(140)
    }
    throw new Error(`${title || 'Parça'} YouTube Music oynatıcısında doğrulanamadı`)
  }

  async function clickPlayerButton(kind) {
    const before = await webContents.executeJavaScript(`(() => {
      const playerApi = document.querySelector('ytmusic-player')?.playerApi;
      const data = playerApi?.getVideoData?.() || {};
      return { videoId: String(data.video_id || data.videoId || ''), position: Number(playerApi?.getCurrentTime?.()) || 0 };
    })()`, true)
    playerTransitionActive = true
    try {
      const clicked = await webContents.executeJavaScript(`(() => {
      const kind = ${JSON.stringify(kind)};
      const selectors = kind === 'next'
        ? ['ytmusic-player-bar #next-button', 'ytmusic-player-bar .next-button', 'ytmusic-player-bar [aria-label*="Next" i]', 'ytmusic-player-bar [aria-label*="Sonraki" i]']
        : ['ytmusic-player-bar #previous-button', 'ytmusic-player-bar .previous-button', 'ytmusic-player-bar [aria-label*="Previous" i]', 'ytmusic-player-bar [aria-label*="Önceki" i]'];
      const labels = kind === 'next' ? /next|sonraki/i : /previous|önceki/i;
      const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
      const fallback = [...document.querySelectorAll('ytmusic-player-bar button, ytmusic-player-bar tp-yt-paper-icon-button')]
        .find((item) => labels.test(item.getAttribute('aria-label') || item.getAttribute('title') || ''));
      const button = candidates.find((item) => !item.disabled && item.getAttribute('aria-disabled') !== 'true') || fallback;
      if (!button) return false;
      button.click();
      return true;
    })()`, true)
      if (!clicked) sendKey(kind === 'next' ? 'MediaNextTrack' : 'MediaPreviousTrack')
      const startedAt = Date.now()
      let changed = null
      while (!destroyed && !webContents.isDestroyed() && Date.now() - startedAt < 5500) {
        const current = await webContents.executeJavaScript(`(() => {
        const playerApi = document.querySelector('ytmusic-player')?.playerApi;
        const data = playerApi?.getVideoData?.() || {};
        return { videoId: String(data.video_id || data.videoId || ''), title: String(data.title || ''), position: Number(playerApi?.getCurrentTime?.()) || 0 };
      })()`, true)
        const videoChanged = current.videoId && current.videoId !== before.videoId
        const restarted = kind === 'previous' && current.videoId === before.videoId && before.position > 3 && current.position < 2
        if (videoChanged || restarted) {
          changed = current
          break
        }
        await delay(120)
      }
      if (!changed) throw new Error(kind === 'next' ? 'Sonraki parça açılamadı' : 'Önceki parça açılamadı')
      if (changed.videoId !== before.videoId) {
        expectedVideoId = changed.videoId
        expectedTrackTitle = changed.title
        expectedVideoDeadline = Date.now() + 6000
        await waitForPlayerTrack(changed.videoId, changed.title, 5000)
      }
      playerTransitionActive = false
      await capture()
      return clicked
    } catch (error) {
      playerTransitionActive = false
      throw error
    }
  }

  async function applyVolumeLevel(level, sequence) {
    if (destroyed || webContents.isDestroyed() || sequence !== volumeCommandSequence) return null
    return webContents.executeJavaScript(`(() => {
      const level = ${JSON.stringify(level)};
      const playerApi = document.querySelector('ytmusic-player')?.playerApi;
      let appliedByApi = false;
      try {
        if (level > 0 && typeof playerApi?.unMute === 'function') playerApi.unMute();
        if (typeof playerApi?.setVolume === 'function') {
          playerApi.setVolume(level);
          appliedByApi = true;
        }
      } catch {}
      const mediaElements = [...document.querySelectorAll('video, audio')];
      for (const media of mediaElements) {
        try {
          media.muted = false;
          media.volume = level / 100;
        } catch {}
      }
      let actualVolume = Number.NaN;
      try {
        const apiVolume = Number(playerApi?.getVolume?.());
        const apiMuted = Boolean(playerApi?.isMuted?.());
        if (Number.isFinite(apiVolume)) actualVolume = apiMuted ? 0 : apiVolume;
      } catch {}
      if (!Number.isFinite(actualVolume)) {
        const activeMedia = mediaElements.find((media) => Number.isFinite(media.duration) && media.duration > 0) || mediaElements[0];
        actualVolume = activeMedia ? (activeMedia.muted ? 0 : activeMedia.volume * 100) : level;
      }
      return { applied: appliedByApi || mediaElements.length > 0, actualVolume };
    })()`, true)
  }

  function publishState() {
    state = { ...state, updatedAt: Date.now() }
    socket.emit('player:update', { room, state })
  }

  function publishAction(status, message) {
    state = {
      ...state,
      actionFeedback: { id: `${Date.now()}-${++actionSequence}`, status, message },
    }
    publishState()
  }

  function mergeBrowseState(previous, incoming) {
    if (!incoming || typeof incoming !== 'object') return previous
    if (!previous || previous.url !== incoming.url) {
      return { ...incoming, loadingMore: false, hasMore: true, updatedAt: Date.now() }
    }
    const sections = []
    const sectionIndex = new Map()
    for (const section of [...(previous.sections || []), ...(incoming.sections || [])]) {
      const key = `${section.id || ''}|${section.title || ''}|${section.layout || ''}`
      const existingIndex = sectionIndex.get(key)
      if (existingIndex === undefined) {
        sectionIndex.set(key, sections.length)
        sections.push({ ...section, items: [...(section.items || [])] })
        continue
      }
      const existing = sections[existingIndex]
      const seen = new Set(existing.items.map((item) => item.id || item.videoId || item.href))
      const items = [...existing.items]
      for (const item of section.items || []) {
        const itemKey = item.id || item.videoId || item.href
        if (!seen.has(itemKey)) {
          seen.add(itemKey)
          items.push(item)
        }
      }
      sections[existingIndex] = { ...existing, ...section, items }
    }
    return {
      ...previous,
      ...incoming,
      sections,
      loadingMore: Boolean(previous.loadingMore),
      hasMore: previous.hasMore !== false,
      updatedAt: Date.now(),
    }
  }

  async function collapsePlayerPage() {
    if (destroyed || webContents.isDestroyed()) return false
    try {
      return await webContents.executeJavaScript(`(() => {
        const page = document.querySelector('ytmusic-player-page');
        const player = document.querySelector('ytmusic-player');
        const layout = document.querySelector('ytmusic-app-layout');
        const isOpen = Boolean(page?.playerPageOpen || player?.playerPageOpen || layout?.playerPageOpen);
        if (!isOpen) return false;
        if (typeof page?.onCollapseButtonClick === 'function') {
          page.onCollapseButtonClick();
          return true;
        }
        const toggle = document.querySelector('ytmusic-player-bar .toggle-player-page-button');
        if (toggle) {
          toggle.click();
          return true;
        }
        return false;
      })()`, true)
    } catch {
      return false
    }
  }

  async function loadMusicPage(target) {
    if (destroyed || webContents.isDestroyed()) return
    await collapsePlayerPage()
    try {
      await webContents.loadURL(target)
    } catch (error) {
      const aborted = error?.code === 'ERR_ABORTED' || error?.errno === -3 || /ERR_ABORTED/.test(String(error?.message || ''))
      if (!aborted) throw error
    }
    await collapsePlayerPage()
    await capture()
    for (const delay of [350, 900]) {
      setTimeout(() => {
        if (destroyed) return
        void collapsePlayerPage().then(() => capture()).catch(() => {})
      }, delay)
    }
  }

  async function clickGuideDestination(destination) {
    if (destroyed || webContents.isDestroyed()) return false
    await collapsePlayerPage()
    const clicked = await webContents.executeJavaScript(`(() => new Promise((resolve) => {
      const browseIds = {
        home: 'FEmusic_home',
        explore: 'FEmusic_explore',
        library: 'FEmusic_library_landing',
      };
      const expectedPaths = { home: '/', explore: '/explore', library: '/library' };
      const browseId = browseIds[${JSON.stringify(destination)}];
      if (!browseId) {
        resolve(false);
        return;
      }
      const entries = [...document.querySelectorAll('ytmusic-guide-entry-renderer')];
      const entry = entries.find((item) => {
        const data = item.data || item.__data?.data || {};
        return data.navigationEndpoint?.browseEndpoint?.browseId === browseId;
      });
      if (!entry) {
        resolve(false);
        return;
      }
      const control = entry.querySelector('tp-yt-paper-item, a, #endpoint') || entry;
      control.click();
      const startedAt = Date.now();
      const waitForRoute = () => {
        if (location.pathname === expectedPaths[${JSON.stringify(destination)}] || Date.now() - startedAt >= 1800) {
          resolve(true);
          return;
        }
        setTimeout(waitForRoute, 80);
      };
      waitForRoute();
    }))()`, true)
    if (!clicked) return false
    setTimeout(() => void collapsePlayerPage().then(() => capture()).catch(() => {}), 250)
    setTimeout(() => void collapsePlayerPage().then(() => capture()).catch(() => {}), 750)
    setTimeout(() => void collapsePlayerPage().then(() => capture()).catch(() => {}), 1400)
    return true
  }

  async function navigateToSearch(target) {
    if (destroyed || webContents.isDestroyed()) return false
    let query = ''
    try {
      query = new URL(target).searchParams.get('q')?.trim() || ''
    } catch {}
    if (!query) return false
    await collapsePlayerPage()
    const navigated = await webContents.executeJavaScript(`(() => new Promise((resolve) => {
      const query = ${JSON.stringify(query)};
      const searchBox = document.querySelector('ytmusic-search-box');
      if (!searchBox || typeof searchBox.navigateToQueryResults !== 'function') {
        resolve(false);
        return;
      }
      const previousResults = document.querySelector('ytmusic-tabbed-search-results-renderer');
      const previousResultsData = previousResults?.data || previousResults?.__data?.data;
      try {
        if (typeof searchBox.setQuery === 'function') searchBox.setQuery(query);
        else if (searchBox.searchBoxInput) {
          searchBox.searchBoxInput.value = query;
          searchBox.searchBoxInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: query }));
        }
        searchBox.navigateToQueryResults(query);
      } catch {
        resolve(false);
        return;
      }
      const normalizedQuery = query.toLocaleLowerCase('tr').trim();
      const startedAt = Date.now();
      const waitForRoute = () => {
        let currentQuery = '';
        try { currentQuery = new URL(location.href).searchParams.get('q')?.toLocaleLowerCase('tr').trim() || ''; } catch {}
        const currentResults = document.querySelector('ytmusic-tabbed-search-results-renderer');
        const currentResultsData = currentResults?.data || currentResults?.__data?.data;
        const resultsChanged = currentResults && (currentResults !== previousResults || currentResultsData !== previousResultsData);
        if (location.pathname.startsWith('/search') && currentQuery === normalizedQuery && resultsChanged) {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= 3000) {
          resolve(true);
          return;
        }
        setTimeout(waitForRoute, 80);
      };
      waitForRoute();
    }))()`, true)
    if (!navigated) return false
    for (const delay of [200, 600, 1200, 2200]) {
      setTimeout(() => {
        if (!destroyed) void capture()
      }, delay)
    }
    return true
  }

  async function performNavigation({ target, destination }) {
    if (destination === 'search' && await navigateToSearch(target)) return
    if (destination && await clickGuideDestination(destination)) return
    await loadMusicPage(target)
  }

  function queueNavigation(target, destination = '') {
    pendingNavigation = { target, destination }
    if (!navigationTask) {
      navigationTask = (async () => {
        while (pendingNavigation && !destroyed) {
          const nextNavigation = pendingNavigation
          pendingNavigation = null
          await performNavigation(nextNavigation)
        }
      })().finally(() => {
        navigationTask = null
        if (pendingNavigation && !destroyed) void queueNavigation(pendingNavigation.target, pendingNavigation.destination)
      })
    }
    return navigationTask
  }

  async function openPlayerInfoTab(kind) {
    if (destroyed || webContents.isDestroyed()) return false
    const pageReady = await webContents.executeJavaScript(`(() => new Promise((resolve) => {
      const page = document.querySelector('ytmusic-player-page');
      if (!page) { resolve(false); return; }
      if (page.playerPageOpen) { resolve(true); return; }
      const toggle = document.querySelector('ytmusic-player-bar .toggle-player-page-button');
      if (!toggle) { resolve(false); return; }
      toggle.click();
      const startedAt = Date.now();
      const confirm = () => {
        if (page.playerPageOpen) { resolve(true); return; }
        if (Date.now() - startedAt >= 1500) { resolve(false); return; }
        setTimeout(confirm, 80);
      };
      confirm();
    }))()`, true)
    if (!pageReady) return false
    return webContents.executeJavaScript(`(() => new Promise((resolve) => {
      const kind = ${JSON.stringify(kind)};
      const tabs = [...document.querySelectorAll('ytmusic-player-page tp-yt-paper-tab, ytmusic-player-page yt-tab-shape, #tabs tp-yt-paper-tab, #tabs yt-tab-shape')];
      const pattern = kind === 'lyrics' ? /lyrics|şarkı sözleri|sözler/i
        : kind === 'queue' ? /sıradaki|up next|queue/i
        : /related|benzer/i;
      const tab = tabs.find((item) => pattern.test((item.textContent || '').trim()));
      if (!tab || tab.getAttribute('aria-disabled') === 'true') { resolve(false); return; }
      tab.click();
      const startedAt = Date.now();
      const confirm = () => {
        const selected = Boolean(tab.selected || tab.getAttribute('aria-selected') === 'true' || tab.hasAttribute('selected'));
        if (selected) { resolve(true); return; }
        if (Date.now() - startedAt >= 1800) { resolve(false); return; }
        setTimeout(confirm, 80);
      };
      confirm();
    }))()`, true)
  }

  function schedulePlayerInfoCapture(kind, requestedTrackId) {
    for (const delay of [500, 1200, 2400]) setTimeout(() => void capture(), delay)
    setTimeout(() => {
      if (destroyed || state.trackId !== requestedTrackId) return
      const info = state[kind]
      if (info?.status === 'loading') {
        state = {
          ...state,
          [kind]: kind === 'lyrics'
            ? { trackId: requestedTrackId, status: 'unavailable', lines: [] }
            : { trackId: requestedTrackId, status: 'unavailable', items: [] },
        }
        publishState()
      }
      void collapsePlayerPage()
    }, 3800)
  }

  async function clickBrowseMusicItem(item) {
    await collapsePlayerPage()
    const target = {
      videoId: String(item?.videoId || ''),
      href: String(item?.href || ''),
      title: String(item?.title || ''),
    }
    return webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify(target)};
      const roots = [...document.querySelectorAll('ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer')]
        .filter((root) => !root.closest('ytmusic-player-page') && (root.offsetParent !== null || root.getClientRects().length > 0));
      const text = (value) => value?.runs?.map((run) => run.text || '').join('') || value?.simpleText || '';
      const endpointVideoId = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 8) return '';
        if (value.watchEndpoint?.videoId) return value.watchEndpoint.videoId;
        for (const nested of Object.values(value)) {
          const id = endpointVideoId(nested, depth + 1);
          if (id) return id;
        }
        return '';
      };
      const normalizedHref = (value) => {
        try { const url = new URL(value || '', location.origin); return (url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname) + url.search; } catch { return ''; }
      };
      const rootVideoId = (root) => {
        const data = root.data || root.__data?.data || {};
        const anchors = [...root.querySelectorAll('a[href*="watch?v="]')];
        const anchorId = anchors.map((anchor) => {
          try { return new URL(anchor.href, location.origin).searchParams.get('v') || ''; } catch { return ''; }
        }).find(Boolean) || '';
        return data.videoId || data.playlistItemData?.videoId || data.navigationEndpoint?.watchEndpoint?.videoId || anchorId || endpointVideoId(data);
      };
      const titleOf = (root) => {
        const data = root.data || root.__data?.data || {};
        return text(data.title) || text(data.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text)
          || root.querySelector('#video-title, .title, ytmusic-formatted-string.title')?.textContent?.trim() || '';
      };
      const root = roots.find((candidate) => target.videoId && rootVideoId(candidate) === target.videoId)
        || roots.find((candidate) => target.href && [...candidate.querySelectorAll('a[href]')]
          .some((anchor) => normalizedHref(anchor.getAttribute('href')) === normalizedHref(target.href)))
        || roots.find((candidate) => target.title && titleOf(candidate) === target.title);
      if (!root) return { success: false, message: target.title + ' mevcut YouTube Music sayfasında bulunamadı' };
      const watchAnchors = [...root.querySelectorAll('a[href*="watch?v="]')];
      const matchingAnchor = watchAnchors.find((anchor) => {
        try { return !target.videoId || new URL(anchor.href, location.origin).searchParams.get('v') === target.videoId; } catch { return false; }
      });
      const control = matchingAnchor || watchAnchors[0];
      if (!control) return { success: false, message: target.title + ' için oynatma bağlantısı bulunamadı' };
      control.click();
      return { success: true, videoId: rootVideoId(root), title: titleOf(root) };
    })()`, true)
  }

  async function clickQueueMusicItem(track) {
    const target = {
      videoId: String(track?.videoId || track?.id || '').replace(/^ytmusic:video:/, ''),
      title: String(track?.title || ''),
    }
    return webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify(target)};
      const roots = [...document.querySelectorAll('ytmusic-player-queue ytmusic-player-queue-item')];
      const text = (value) => value?.runs?.map((run) => run.text || '').join('') || value?.simpleText || '';
      const videoIdOf = (root) => {
        const data = root?.data || root?.__data?.data || {};
        let id = data.videoId || data.navigationEndpoint?.watchEndpoint?.videoId || '';
        try { id = id || new URL(root.querySelector('a[href*="watch?v="]')?.href || '').searchParams.get('v') || ''; } catch {}
        return String(id || '');
      };
      const titleOf = (root) => {
        const data = root?.data || root?.__data?.data || {};
        return text(data.title) || root.querySelector('#video-title, .song-title, ytmusic-formatted-string.title, .title')?.textContent?.trim() || '';
      };
      const root = roots.find((candidate) => target.videoId && videoIdOf(candidate) === target.videoId)
        || roots.find((candidate) => target.title && titleOf(candidate) === target.title);
      if (!root) return { success: false, message: target.title + ' geçerli sırada bulunamadı' };
      const anchor = [...root.querySelectorAll('a[href*="watch?v="]')].find((candidate) => {
        try { return !target.videoId || new URL(candidate.href, location.origin).searchParams.get('v') === target.videoId; } catch { return false; }
      });
      const playButton = root.querySelector('#play-button, ytmusic-play-button-renderer, [role="button"][aria-label*="oynat" i], [role="button"][aria-label*="play" i]');
      (playButton || anchor || root).click();
      return { success: true, videoId: videoIdOf(root), title: titleOf(root) };
    })()`, true)
  }

  async function playMusicItem(item, source) {
    const videoId = String(item?.videoId || item?.id || '').replace(/^ytmusic:video:/, '').trim()
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error('Parça kimliği geçersiz')
    const title = String(item?.title || '').trim()
    expectedVideoId = videoId
    expectedTrackTitle = ''
    expectedVideoDeadline = Date.now() + 8000
    const result = source === 'queue' ? await clickQueueMusicItem({ ...item, videoId }) : await clickBrowseMusicItem({ ...item, videoId })
    if (!result?.success) {
      expectedVideoId = ''
      expectedTrackTitle = ''
      expectedVideoDeadline = 0
      throw new Error(result?.message || 'Parça YouTube Music üzerinde açılamadı')
    }
    const confirmed = await waitForPlayerTrack(videoId, title, 7500)
    expectedTrackTitle = String(confirmed.currentTitle || '')
    await capture()
    return true
  }

  async function openItemMenu(item) {
    const target = {
      videoId: String(item?.videoId || ''),
      href: String(item?.href || ''),
      title: String(item?.title || ''),
    }
    const location = await webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify(target)};
      const roots = [...document.querySelectorAll('ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer')]
        .filter((root) => !root.closest('ytmusic-player-page'));
      const text = (value) => value?.runs?.map((run) => run.text || '').join('') || value?.simpleText || '';
      const endpointVideoId = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 8) return '';
        if (value.watchEndpoint?.videoId) return value.watchEndpoint.videoId;
        for (const nested of Object.values(value)) {
          const videoId = endpointVideoId(nested, depth + 1);
          if (videoId) return videoId;
        }
        return '';
      };
      const normalizedHref = (value) => {
        try { const url = new URL(value || '', location.origin); return url.pathname + url.search; } catch { return ''; }
      };
      const root = roots.find((candidate) => {
        const data = candidate.data || candidate.__data?.data || {};
        const videoId = data.videoId || data.playlistItemData?.videoId || endpointVideoId(data);
        if (target.videoId && videoId === target.videoId) return true;
        const anchorHref = candidate.querySelector('a[href]')?.getAttribute('href') || '';
        if (target.href && normalizedHref(anchorHref) === normalizedHref(target.href)) return true;
        const title = text(data.title) || text(data.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text)
          || candidate.querySelector('#video-title, .title, ytmusic-formatted-string.title')?.textContent?.trim() || '';
        return Boolean(target.title && title === target.title);
      });
      if (!root) return null;
      const previousTop = document.scrollingElement?.scrollTop || 0;
      root.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = root.getBoundingClientRect();
      return { previousTop, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`, true)
    if (!location) return null
    webContents.focus()
    webContents.sendInputEvent({ type: 'mouseMove', x: location.x, y: location.y })
    await new Promise((resolve) => setTimeout(resolve, 140))
    const button = await webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify(target)};
      const roots = [...document.querySelectorAll('ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer')]
        .filter((root) => !root.closest('ytmusic-player-page'));
      const text = (value) => value?.runs?.map((run) => run.text || '').join('') || value?.simpleText || '';
      const endpointVideoId = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 8) return '';
        if (value.watchEndpoint?.videoId) return value.watchEndpoint.videoId;
        for (const nested of Object.values(value)) {
          const videoId = endpointVideoId(nested, depth + 1);
          if (videoId) return videoId;
        }
        return '';
      };
      const normalizedHref = (value) => {
        try { const url = new URL(value || '', location.origin); return url.pathname + url.search; } catch { return ''; }
      };
      const root = roots.find((candidate) => {
        const data = candidate.data || candidate.__data?.data || {};
        const videoId = data.videoId || data.playlistItemData?.videoId || endpointVideoId(data);
        if (target.videoId && videoId === target.videoId) return true;
        const anchorHref = candidate.querySelector('a[href]')?.getAttribute('href') || '';
        if (target.href && normalizedHref(anchorHref) === normalizedHref(target.href)) return true;
        const title = text(data.title) || text(data.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text)
          || candidate.querySelector('#video-title, .title, ytmusic-formatted-string.title')?.textContent?.trim() || '';
        return Boolean(target.title && title === target.title);
      });
      const menu = root?.querySelector('button[aria-label*="İşlem menüsü" i], button[aria-label*="action menu" i], button[aria-label*="more" i], button[aria-label*="menu" i], [aria-label*="İşlem menüsü" i], [aria-label*="menu" i]');
      if (!menu) return null;
      const rect = menu.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`, true)
    if (!button) return null
    webContents.sendInputEvent({ type: 'mouseMove', x: button.x, y: button.y })
    webContents.sendInputEvent({ type: 'mouseDown', x: button.x, y: button.y, button: 'left', clickCount: 1 })
    webContents.sendInputEvent({ type: 'mouseUp', x: button.x, y: button.y, button: 'left', clickCount: 1 })
    await new Promise((resolve) => setTimeout(resolve, 320))
    return location.previousTop
  }

  async function clickVisibleMenuAction(action) {
    return webContents.executeJavaScript(`(() => {
      const action = ${JSON.stringify(action)};
      const patterns = {
        playNext: /^(Bundan sonra oynat|Play next)$/i,
        addQueue: /^(Sıraya ekle|Add to queue)$/i,
        savePlaylist: /^(Oynatma listesine (kaydet|ekle)|Save to playlist|Add to playlist)$/i,
        saveLibrary: /^(Kitaplığa kaydet|Save to library)$/i,
        remove: /^(Sıradan kaldır|Kuyruktan kaldır|Remove from queue)$/i,
        moveUp: /^(Yukarı taşı|Move up)$/i,
        moveDown: /^(Aşağı taşı|Move down)$/i,
      };
      const item = [...document.querySelectorAll('[role="menuitem"], ytmusic-menu-navigation-item-renderer, ytmusic-menu-service-item-renderer')]
        .find((candidate) => (candidate.offsetParent !== null || candidate.getClientRects().length > 0)
          && patterns[action]?.test((candidate.textContent || '').replace(/\\s+/g, ' ').trim()));
      if (!item) return false;
      item.click();
      return true;
    })()`, true)
  }

  async function openQueueItemMenu(track) {
    const queueVisible = await openPlayerInfoTab('queue')
    if (!queueVisible) return false
    await new Promise((resolve) => setTimeout(resolve, 260))
    const target = {
      videoId: String(track?.videoId || track?.id || '').replace(/^ytmusic:video:/, ''),
      title: String(track?.title || ''),
    }
    const location = await webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify(target)};
      const roots = [...document.querySelectorAll('ytmusic-player-queue ytmusic-player-queue-item')];
      const runsText = (value) => value?.runs?.map((run) => run.text || '').join('') || value?.simpleText || '';
      const videoIdOf = (root) => {
        const data = root?.data || root?.__data?.data || {};
        let videoId = data.videoId || data.navigationEndpoint?.watchEndpoint?.videoId || '';
        try { videoId = videoId || new URL(root.querySelector('a[href*="watch?v="]')?.href || '').searchParams.get('v') || ''; } catch {}
        return videoId;
      };
      const titleOf = (root) => {
        const data = root?.data || root?.__data?.data || {};
        return runsText(data.title) || root.querySelector('#video-title, .song-title, ytmusic-formatted-string.title, .title')?.textContent?.trim() || '';
      };
      const root = roots.find((candidate) => target.videoId && videoIdOf(candidate) === target.videoId)
        || roots.find((candidate) => target.title && titleOf(candidate) === target.title);
      if (!root) return null;
      root.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = root.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`, true)
    if (!location) return false
    webContents.focus()
    webContents.sendInputEvent({ type: 'mouseMove', x: location.x, y: location.y })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const button = await webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify(target)};
      const roots = [...document.querySelectorAll('ytmusic-player-queue ytmusic-player-queue-item')];
      const runsText = (value) => value?.runs?.map((run) => run.text || '').join('') || value?.simpleText || '';
      const videoIdOf = (root) => {
        const data = root?.data || root?.__data?.data || {};
        let videoId = data.videoId || data.navigationEndpoint?.watchEndpoint?.videoId || '';
        try { videoId = videoId || new URL(root.querySelector('a[href*="watch?v="]')?.href || '').searchParams.get('v') || ''; } catch {}
        return videoId;
      };
      const titleOf = (root) => {
        const data = root?.data || root?.__data?.data || {};
        return runsText(data.title) || root.querySelector('#video-title, .song-title, ytmusic-formatted-string.title, .title')?.textContent?.trim() || '';
      };
      const root = roots.find((candidate) => target.videoId && videoIdOf(candidate) === target.videoId)
        || roots.find((candidate) => target.title && titleOf(candidate) === target.title);
      const menu = root?.querySelector('button[aria-label*="İşlem menüsü" i], button[aria-label*="action menu" i], button[aria-label*="more" i], [aria-label*="İşlem menüsü" i], [aria-label*="menu" i]');
      if (!menu) return null;
      const rect = menu.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`, true)
    if (!button) return false
    webContents.sendInputEvent({ type: 'mouseMove', x: button.x, y: button.y })
    webContents.sendInputEvent({ type: 'mouseDown', x: button.x, y: button.y, button: 'left', clickCount: 1 })
    webContents.sendInputEvent({ type: 'mouseUp', x: button.x, y: button.y, button: 'left', clickCount: 1 })
    await new Promise((resolve) => setTimeout(resolve, 320))
    return true
  }

  async function performQueueAction(track, action) {
    const result = await webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify({
        videoId: String(track?.videoId || track?.id || '').replace(/^ytmusic:video:/, ''),
        title: String(track?.title || ''),
      })};
      const action = ${JSON.stringify(action)};
      const app = document.querySelector('ytmusic-app');
      const queueState = app?.getState?.()?.queue;
      if (!Array.isArray(queueState?.items) || typeof app?.dispatch !== 'function') {
        return { success: false, message: 'YouTube Music sıra durumu hazır değil' };
      }
      const unwrap = (entry) => entry?.playlistPanelVideoRenderer
        || entry?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer
        || null;
      const runs = (value) => value?.runs?.map((run) => run.text || '').join('') || value?.simpleText || '';
      let index = queueState.items.findIndex((entry) => target.videoId && unwrap(entry)?.videoId === target.videoId);
      if (index < 0) index = queueState.items.findIndex((entry) => target.title && runs(unwrap(entry)?.title) === target.title);
      if (index < 0) return { success: false, message: target.title + ' sıra içinde bulunamadı' };
      const currentVideoId = String(document.querySelector('ytmusic-player')?.playerApi?.getVideoData?.()?.video_id || '');
      const currentIndex = queueState.items.findIndex((entry) => unwrap(entry)?.videoId === currentVideoId);
      if (action === 'remove') {
        if (index === currentIndex) return { success: false, message: 'Çalan parça sıradan kaldırılamaz' };
        queueState.items.splice(index, 1);
      } else {
        let destination = action === 'playNext' ? currentIndex + 1 : action === 'moveUp' ? index - 1 : index + 1;
        destination = Math.max(currentIndex + 1, Math.min(queueState.items.length - 1, destination));
        if (destination === index) return { success: true };
        const [entry] = queueState.items.splice(index, 1);
        queueState.items.splice(destination, 0, entry);
      }
      app.dispatch({ type: '@@RITIM_SYNC_QUEUE' });
      return { success: true };
    })()`, true)
    if (!result?.success) throw new Error(result?.message || 'Sıra güncellenemedi')
    publishAction('success', action === 'remove' ? 'Parça sıradan kaldırıldı' : 'Sıra güncellendi')
    for (const delay of [300, 1100, 2200]) setTimeout(() => void capture(), delay)
  }

  async function restoreBrowseScroll(scrollTop) {
    await webContents.executeJavaScript(`(() => {
      if (document.scrollingElement) document.scrollingElement.scrollTop = ${JSON.stringify(Number(scrollTop) || 0)};
    })()`, true).catch(() => {})
  }

  async function performDirectItemQueueAction(item, action) {
    const target = {
      videoId: String(item?.videoId || ''),
      href: String(item?.href || ''),
      title: String(item?.title || ''),
    }
    const result = await webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify(target)};
      const action = ${JSON.stringify(action)};
      const roots = [...document.querySelectorAll('ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer')]
        .filter((root) => !root.closest('ytmusic-player-page') && (root.offsetParent !== null || root.getClientRects().length > 0));
      const text = (value) => value?.runs?.map((run) => run.text || '').join('') || value?.simpleText || '';
      const endpointVideoId = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 8) return '';
        if (value.watchEndpoint?.videoId) return value.watchEndpoint.videoId;
        for (const nested of Object.values(value)) {
          const id = endpointVideoId(nested, depth + 1);
          if (id) return id;
        }
        return '';
      };
      const normalizedHref = (value) => {
        try { const url = new URL(value || '', location.origin); return (url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname) + url.search; } catch { return ''; }
      };
      const videoIdOf = (root) => {
        const data = root?.data || root?.__data?.data || {};
        let id = data.videoId || data.playlistItemData?.videoId || data.navigationEndpoint?.watchEndpoint?.videoId || '';
        try { id = id || new URL(root.querySelector('a[href*="watch?v="]')?.href || '').searchParams.get('v') || ''; } catch {}
        return id || endpointVideoId(data);
      };
      const titleOf = (root) => {
        const data = root?.data || root?.__data?.data || {};
        return text(data.title) || text(data.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text)
          || root.querySelector('#video-title, .title, ytmusic-formatted-string.title')?.textContent?.trim() || '';
      };
      const root = roots.find((candidate) => target.videoId && videoIdOf(candidate) === target.videoId)
        || roots.find((candidate) => target.href && [...candidate.querySelectorAll('a[href]')]
          .some((anchor) => normalizedHref(anchor.getAttribute('href')) === normalizedHref(target.href)))
        || roots.find((candidate) => target.title && titleOf(candidate) === target.title);
      if (!root) return { success: false, message: target.title + ' mevcut YouTube Music sayfasında bulunamadı' };
      const app = document.querySelector('ytmusic-app');
      const appState = app?.getState?.();
      const queueState = appState?.queue;
      if (!Array.isArray(queueState?.items) || typeof app?.dispatch !== 'function') {
        return { success: false, message: 'YouTube Music sıra durumu hazır değil' };
      }
      const unwrap = (entry) => entry?.playlistPanelVideoRenderer
        || entry?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer
        || null;
      const currentVideoId = String(document.querySelector('ytmusic-player')?.playerApi?.getVideoData?.()?.video_id || '');
      const currentIndex = queueState.items.findIndex((entry) => unwrap(entry)?.videoId === currentVideoId);
      if (currentIndex < 0) return { success: false, message: 'Çalan parça YouTube Music sırasında bulunamadı' };
      const template = structuredClone(unwrap(queueState.items[currentIndex]));
      if (!template) return { success: false, message: 'YouTube Music sıra öğesi oluşturulamadı' };
      const data = root.data || root.__data?.data || {};
      const navigationEndpoint = data.navigationEndpoint
        || data.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.find((run) => run.navigationEndpoint)?.navigationEndpoint
        || data.title?.runs?.find((run) => run.navigationEndpoint)?.navigationEndpoint;
      if (!navigationEndpoint?.watchEndpoint?.videoId) return { success: false, message: 'İçeriğin oynatma adresi bulunamadı' };
      template.videoId = videoIdOf(root);
      template.title = structuredClone(data.title || data.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text || template.title);
      template.longBylineText = structuredClone(data.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text || data.subtitle || template.longBylineText);
      template.shortBylineText = structuredClone(template.longBylineText);
      template.thumbnail = structuredClone(data.thumbnail || data.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail || template.thumbnail);
      template.navigationEndpoint = structuredClone(navigationEndpoint);
      template.menu = structuredClone(data.menu || template.menu);
      template.selected = false;
      template.playlistSetVideoId = 'ritim-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      if (template.queueNavigationEndpoint?.queueAddEndpoint?.queueTarget) {
        template.queueNavigationEndpoint.queueAddEndpoint.queueTarget.videoId = template.videoId;
        const emptyWatch = template.queueNavigationEndpoint.queueAddEndpoint.queueTarget.onEmptyQueue?.watchEndpoint;
        if (emptyWatch) emptyWatch.videoId = template.videoId;
      }
      const insertIndex = action === 'playNext' ? currentIndex + 1 : queueState.items.length;
      queueState.items.splice(insertIndex, 0, { playlistPanelVideoRenderer: template });
      queueState.nextQueueItemId = Math.max(Number(queueState.nextQueueItemId) || 0, queueState.items.length + 1);
      app.dispatch({ type: '@@RITIM_SYNC_QUEUE' });
      const inserted = unwrap(queueState.items[insertIndex]);
      return {
        success: inserted?.videoId === template.videoId,
        videoId: template.videoId,
        insertIndex,
        queueLength: queueState.items.length,
      };
    })()`, true)
    if (!result?.success) throw new Error(result?.message || 'Sıra işlemi uygulanamadı')
    await delay(180)
    await capture()
  }

  async function performItemAction(item, action) {
    if (action === 'playNext' || action === 'addQueue') {
      await performDirectItemQueueAction(item, action)
      publishAction('success', action === 'playNext'
        ? `${item.title || 'İçerik'} bundan sonra oynatılacak`
        : `${item.title || 'İçerik'} sıraya eklendi`)
      return
    }
    const previousTop = await openItemMenu(item)
    if (previousTop === null) {
      throw new Error(`${item.title || 'İçerik'} için işlem menüsü bulunamadı`)
    }
    const clicked = await clickVisibleMenuAction(action)
    if (!clicked) {
      sendKey('Escape')
      await restoreBrowseScroll(previousTop)
      throw new Error('Bu işlem YouTube Music menüsünde bulunamadı')
    }
    if (action === 'savePlaylist') {
      state = { ...state, playlistPicker: { status: 'loading', itemTitle: String(item.title || ''), playlists: [] } }
      publishState()
      await new Promise((resolve) => setTimeout(resolve, 650))
      const playlists = await webContents.executeJavaScript(`(() => {
        const text = (value) => value?.runs?.map((run) => run.text || '').join('') || value?.simpleText || '';
        return [...document.querySelectorAll('ytmusic-playlist-add-to-option-renderer')]
          .filter((root) => root.offsetParent !== null || root.getClientRects().length > 0)
          .map((root, index) => {
            const data = root.data || root.__data?.data || {};
            const thumbnails = data.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
            return {
              id: String(data.playlistId || index),
              title: text(data.title) || root.querySelector('#title, .title')?.textContent?.trim() || '',
              subtitle: text(data.shortBylineText) || root.querySelector('#subtitle, .subtitle')?.textContent?.trim() || '',
              thumbnailUrl: thumbnails.length ? thumbnails[thumbnails.length - 1].url : root.querySelector('img')?.src || '',
            };
          }).filter((playlist) => playlist.id && playlist.title);
      })()`, true)
      if (!Array.isArray(playlists) || playlists.length === 0) {
        sendKey('Escape')
        state = { ...state, playlistPicker: { status: 'idle', itemTitle: '', playlists: [] } }
        publishState()
        await restoreBrowseScroll(previousTop)
        throw new Error('Oynatma listeleri YouTube Music’ten alınamadı')
      } else {
        state = { ...state, playlistPicker: { status: 'ready', itemTitle: String(item.title || ''), playlists } }
        publishState()
      }
      await restoreBrowseScroll(previousTop)
      return
    }
    await restoreBrowseScroll(previousTop)
    const messages = {
      playNext: `${item.title || 'İçerik'} bundan sonra oynatılacak`,
      addQueue: `${item.title || 'İçerik'} sıraya eklendi`,
      saveLibrary: `${item.title || 'İçerik'} kitaplığa kaydedildi`,
    }
    publishAction('success', messages[action] || 'İşlem tamamlandı')
    for (const delay of [250, 850]) setTimeout(() => void capture(), delay)
  }

  async function loadMoreBrowse() {
    if (loadMoreTask || destroyed || webContents.isDestroyed()) return
    loadMoreTask = (async () => {
      const currentBrowse = state.browse || {}
      state = { ...state, browse: { ...currentBrowse, loadingMore: true } }
      publishState()
      const scrollResult = await webContents.executeJavaScript(`(() => new Promise((resolve) => {
        const scroll = document.scrollingElement;
        if (!scroll) { resolve(null); return; }
        const previousTop = scroll.scrollTop;
        const beforeHeight = scroll.scrollHeight;
        const clientHeight = scroll.clientHeight;
        const targetTop = Math.max(0, beforeHeight - clientHeight);
        scroll.scrollTo({ top: targetTop, behavior: 'instant' });
        setTimeout(() => resolve({ previousTop, beforeHeight, clientHeight, afterTop: scroll.scrollTop, afterHeight: scroll.scrollHeight }), 1950);
      }))()`, true)
      if (!scrollResult) {
        state = { ...state, browse: { ...(state.browse || {}), loadingMore: false, hasMore: false } }
        publishState()
        return
      }
      await capture()
      await restoreBrowseScroll(scrollResult.previousTop)
      const afterBottom = Number(scrollResult.afterHeight) - Number(scrollResult.clientHeight)
      const grew = Number(scrollResult.afterHeight) > Number(scrollResult.beforeHeight) + 4
      const canMoveFurther = Number(scrollResult.afterTop) < afterBottom - 4
      const didMove = Number(scrollResult.afterTop) > Number(scrollResult.previousTop) + 2
      state = {
        ...state,
        browse: { ...(state.browse || {}), loadingMore: false, hasMore: didMove && (grew || canMoveFurther), updatedAt: Date.now() },
      }
      publishState()
    })().catch((error) => {
      state = { ...state, browse: { ...(state.browse || {}), loadingMore: false } }
      publishAction('error', `Daha fazla içerik yüklenemedi: ${error.message}`)
    }).finally(() => { loadMoreTask = null })
    await loadMoreTask
  }

  async function command(command) {
    if (!command || typeof command.type !== 'string') return
    if (command.type === 'togglePlay') {
      const result = await webContents.executeJavaScript(`(() => {
        const media = [...document.querySelectorAll('video, audio')]
          .find((item) => Number.isFinite(item.duration) && item.duration > 0);
        if (!media) return 'missing';
        if (!media.paused) {
          media.pause();
          return 'paused';
        }
        return Promise.resolve(media.play())
          .then(() => 'playing')
          .catch(() => 'blocked');
      })()`, true)
      if (result === 'missing' || result === 'blocked') sendKey('MediaPlayPause')
      setTimeout(() => void capture(), 120)
    }
    if (command.type === 'next') await clickPlayerButton('next')
    if (command.type === 'previous') await clickPlayerButton('previous')
    if (command.type === 'toggleShuffle') sendKey('S')
    if (command.type === 'cycleRepeat') sendKey('R')
    if (command.type === 'seek' && Number.isFinite(Number(command.value))) {
      const seconds = Math.max(0, Number(command.value))
      await webContents.executeJavaScript(`(() => {
        const media = [...document.querySelectorAll('video, audio')]
          .find((item) => Number.isFinite(item.duration) && item.duration > 0);
        if (!media) return false;
        media.currentTime = Math.min(${JSON.stringify(seconds)}, media.duration || ${JSON.stringify(seconds)});
        return true;
      })()`, true)
      setTimeout(() => void capture(), 80)
    }
    if (command.type === 'requestLyrics') {
      state = { ...state, lyrics: { trackId: state.trackId, status: 'loading', lines: [] } }
      publishState()
      const clicked = await openPlayerInfoTab('lyrics')
      if (!clicked) {
        state = { ...state, lyrics: { trackId: state.trackId, status: 'unavailable', lines: [] } }
        publishState()
      } else {
        schedulePlayerInfoCapture('lyrics', state.trackId)
      }
    }
    if (command.type === 'requestRelated') {
      state = { ...state, related: { trackId: state.trackId, status: 'loading', items: [] } }
      publishState()
      const clicked = await openPlayerInfoTab('related')
      if (!clicked) {
        state = { ...state, related: { trackId: state.trackId, status: 'unavailable', items: [] } }
        publishState()
      } else {
        schedulePlayerInfoCapture('related', state.trackId)
      }
    }
    if (command.type === 'setVolume' && Number.isFinite(Number(command.value))) {
      const level = Math.max(0, Math.min(100, Math.round(Number(command.value))))
      const sequence = ++volumeCommandSequence
      expectedVolume = level
      expectedVolumeDeadline = Date.now() + 6000
      lastVolumeReapplyAt = 0
      state = { ...state, volume: level }
      publishState()
      await applyVolumeLevel(level, sequence)
      for (const delay of [180, 700, 1800, 3500]) {
        setTimeout(() => {
          if (sequence !== volumeCommandSequence) return
          void applyVolumeLevel(level, sequence).then(() => capture()).catch(() => {})
        }, delay)
      }
      setTimeout(() => void capture(), 80)
    }
    if (command.type === 'playItem' || command.type === 'playQueueTrack') {
      let item
      try { item = JSON.parse(String(command.value || '{}')) } catch { throw new Error('Parça komutu okunamadı') }
      await playMusicItem(item, command.type === 'playQueueTrack' ? 'queue' : 'browse')
    }
    if (command.type === 'playTrack') {
      const videoId = String(command.value || '').trim()
      const existing = state.catalog?.[`ytmusic:video:${videoId}`]
      expectedVideoId = videoId
      expectedTrackTitle = ''
      expectedVideoDeadline = Date.now() + 8000
      const queueResult = await clickQueueMusicItem({ videoId, title: existing?.title || '' })
      if (!queueResult?.success) {
        expectedVideoId = ''
        expectedTrackTitle = ''
        expectedVideoDeadline = 0
        throw new Error('Bu eski telefon komutu geçerli sırada bulunamadı; mobil uygulamayı güncelleyin')
      }
      const confirmed = await waitForPlayerTrack(videoId, String(existing?.title || queueResult.title || ''), 7500)
      expectedTrackTitle = String(confirmed.currentTitle || '')
      await capture()
    }
    if (command.type === 'loadMoreBrowse') await loadMoreBrowse()
    if (command.type === 'itemAction') {
      let payload
      try { payload = JSON.parse(String(command.value || '{}')) } catch { throw new Error('Telefon işlemi okunamadı') }
      const supported = ['playNext', 'addQueue', 'savePlaylist', 'saveLibrary']
      if (!payload?.item || !supported.includes(payload.action)) throw new Error('Telefon işlemi desteklenmiyor')
      await performItemAction(payload.item, payload.action)
    }
    if (command.type === 'queueAction') {
      const payload = JSON.parse(String(command.value || '{}'))
      const supported = ['playNext', 'moveUp', 'moveDown', 'remove']
      if (!payload?.track || !supported.includes(payload.action)) throw new Error('Sıra komutu okunamadı')
      await performQueueAction(payload.track, payload.action)
    }
    if (command.type === 'clearQueue') {
      const cleared = await webContents.executeJavaScript(`(() => {
        const playerApi = document.querySelector('ytmusic-player')?.playerApi;
        if (typeof playerApi?.clearQueue !== 'function') return false;
        playerApi.clearQueue();
        return true;
      })()`, true)
      if (!cleared) throw new Error('YouTube Music sırası temizlenemedi')
      publishAction('success', 'Sıradaki parçalar temizlendi')
      for (const delay of [180, 700]) setTimeout(() => void capture(), delay)
    }
    if (command.type === 'selectPlaylist') {
      const playlistId = String(command.value || '')
      const selected = await webContents.executeJavaScript(`(() => {
        const playlistId = ${JSON.stringify(playlistId)};
        const option = [...document.querySelectorAll('ytmusic-playlist-add-to-option-renderer')]
          .find((root) => String((root.data || root.__data?.data || {}).playlistId || '') === playlistId
            && (root.offsetParent !== null || root.getClientRects().length > 0));
        if (!option) return false;
        option.click();
        return true;
      })()`, true)
      state = { ...state, playlistPicker: { status: 'idle', itemTitle: '', playlists: [] } }
      if (selected) publishAction('success', 'Parça oynatma listesine kaydedildi')
      else publishAction('error', 'Oynatma listesi seçilemedi')
      setTimeout(() => void capture(), 400)
    }
    if (command.type === 'cancelPlaylistPicker') {
      sendKey('Escape')
      state = { ...state, playlistPicker: { status: 'idle', itemTitle: '', playlists: [] } }
      publishState()
    }
    if (command.type === 'navigateUrl') {
      try {
        const target = new URL(String(command.value || ''), 'https://music.youtube.com/')
        if (target.origin === 'https://music.youtube.com') {
          await queueNavigation(target.toString())
        }
      } catch {}
    }
    if (command.type === 'goBack') {
      await collapsePlayerPage()
      const history = webContents.navigationHistory
      if (history?.canGoBack()) {
        history.goBack()
        setTimeout(() => void collapsePlayerPage().then(() => capture()).catch(() => {}), 350)
        setTimeout(() => void collapsePlayerPage().then(() => capture()).catch(() => {}), 900)
      } else await queueNavigation('https://music.youtube.com/browse/FEmusic_home', 'home')
    }
    if (command.type.startsWith('navigate:')) {
      const destination = command.type.slice('navigate:'.length)
      const routes = {
        home: 'https://music.youtube.com/browse/FEmusic_home',
        explore: 'https://music.youtube.com/browse/FEmusic_explore',
        library: 'https://music.youtube.com/browse/FEmusic_library_landing',
      }
      const target = destination === 'search'
        ? `https://music.youtube.com/search?q=${encodeURIComponent(String(command.value || '').trim())}`
        : routes[destination]
      if (target) {
        await queueNavigation(target, destination)
      }
    }
  }

  socket.on('player:command', (incoming) => {
    const commandId = String(incoming?.id || '')
    const commandType = String(incoming?.type || '')
    if (commandId && appliedCommandIds.has(commandId)) {
      socket.emit('player:command:ack', { id: commandId, type: commandType, status: 'applied', appliedAt: Date.now() })
      return
    }
    if (commandId && inFlightCommandIds.has(commandId)) return
    if (commandId) inFlightCommandIds.add(commandId)
    const task = commandQueue.catch(() => {}).then(() => command(incoming))
    commandQueue = task
    void task.then(() => {
      if (!commandId) return
      appliedCommandIds.add(commandId)
      if (appliedCommandIds.size > 200) appliedCommandIds.delete(appliedCommandIds.values().next().value)
      socket.emit('player:command:ack', { id: commandId, type: commandType, status: 'applied', appliedAt: Date.now() })
    }).catch((error) => {
      console.warn('[Ritim] Telefon komutu uygulanamadı:', error.message)
      if (commandId) socket.emit('player:command:ack', { id: commandId, type: commandType, status: 'failed', message: error.message, appliedAt: Date.now() })
    }).finally(() => {
      if (commandId) inFlightCommandIds.delete(commandId)
    })
  })

  async function capture() {
    if (destroyed || webContents.isDestroyed()) return
    if (playerTransitionActive) return
    const url = webContents.getURL()
    if (!url.startsWith('https://music.youtube.com/')) return
    try {
      const media = await webContents.executeJavaScript(`(() => {
        const session = navigator.mediaSession;
        const metadata = session && session.metadata;
        const artwork = metadata && metadata.artwork && metadata.artwork.length
          ? metadata.artwork[metadata.artwork.length - 1].src
          : '';
        const elements = [...document.querySelectorAll('video, audio')];
        const player = elements.find((item) => Number.isFinite(item.duration) && item.duration > 0) || elements[0];
        const playerApi = document.querySelector('ytmusic-player')?.playerApi;
        const playerData = typeof playerApi?.getVideoData === 'function' ? playerApi.getVideoData() || {} : {};
        let playerApiVolume = Number.NaN;
        try {
          const apiVolume = Number(playerApi?.getVolume?.());
          const apiMuted = Boolean(playerApi?.isMuted?.());
          if (Number.isFinite(apiVolume)) playerApiVolume = apiMuted ? 0 : apiVolume;
        } catch {}
        const textFrom = (root, selectors) => {
          for (const selector of selectors) {
            const value = root.querySelector(selector)?.textContent?.trim();
            if (value) return value;
          }
          return '';
        };
        const allQueueRoots = [...document.querySelectorAll('ytmusic-player-queue ytmusic-player-queue-item')];
        const queueVideoId = (root) => {
          const data = root?.data || root?.__data?.data || {};
          let videoId = data.videoId || data.navigationEndpoint?.watchEndpoint?.videoId || '';
          try {
            const link = root?.querySelector('a[href*="watch?v="]');
            videoId = videoId || (link ? new URL(link.href).searchParams.get('v') : '') || '';
          } catch {}
          return videoId;
        };
        const playerVideoId = String(playerData.video_id || playerData.videoId || '');
        const unwrapQueueItem = (entry) => entry?.playlistPanelVideoRenderer
          || entry?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer
          || null;
        const reduxQueueData = (document.querySelector('ytmusic-app')?.getState?.()?.queue?.items || [])
          .map(unwrapQueueItem).filter(Boolean);
        const selectedReduxIndex = playerVideoId ? reduxQueueData.findIndex((data) => data.videoId === playerVideoId) : -1;
        const selectedByVideoIndex = playerVideoId ? allQueueRoots.findIndex((root) => queueVideoId(root) === playerVideoId) : -1;
        const selectedByFlagIndex = allQueueRoots.findIndex((root) => Boolean(root.data?.selected || root.__data?.data?.selected));
        const selectedQueueIndex = selectedByVideoIndex >= 0 ? selectedByVideoIndex : selectedByFlagIndex;
        const queueRoots = selectedQueueIndex >= 0 ? allQueueRoots.slice(selectedQueueIndex) : allQueueRoots;
        const queueData = selectedReduxIndex >= 0
          ? reduxQueueData.slice(selectedReduxIndex)
          : queueRoots.map((root) => root.data || root.__data?.data || {});
        const selectedQueueRoot = selectedQueueIndex >= 0 ? allQueueRoots[selectedQueueIndex] : null;
        let currentVideoId = playerVideoId || queueVideoId(selectedQueueRoot);
        try {
          const selectedLink = selectedQueueRoot?.querySelector('a[href*="watch?v="]');
          currentVideoId = currentVideoId || (selectedLink ? new URL(selectedLink.href).searchParams.get('v') : '') || new URL(location.href).searchParams.get('v') || '';
        } catch {}
        const runsText = (value) => value?.runs?.map((run) => run.text || '').join('') || value?.simpleText || '';
        const absoluteMusicHref = (value) => {
          try {
            const target = new URL(value || '', location.origin);
            return target.origin === location.origin ? target.pathname + target.search : '';
          } catch { return ''; }
        };
        const findEndpoint = (value, depth = 0) => {
          if (!value || typeof value !== 'object' || depth > 7) return null;
          if (value.watchEndpoint || value.browseEndpoint || value.searchEndpoint) return value;
          for (const nested of Object.values(value)) {
            const endpoint = findEndpoint(nested, depth + 1);
            if (endpoint) return endpoint;
          }
          return null;
        };
        const hrefFromEndpoint = (value) => {
          const endpoint = findEndpoint(value);
          if (!endpoint) return '';
          if (endpoint.watchEndpoint?.videoId) {
            const query = new URLSearchParams({ v: endpoint.watchEndpoint.videoId });
            if (endpoint.watchEndpoint.playlistId) query.set('list', endpoint.watchEndpoint.playlistId);
            return '/watch?' + query.toString();
          }
          if (endpoint.searchEndpoint?.query) {
            const query = encodeURIComponent(endpoint.searchEndpoint.query);
            const params = endpoint.searchEndpoint.params ? '&sp=' + endpoint.searchEndpoint.params : '';
            return '/search?q=' + query + params;
          }
          const browseId = endpoint.browseEndpoint?.browseId || '';
          if (!browseId) return '';
          if (browseId.startsWith('VL')) return '/playlist?list=' + encodeURIComponent(browseId.slice(2));
          if (browseId.startsWith('UC')) return '/channel/' + encodeURIComponent(browseId);
          return '/browse/' + encodeURIComponent(browseId);
        };
        const flexText = (data, index) => runsText(data.flexColumns?.[index]?.musicResponsiveListItemFlexColumnRenderer?.text);
        const thumbnailList = (data) => data.thumbnail?.thumbnails
          || data.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
          || data.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails
          || data.foregroundThumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
          || [];
        const pageTypeOf = (endpoint) => findEndpoint(endpoint)?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
        const musicBrowseId = location.pathname.startsWith('/browse/') ? location.pathname.slice('/browse/'.length) : '';
        const route = location.pathname === '/' || musicBrowseId === 'FEmusic_home' ? 'home'
          : location.pathname.startsWith('/explore') || /^FEmusic_(explore|moods_and_genres)/.test(musicBrowseId) ? 'explore'
          : location.pathname.startsWith('/library') || /^FEmusic_(library|liked)/.test(musicBrowseId) ? 'library'
          : location.pathname.startsWith('/search') ? 'search'
          : 'detail';
        const searchQuery = new URL(location.href).searchParams.get('q') || '';
        const isRendered = (root) => Boolean(root && (root.offsetParent !== null || root.getClientRects().length > 0));
        const chipRoots = [...document.querySelectorAll('ytmusic-chip-cloud-chip-renderer')].filter(isRendered);
        const filters = chipRoots.map((root, index) => {
          const data = root.data || root.__data?.data || {};
          const label = runsText(data.text) || root.textContent?.trim() || '';
          return { id: String(data.uniqueId || index + '-' + label), label, href: hrefFromEndpoint(data.navigationEndpoint), selected: Boolean(data.isSelected) };
        }).filter((item) => item.label && item.href);
        const headerRoot = [...document.querySelectorAll('ytmusic-immersive-header-renderer, ytmusic-visual-header-renderer, ytmusic-detail-header-renderer, ytmusic-editable-playlist-detail-header-renderer, ytmusic-header-renderer')].find(isRendered);
        let browseHeader;
        if (headerRoot) {
          const data = headerRoot.data || headerRoot.__data?.data || {};
          const title = runsText(data.title) || textFrom(headerRoot, ['h1', '.title', 'yt-formatted-string.title']);
          const monthly = runsText(data.monthlyListenerCount);
          const subscriber = runsText(data.subscriptionButton?.subscribeButtonRenderer?.longSubscriberCountText);
          const subtitleParts = [monthly, runsText(data.subtitle), runsText(data.secondSubtitle), runsText(data.straplineTextOne), subscriber].filter(Boolean);
          const subtitle = [...new Set(subtitleParts)].join(' • ');
          const description = runsText(data.description) || textFrom(headerRoot, ['#description', '.description']);
          const thumbnails = thumbnailList(data);
          const pageText = (subtitle + ' ' + location.pathname).toLocaleLowerCase('tr');
          const kind = headerRoot.matches('ytmusic-immersive-header-renderer') ? 'artist'
            : pageText.includes('albüm') ? 'album'
            : pageText.includes('oynatma listesi') || location.pathname.startsWith('/playlist') ? 'playlist'
            : pageText.includes('podcast') ? 'podcast'
            : 'unknown';
          browseHeader = {
            title,
            subtitle,
            description,
            thumbnailUrl: thumbnails.length ? thumbnails[thumbnails.length - 1].url : headerRoot.querySelector('img')?.src || '',
            kind,
            playHref: hrefFromEndpoint(data.playButton),
            radioHref: hrefFromEndpoint(data.startRadioButton),
          };
        }
        const sectionRoots = [...document.querySelectorAll('ytmusic-carousel-shelf-renderer, ytmusic-shelf-renderer, ytmusic-grid-renderer')]
          .filter((root) => !root.closest('ytmusic-player-page') && isRendered(root));
        const browseSections = [];
        const seenSectionItems = new Set();
        const itemFromRoot = (root, sectionIndex, itemIndex, seenItems = seenSectionItems) => {
          const data = root.data || root.__data?.data || {};
          const title = runsText(data.title) || flexText(data, 0) || textFrom(root, ['#video-title', '.title', 'yt-formatted-string.title', '.song-title']);
          if (!title) return null;
          const endpoint = findEndpoint(data.navigationEndpoint) || findEndpoint(data.flexColumns?.[0]) || findEndpoint(data.overlay);
          const link = root.querySelector('a[href*="watch"], a[href*="browse"], a[href*="playlist"], a[href*="channel"]');
          const href = hrefFromEndpoint(endpoint) || absoluteMusicHref(link?.getAttribute('href') || '');
          let videoId = data.videoId || data.playlistItemData?.videoId || endpoint?.watchEndpoint?.videoId || '';
          try { videoId = videoId || new URL(href, location.origin).searchParams.get('v') || ''; } catch {}
          const key = videoId || href || sectionIndex + ':' + itemIndex + ':' + title;
          if (seenItems.has(key)) return null;
          seenItems.add(key);
          const thumbnails = thumbnailList(data);
          const flexSubtitles = [flexText(data, 1), flexText(data, 2)].filter(Boolean);
          const subtitle = runsText(data.subtitle) || [...new Set(flexSubtitles)].join(' • ')
            || textFrom(root, ['.subtitle', '#subtitle', '.secondary-flex-columns', '.byline']);
          const lower = (subtitle + ' ' + href).toLocaleLowerCase('tr');
          const pageType = pageTypeOf(endpoint);
          const kind = pageType.includes('USER_CHANNEL') ? 'profile'
            : pageType.includes('ARTIST') || lower.includes('sanatçı') ? 'artist'
            : pageType.includes('ALBUM') || lower.includes('albüm') || lower.includes('single') ? 'album'
            : pageType.includes('PLAYLIST') || href.includes('playlist') || lower.includes('oynatma listesi') ? (lower.includes('mix') ? 'mix' : 'playlist')
            : lower.includes('podcast') ? 'podcast'
            : lower.includes('bölüm') ? 'episode'
            : lower.includes('video') ? 'video'
            : videoId ? 'song'
            : lower.includes('profil') ? 'profile'
            : 'unknown';
          return { id: key, title, subtitle, thumbnailUrl: thumbnails.length ? thumbnails[thumbnails.length - 1].url : root.querySelector('img')?.src || '', href, videoId, kind };
        };
        const relatedItems = [];
        const seenRelatedItems = new Set();
        const relatedSections = [...document.querySelectorAll('ytmusic-player-page ytmusic-carousel-shelf-renderer')]
          .filter((root) => root.offsetParent !== null || root.getClientRects().length > 0);
        for (const [sectionIndex, sectionRoot] of relatedSections.entries()) {
          const itemRoots = [...sectionRoot.querySelectorAll('ytmusic-two-row-item-renderer, ytmusic-responsive-list-item-renderer')];
          for (const [itemIndex, root] of itemRoots.entries()) {
            const item = itemFromRoot(root, 'related-' + sectionIndex, itemIndex, seenRelatedItems);
            if (item) relatedItems.push(item);
            if (relatedItems.length >= 40) break;
          }
          if (relatedItems.length >= 40) break;
        }
        for (const [sectionIndex, sectionRoot] of sectionRoots.entries()) {
          const sectionTitle = textFrom(sectionRoot, ['#header .title', '#header yt-formatted-string', 'h2', '.title'])
            || (route === 'search' && sectionIndex === 0 ? 'Arama sonuçları' : '');
          const itemRoots = [...sectionRoot.querySelectorAll('ytmusic-two-row-item-renderer, ytmusic-responsive-list-item-renderer')];
          const items = [];
          for (const [itemIndex, root] of itemRoots.entries()) {
            const item = itemFromRoot(root, sectionIndex, itemIndex);
            if (item) items.push(item);
            if (items.length >= 120) break;
          }
          if (items.length) browseSections.push({
            id: 'section-' + sectionIndex + '-' + sectionTitle,
            title: sectionTitle || (route === 'search' ? 'Sonuçlar' : 'Senin için'),
            layout: sectionRoot.matches('ytmusic-shelf-renderer') ? 'list' : 'rail',
            items,
          });
          if (browseSections.length >= 30) break;
        }
        const remainingRoots = [...document.querySelectorAll('ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer')]
          .filter((root) => !root.closest('ytmusic-player-page') && isRendered(root));
        const remaining = [];
        for (const [itemIndex, root] of remainingRoots.entries()) {
          const item = itemFromRoot(root, 99, itemIndex);
          if (item) remaining.push(item);
          if (remaining.length >= 240) break;
        }
        if (remaining.length) {
          if (route === 'search') {
            const labels = { artist: 'Sanatçılar', song: 'Şarkılar', album: 'Albümler', playlist: 'Oynatma listeleri', mix: 'Mixler', video: 'Videolar', profile: 'Profiller', podcast: 'Podcast’ler', episode: 'Bölümler', unknown: 'Diğer sonuçlar' };
            const order = ['artist', 'song', 'album', 'playlist', 'mix', 'video', 'profile', 'podcast', 'episode', 'unknown'];
            for (const kind of order) {
              const items = remaining.filter((item) => item.kind === kind);
              if (items.length) browseSections.push({ id: 'search-' + kind, title: labels[kind], layout: 'list', items });
            }
          } else {
            browseSections.push({ id: 'more-results', title: route === 'library' ? 'Kitaplığın' : 'Daha fazlası', layout: 'list', items: remaining });
          }
        }
        const normalizeQueueText = (value) => String(value || '').toLocaleLowerCase('tr').replace(/[^a-z0-9çğıöşü]+/gi, ' ').trim();
        const seenQueueIds = new Set();
        const seenQueueTracks = new Set();
        let lastQueueTitle = '';
        const queue = [];
        for (const data of queueData) {
          const root = queueRoots.find((candidate) => (candidate.data || candidate.__data?.data || {}).videoId === data.videoId) || null;
          const link = root?.querySelector('a[href*="watch?v="]');
          let videoId = data.videoId || data.navigationEndpoint?.watchEndpoint?.videoId || '';
          try { if (link) videoId = new URL(link.href).searchParams.get('v') || videoId; } catch {}
          if (!videoId) continue;
          const title = runsText(data.title) || (root ? textFrom(root, ['#video-title', '.song-title', 'yt-formatted-string.title', '.title']) : '');
          if (!title) continue;
          const artist = runsText(data.shortBylineText) || runsText(data.longBylineText) || (root ? textFrom(root, ['#byline', '.byline', 'yt-formatted-string.byline', '.subtitle']) : '');
          const normalizedQueueTitle = normalizeQueueText(title);
          const queueTrackKey = normalizedQueueTitle + '|' + normalizeQueueText(artist);
          if (seenQueueIds.has(videoId) || seenQueueTracks.has(queueTrackKey) || normalizedQueueTitle === lastQueueTitle) continue;
          seenQueueIds.add(videoId);
          seenQueueTracks.add(queueTrackKey);
          lastQueueTitle = normalizedQueueTitle;
          const thumbnails = data.thumbnail?.thumbnails || [];
          queue.push({
            videoId,
            title,
            artist,
            durationText: runsText(data.lengthText) || (root ? textFrom(root, ['#duration', '.duration', '.time-info']) : ''),
            artwork: thumbnails.length ? thumbnails[thumbnails.length - 1].url : root?.querySelector('img')?.src || ''
          });
          if (queue.length >= 20) break;
        }
        const lyricsShelves = [...document.querySelectorAll('ytmusic-description-shelf-renderer')];
        const lyricsShelf = lyricsShelves.find((root) => root.offsetParent !== null || root.getClientRects().length > 0) || null;
        const lyricsDescription = lyricsShelf && (lyricsShelf.querySelector('#description, .description, yt-formatted-string.description') || lyricsShelf);
        const lyricsText = lyricsDescription?.textContent?.trim() || '';
        const lyricsLines = lyricsText.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
        const selectedLyricsTab = [...document.querySelectorAll('ytmusic-player-page tp-yt-paper-tab, ytmusic-player-page yt-tab-shape, #tabs tp-yt-paper-tab, #tabs yt-tab-shape')]
          .find((tab) => (tab.selected || tab.getAttribute('aria-selected') === 'true') && /lyrics|şarkı sözleri|sözler/i.test((tab.textContent || '').trim()));
        const selectedLyricsText = selectedLyricsTab?.parentElement?.parentElement?.textContent || '';
        const lyricsMessageText = [...document.querySelectorAll('ytmusic-message-renderer, ytmusic-player-page .message')]
          .filter((root) => root.offsetParent !== null || root.getClientRects().length > 0)
          .map((root) => root.textContent || '').join(' ');
        const lyricsUnavailable = Boolean(selectedLyricsTab && !lyricsLines.length && /not available|kullanılamıyor|mevcut değil|bulunamadı/i.test(selectedLyricsText + ' ' + lyricsMessageText));
        return {
          title: playerData.title || metadata && metadata.title || '',
          artist: playerData.author || metadata && metadata.artist || '',
          album: metadata && metadata.album || '',
          artwork,
          playbackState: session && session.playbackState || 'none',
          pageTitle: document.title || '',
          position: player && Number.isFinite(player.currentTime) ? player.currentTime : 0,
          duration: player && Number.isFinite(player.duration) ? player.duration : 0,
          volume: Number.isFinite(playerApiVolume) ? playerApiVolume : player ? (player.muted ? 0 : player.volume * 100) : 68,
          paused: player ? player.paused : null,
          currentVideoId,
          queueAligned: selectedByVideoIndex >= 0 || selectedReduxIndex >= 0,
          queue,
          lyricsLines,
          lyricsUnavailable,
          relatedItems,
          browse: {
            route,
            title: route === 'home' ? 'Ana Sayfa' : route === 'explore' ? 'Keşfet' : route === 'library' ? 'Kitaplık' : route === 'search' ? (searchQuery || 'Arama') : (browseHeader?.title || document.querySelector('h1')?.textContent?.trim() || document.title.replace(' - YouTube Music', '')),
            url: location.href,
            filters,
            header: browseHeader,
            sections: browseSections,
          }
        };
      })()`, true)
      const title = String(media.title || '').trim()
      const artist = String(media.artist || '').trim()
      const currentVideoId = String(media.currentVideoId || '').trim()
      const normalizedCapturedTitle = title.toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim()
      const normalizedExpectedTitle = expectedTrackTitle.toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim()
      const expectedTitleReady = !normalizedExpectedTitle || normalizedCapturedTitle === normalizedExpectedTitle
      if (expectedVideoId && (currentVideoId !== expectedVideoId || !expectedTitleReady || !media.queueAligned) && Date.now() < expectedVideoDeadline) return
      if (expectedVideoId && currentVideoId === expectedVideoId && expectedTitleReady && media.queueAligned) {
        expectedVideoId = ''
        expectedTrackTitle = ''
        expectedVideoDeadline = 0
      } else if (expectedVideoId && Date.now() >= expectedVideoDeadline) {
        expectedVideoId = ''
        expectedTrackTitle = ''
        expectedVideoDeadline = 0
      }
      const id = title ? (currentVideoId ? `ytmusic:video:${currentVideoId}` : trackId(title, artist)) : state.trackId
      const previousTrack = state.catalog[id] || state.catalog[state.trackId] || idleTrack
      const track = title ? {
        id, title, artist: artist || 'YouTube Music', collection: String(media.album || 'YouTube Music'),
        duration: Math.max(0, Math.round(Number(media.duration) || 0)), cover: 0,
        thumbnailUrl: String(media.artwork || ''), youtubeVideoId: currentVideoId || undefined, source: 'ytmusic',
      } : previousTrack
      const queueTracks = Array.isArray(media.queue)
        ? media.queue.map((item) => {
          const itemArtist = String(item.artist || '').split(' • ')[0].trim() || 'YouTube Music'
          return {
            id: `ytmusic:video:${String(item.videoId || '')}`,
            title: String(item.title || '').trim(),
            artist: itemArtist,
            collection: 'Sıradaki',
            duration: parseDuration(item.durationText),
            cover: 0,
            thumbnailUrl: String(item.artwork || ''),
            youtubeVideoId: String(item.videoId || ''),
            source: 'ytmusic',
          }
        }).filter((item) => item.title && item.youtubeVideoId)
        : []
      if (queueTracks.length === 0 && state.trackId !== idleTrack.id) {
        for (const queueId of state.queue) {
          const preservedTrack = state.catalog[queueId]
          if (preservedTrack && preservedTrack.id !== idleTrack.id) queueTracks.push(preservedTrack)
        }
      }
      const normalizedTitle = title.toLocaleLowerCase('tr').trim()
      const currentQueueIndex = queueTracks.findIndex((item) => item.youtubeVideoId === currentVideoId || item.title.toLocaleLowerCase('tr').trim() === normalizedTitle)
      if (currentQueueIndex >= 0) {
        if (currentQueueIndex > 0) queueTracks.splice(0, currentQueueIndex)
        queueTracks[0] = { ...queueTracks[0], ...track, youtubeVideoId: currentVideoId || queueTracks[0].youtubeVideoId }
      }
      else if (title) queueTracks.unshift(track)
      if (queueTracks.length === 0) queueTracks.push(track)
      const catalog = { ...state.catalog, ...Object.fromEntries(queueTracks.map((item) => [item.id, item])) }
      catalog[id] = { ...catalog[id], ...track }
      const queueIds = queueTracks.map((item) => item.id)
      const isAudible = webContents.isCurrentlyAudible()
      const isPlaying = isAudible || (typeof media.paused === 'boolean'
        ? !media.paused
        : media.playbackState === 'playing')
      const position = !title && !(Number(media.duration) > 0)
        ? state.position
        : Math.max(0, Math.floor(Number(media.position) || 0))
      const capturedVolume = Math.max(0, Math.min(100, Math.round(Number(media.volume) || 0)))
      let volume = capturedVolume
      if (expectedVolume !== null && Date.now() < expectedVolumeDeadline) {
        volume = expectedVolume
        if (Math.abs(capturedVolume - expectedVolume) > 1 && Date.now() - lastVolumeReapplyAt > 500) {
          lastVolumeReapplyAt = Date.now()
          void applyVolumeLevel(expectedVolume, volumeCommandSequence).catch(() => {})
        }
      } else if (expectedVolume !== null) {
        expectedVolume = null
        expectedVolumeDeadline = 0
        lastVolumeReapplyAt = 0
      }
      const browse = !navigationTask && media.browse && typeof media.browse === 'object'
        ? mergeBrowseState(state.browse, media.browse)
        : state.browse
      const browseSignature = JSON.stringify([browse?.route, browse?.url, browse?.filters, browse?.header, browse?.sections, browse?.loadingMore, browse?.hasMore])
      const previousLyrics = state.lyrics?.trackId === id ? state.lyrics : { trackId: id, status: 'idle', lines: [] }
      const lyrics = Array.isArray(media.lyricsLines) && media.lyricsLines.length
        ? { trackId: id, status: 'ready', lines: media.lyricsLines.map((line) => String(line)) }
        : media.lyricsUnavailable
          ? { trackId: id, status: 'unavailable', lines: [] }
          : previousLyrics
      const previousRelated = state.related?.trackId === id ? state.related : { trackId: id, status: 'idle', items: [] }
      const relatedItems = Array.isArray(media.relatedItems)
        ? media.relatedItems.map((item) => ({
          id: String(item.id || item.videoId || item.href || ''),
          title: String(item.title || '').trim(),
          subtitle: String(item.subtitle || '').trim(),
          thumbnailUrl: String(item.thumbnailUrl || ''),
          href: String(item.href || ''),
          videoId: String(item.videoId || ''),
          kind: String(item.kind || 'unknown'),
        })).filter((item) => item.id && item.title)
        : []
      const related = relatedItems.length
        ? { trackId: id, status: 'ready', items: relatedItems }
        : previousRelated
      const lyricsSignature = JSON.stringify([lyrics.status, lyrics.lines])
      const relatedSignature = JSON.stringify([related.status, related.items])
      const signature = JSON.stringify([id, track.collection, track.thumbnailUrl, isPlaying, position, track.duration, volume, queueIds, browseSignature, lyricsSignature, relatedSignature])
      if (signature === lastSignature) return
      lastSignature = signature
      state = {
        ...state, trackId: id, isPlaying, position, volume, queue: queueIds,
        catalog, browse, lyrics, related, updatedAt: Date.now(),
      }
      socket.emit('player:update', { room, state })
      presence?.update({
        title: track.title,
        artist: track.artist,
        isPlaying,
        startedAt: isPlaying ? Date.now() - position * 1000 : undefined,
      })
    } catch (error) {
      if (!destroyed) console.warn('[Ritim] YouTube Music medya bilgisi okunamadı:', error.message)
    }
  }

  const onMediaChange = () => void capture()
  webContents.on('media-started-playing', onMediaChange)
  webContents.on('media-paused', onMediaChange)
  webContents.on('page-title-updated', onMediaChange)
  webContents.on('did-finish-load', onMediaChange)
  timer = setInterval(capture, 750)

  return {
    capture,
    command,
    destroy() {
      destroyed = true
      pendingNavigation = null
      clearInterval(timer)
      socket.close()
      if (!webContents.isDestroyed()) {
        webContents.off('media-started-playing', onMediaChange)
        webContents.off('media-paused', onMediaChange)
        webContents.off('page-title-updated', onMediaChange)
        webContents.off('did-finish-load', onMediaChange)
      }
    },
  }
}

module.exports = { createYouTubeMusicBridge }
