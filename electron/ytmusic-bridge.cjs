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
  let expectedVideoDeadline = 0
  let actionSequence = 0
  let loadMoreTask = null
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

  async function clickPlayerButton(kind) {
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
    setTimeout(() => void capture(), 180)
    return clicked
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

  async function performNavigation({ target, destination }) {
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
    return webContents.executeJavaScript(`(() => new Promise((resolve) => {
      const kind = ${JSON.stringify(kind)};
      const selectTab = () => {
        const tabs = [...document.querySelectorAll('ytmusic-player-page tp-yt-paper-tab, ytmusic-player-page yt-tab-shape, #tabs tp-yt-paper-tab, #tabs yt-tab-shape')];
        const pattern = kind === 'lyrics' ? /lyrics|şarkı sözleri|sözler/i : /related|benzer/i;
        const tab = tabs.find((item) => pattern.test((item.textContent || '').trim()));
        if (!tab || tab.getAttribute('aria-disabled') === 'true') {
          resolve(false);
          return;
        }
        tab.click();
        resolve(true);
      };
      const page = document.querySelector('ytmusic-player-page');
      if (page?.playerPageOpen) {
        selectTab();
        return;
      }
      const toggle = document.querySelector('ytmusic-player-bar .toggle-player-page-button');
      if (!toggle) {
        resolve(false);
        return;
      }
      toggle.click();
      setTimeout(selectTab, 350);
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
      };
      const item = [...document.querySelectorAll('[role="menuitem"], ytmusic-menu-navigation-item-renderer, ytmusic-menu-service-item-renderer')]
        .find((candidate) => (candidate.offsetParent !== null || candidate.getClientRects().length > 0)
          && patterns[action]?.test((candidate.textContent || '').replace(/\\s+/g, ' ').trim()));
      if (!item) return false;
      item.click();
      return true;
    })()`, true)
  }

  async function restoreBrowseScroll(scrollTop) {
    await webContents.executeJavaScript(`(() => {
      if (document.scrollingElement) document.scrollingElement.scrollTop = ${JSON.stringify(Number(scrollTop) || 0)};
    })()`, true).catch(() => {})
  }

  async function performItemAction(item, action) {
    const previousTop = await openItemMenu(item)
    if (previousTop === null) {
      publishAction('error', `${item.title || 'İçerik'} için işlem menüsü bulunamadı`)
      return
    }
    const clicked = await clickVisibleMenuAction(action)
    if (!clicked) {
      sendKey('Escape')
      await restoreBrowseScroll(previousTop)
      publishAction('error', 'Bu işlem YouTube Music menüsünde bulunamadı')
      return
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
        publishAction('error', 'Oynatma listeleri YouTube Music’ten alınamadı')
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
      const volume = Math.max(0, Math.min(100, Number(command.value))) / 100
      await webContents.executeJavaScript(`(() => {
        const media = [...document.querySelectorAll('video, audio')]
          .find((item) => Number.isFinite(item.duration) && item.duration > 0);
        if (!media) return false;
        media.muted = false;
        media.volume = ${JSON.stringify(volume)};
        return true;
      })()`, true)
      setTimeout(() => void capture(), 80)
    }
    if (command.type === 'playTrack') {
      const videoId = String(command.value || '').trim()
      if (/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
        expectedVideoId = videoId
        expectedVideoDeadline = Date.now() + 5000
        const loaded = await webContents.executeJavaScript(`(() => {
          const playerApi = document.querySelector('ytmusic-player')?.playerApi;
          if (typeof playerApi?.loadVideoById !== 'function') return false;
          playerApi.loadVideoById(${JSON.stringify(videoId)}, 0);
          return true;
        })()`, true)
        if (!loaded) await queueNavigation(`https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`)
        setTimeout(() => void capture(), 150)
        setTimeout(() => void capture(), 700)
      }
    }
    if (command.type === 'loadMoreBrowse') await loadMoreBrowse()
    if (command.type === 'itemAction') {
      try {
        const payload = JSON.parse(String(command.value || '{}'))
        const supported = ['playNext', 'addQueue', 'savePlaylist', 'saveLibrary']
        if (payload?.item && supported.includes(payload.action)) await performItemAction(payload.item, payload.action)
      } catch {
        publishAction('error', 'Telefon işlemi okunamadı')
      }
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
        await queueNavigation(target, destination === 'search' ? '' : destination)
      }
    }
  }

  socket.on('player:command', (incoming) => {
    void command(incoming).catch((error) => console.warn('[Ritim] Telefon komutu uygulanamadı:', error.message))
  })

  async function capture() {
    if (destroyed || webContents.isDestroyed()) return
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
        const selectedByVideoIndex = playerVideoId ? allQueueRoots.findIndex((root) => queueVideoId(root) === playerVideoId) : -1;
        const selectedByFlagIndex = allQueueRoots.findIndex((root) => Boolean(root.data?.selected || root.__data?.data?.selected));
        const selectedQueueIndex = selectedByVideoIndex >= 0 ? selectedByVideoIndex : selectedByFlagIndex;
        const queueRoots = selectedQueueIndex >= 0 ? allQueueRoots.slice(selectedQueueIndex) : allQueueRoots;
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
        const chipRoots = [...document.querySelectorAll('ytmusic-chip-cloud-chip-renderer')];
        const filters = chipRoots.map((root, index) => {
          const data = root.data || root.__data?.data || {};
          const label = runsText(data.text) || root.textContent?.trim() || '';
          return { id: String(data.uniqueId || index + '-' + label), label, href: hrefFromEndpoint(data.navigationEndpoint), selected: Boolean(data.isSelected) };
        }).filter((item) => item.label && item.href);
        const headerRoot = document.querySelector('ytmusic-immersive-header-renderer, ytmusic-visual-header-renderer, ytmusic-detail-header-renderer, ytmusic-editable-playlist-detail-header-renderer, ytmusic-header-renderer');
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
          .filter((root) => !root.closest('ytmusic-player-page'));
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
          .filter((root) => !root.closest('ytmusic-player-page'));
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
        for (const root of queueRoots) {
          const data = root.data || root.__data?.data || {};
          const link = root.querySelector('a[href*="watch?v="]');
          let videoId = data.videoId || data.navigationEndpoint?.watchEndpoint?.videoId || '';
          try { if (link) videoId = new URL(link.href).searchParams.get('v') || videoId; } catch {}
          if (!videoId) continue;
          const title = runsText(data.title) || textFrom(root, ['#video-title', '.song-title', 'yt-formatted-string.title', '.title']);
          if (!title) continue;
          const artist = runsText(data.shortBylineText) || runsText(data.longBylineText) || textFrom(root, ['#byline', '.byline', 'yt-formatted-string.byline', '.subtitle']);
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
            durationText: runsText(data.lengthText) || textFrom(root, ['#duration', '.duration', '.time-info']),
            artwork: thumbnails.length ? thumbnails[thumbnails.length - 1].url : root.querySelector('img')?.src || ''
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
          volume: player ? (player.muted ? 0 : player.volume * 100) : 68,
          paused: player ? player.paused : null,
          currentVideoId,
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
      if (expectedVideoId && currentVideoId !== expectedVideoId && Date.now() < expectedVideoDeadline) return
      if (expectedVideoId && currentVideoId === expectedVideoId) {
        expectedVideoId = ''
        expectedVideoDeadline = 0
      } else if (expectedVideoId && Date.now() >= expectedVideoDeadline) {
        expectedVideoId = ''
        expectedVideoDeadline = 0
      }
      const id = title ? (currentVideoId ? `ytmusic:video:${currentVideoId}` : trackId(title, artist)) : state.trackId
      const previousTrack = state.catalog[id] || idleTrack
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
      const normalizedTitle = title.toLocaleLowerCase('tr').trim()
      const currentQueueIndex = queueTracks.findIndex((item) => item.youtubeVideoId === currentVideoId || item.title.toLocaleLowerCase('tr').trim() === normalizedTitle)
      if (currentQueueIndex >= 0) {
        if (currentQueueIndex > 0) queueTracks.splice(0, currentQueueIndex)
        queueTracks[0] = { ...queueTracks[0], ...track, youtubeVideoId: currentVideoId || queueTracks[0].youtubeVideoId }
      }
      else if (title) queueTracks.unshift(track)
      if (queueTracks.length === 0) queueTracks.push(track)
      const catalog = Object.fromEntries(queueTracks.map((item) => [item.id, item]))
      catalog[id] = { ...catalog[id], ...track }
      const queueIds = queueTracks.map((item) => item.id)
      const isPlaying = typeof media.paused === 'boolean'
        ? !media.paused
        : media.playbackState === 'playing' || webContents.isCurrentlyAudible()
      const position = Math.max(0, Math.floor(Number(media.position) || 0))
      const volume = Math.max(0, Math.min(100, Math.round(Number(media.volume) || 0)))
      const browse = media.browse && typeof media.browse === 'object'
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
      presence?.update({ title: track.title, artist: track.artist, isPlaying })
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
