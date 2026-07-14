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
    updatedAt: Date.now(),
  }
  let lastSignature = ''
  let destroyed = false
  let timer
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
    if (command.type === 'next') sendKey('MediaNextTrack')
    if (command.type === 'previous') sendKey('MediaPreviousTrack')
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
    }
    if (command.type === 'playTrack') {
      const videoId = String(command.value || '').trim()
      if (/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
        await webContents.loadURL(`https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`)
      }
    }
    if (command.type === 'navigateUrl') {
      try {
        const target = new URL(String(command.value || ''), 'https://music.youtube.com/')
        if (target.origin === 'https://music.youtube.com') await webContents.loadURL(target.toString())
      } catch {}
    }
    if (command.type === 'goBack') {
      const history = webContents.navigationHistory
      if (history?.canGoBack()) history.goBack()
      else await webContents.loadURL('https://music.youtube.com/')
    }
    if (command.type.startsWith('navigate:')) {
      const destination = command.type.slice('navigate:'.length)
      const routes = {
        home: 'https://music.youtube.com/',
        explore: 'https://music.youtube.com/explore',
        library: 'https://music.youtube.com/library',
      }
      const target = destination === 'search'
        ? `https://music.youtube.com/search?q=${encodeURIComponent(String(command.value || '').trim())}`
        : routes[destination]
      if (target) await webContents.loadURL(target)
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
        const textFrom = (root, selectors) => {
          for (const selector of selectors) {
            const value = root.querySelector(selector)?.textContent?.trim();
            if (value) return value;
          }
          return '';
        };
        const allQueueRoots = [...document.querySelectorAll('ytmusic-player-queue ytmusic-player-queue-item')];
        const selectedQueueIndex = allQueueRoots.findIndex((root) => Boolean(root.data?.selected || root.__data?.data?.selected));
        const queueRoots = selectedQueueIndex >= 0 ? allQueueRoots.slice(selectedQueueIndex) : allQueueRoots;
        const selectedQueueRoot = selectedQueueIndex >= 0 ? allQueueRoots[selectedQueueIndex] : null;
        const selectedQueueData = selectedQueueRoot?.data || selectedQueueRoot?.__data?.data || {};
        let currentVideoId = selectedQueueData.videoId || selectedQueueData.navigationEndpoint?.watchEndpoint?.videoId || '';
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
        const route = location.pathname === '/' ? 'home'
          : location.pathname.startsWith('/explore') ? 'explore'
          : location.pathname.startsWith('/library') || location.pathname.startsWith('/browse/FEmusic_') ? 'library'
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
        const sectionRoots = [...document.querySelectorAll('ytmusic-carousel-shelf-renderer, ytmusic-shelf-renderer, ytmusic-grid-renderer')];
        const browseSections = [];
        const seenSectionItems = new Set();
        const itemFromRoot = (root, sectionIndex, itemIndex) => {
          const data = root.data || root.__data?.data || {};
          const title = runsText(data.title) || flexText(data, 0) || textFrom(root, ['#video-title', '.title', 'yt-formatted-string.title', '.song-title']);
          if (!title) return null;
          const endpoint = findEndpoint(data.navigationEndpoint) || findEndpoint(data.flexColumns?.[0]) || findEndpoint(data.overlay);
          const link = root.querySelector('a[href*="watch"], a[href*="browse"], a[href*="playlist"], a[href*="channel"]');
          const href = hrefFromEndpoint(endpoint) || absoluteMusicHref(link?.getAttribute('href') || '');
          let videoId = data.videoId || data.playlistItemData?.videoId || endpoint?.watchEndpoint?.videoId || '';
          try { videoId = videoId || new URL(href, location.origin).searchParams.get('v') || ''; } catch {}
          const key = videoId || href || sectionIndex + ':' + itemIndex + ':' + title;
          if (seenSectionItems.has(key)) return null;
          seenSectionItems.add(key);
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
        for (const [sectionIndex, sectionRoot] of sectionRoots.entries()) {
          const sectionTitle = textFrom(sectionRoot, ['#header .title', '#header yt-formatted-string', 'h2', '.title'])
            || (route === 'search' && sectionIndex === 0 ? 'Arama sonuçları' : '');
          const itemRoots = [...sectionRoot.querySelectorAll('ytmusic-two-row-item-renderer, ytmusic-responsive-list-item-renderer')];
          const items = [];
          for (const [itemIndex, root] of itemRoots.entries()) {
            const item = itemFromRoot(root, sectionIndex, itemIndex);
            if (item) items.push(item);
            if (items.length >= 40) break;
          }
          if (items.length) browseSections.push({
            id: 'section-' + sectionIndex + '-' + sectionTitle,
            title: sectionTitle || (route === 'search' ? 'Sonuçlar' : 'Senin için'),
            layout: sectionRoot.matches('ytmusic-shelf-renderer') ? 'list' : 'rail',
            items,
          });
          if (browseSections.length >= 12) break;
        }
        const remainingRoots = [...document.querySelectorAll('ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer')];
        const remaining = [];
        for (const [itemIndex, root] of remainingRoots.entries()) {
          const item = itemFromRoot(root, 99, itemIndex);
          if (item) remaining.push(item);
          if (remaining.length >= 80) break;
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
        return {
          title: metadata && metadata.title || '',
          artist: metadata && metadata.artist || '',
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
      if (currentQueueIndex >= 0) queueTracks[currentQueueIndex] = { ...queueTracks[currentQueueIndex], ...track, youtubeVideoId: currentVideoId || queueTracks[currentQueueIndex].youtubeVideoId }
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
        ? { ...media.browse, updatedAt: Date.now() }
        : state.browse
      const browseSignature = JSON.stringify([browse?.route, browse?.url, browse?.filters, browse?.header, browse?.sections])
      const signature = JSON.stringify([id, track.collection, track.thumbnailUrl, isPlaying, position, track.duration, volume, queueIds, browseSignature])
      if (signature === lastSignature) return
      lastSignature = signature
      state = {
        ...state, trackId: id, isPlaying, position, volume, queue: queueIds,
        catalog, browse, updatedAt: Date.now(),
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
