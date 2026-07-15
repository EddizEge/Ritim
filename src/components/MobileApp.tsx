import { FormEvent, memo, useEffect, useMemo, useState } from 'react'
import {
  Bug, ChevronDown, ChevronLeft, Compass, Download, Heart, Home, Library, ListMusic,
  MonitorSpeaker, MoreVertical, Pause, Play, RefreshCw, Search, SkipForward, Volume1, Volume2, X,
} from 'lucide-react'
import { formatTime, getTrack } from '../data'
import type { LyricsState, MusicBrowseFilter, MusicBrowseHeader, MusicBrowseItem, MusicBrowseSection, PlayerActions, PlayerState, Track } from '../types'
import { Cover } from './Cover'
import { FeedbackSheet } from './FeedbackSheet'
import { PlayerControls } from './PlayerControls'
import { Progress } from './Progress'
import { clearMobilePairing, isNativeMobile, readMobilePairing } from '../mobileConfig'
import { useMobileUpdate } from '../hooks/useMobileUpdate'

type Props = {
  state: PlayerState
  actions: PlayerActions
  connected: boolean
  peerCount: number
  room: string
  pairingError?: string
}

type BrowseRoute = 'home' | 'explore' | 'library' | 'search' | 'detail'
type InfoTab = 'queue' | 'lyrics' | 'related'

function queueTrackKey(track: Track) {
  const title = track.title.toLocaleLowerCase('tr').replace(/[^a-z0-9çğıöşü]+/gi, ' ').trim()
  const artist = track.artist.toLocaleLowerCase('tr').replace(/[^a-z0-9çğıöşü]+/gi, ' ').trim()
  return `${title}|${artist}`
}

function queueTitleKey(track: Track) {
  return track.title.toLocaleLowerCase('tr').replace(/[^a-z0-9çğıöşü]+/gi, ' ').trim()
}

const routeLabels: Record<BrowseRoute, string> = {
  home: 'Ana Sayfa',
  explore: 'Keşfet',
  library: 'Kitaplık',
  search: 'Ara',
  detail: 'Detay',
}

function queryFromBrowseUrl(url = '') {
  try { return new URL(url).searchParams.get('q')?.trim() || '' } catch { return '' }
}

const LyricsPanel = memo(function LyricsPanel({ lyrics }: { lyrics?: LyricsState }) {
  if (lyrics?.status === 'ready' && lyrics.lines.length) {
    return <div className="ytm-lyrics" aria-live="polite">{lyrics.lines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}</div>
  }
  const unavailable = lyrics?.status === 'unavailable'
  return <div className="ytm-info-body"><ListMusic /><div><b>{unavailable ? 'Bu parçada şarkı sözü bulunamadı' : 'Şarkı sözleri PC’den alınıyor'}</b><p>{unavailable ? 'YouTube Music bazı parçalar için söz sağlamıyor.' : 'YouTube Music’in şarkı sözleri sekmesi açılıyor…'}</p></div></div>
})

const QueueRow = memo(function QueueRow({ track, current, onSelect }: { track: Track; current: boolean; onSelect: () => void }) {
  return (
    <button className={`ytm-queue-row ${current ? 'is-current' : ''}`} onClick={onSelect}>
      <span className="ytm-queue-indicator">{current ? <><i /><i /><i /></> : <ListMusic />}</span>
      <Cover index={track.cover} thumbnailUrl={track.thumbnailUrl} className="ytm-queue-cover" label="" />
      <span className="ytm-queue-copy">
        <b>{track.title}</b>
        <small>{track.artist}{track.collection && track.collection !== 'YouTube Music' ? ` • ${track.collection}` : ''}</small>
      </span>
      <span className="ytm-queue-duration">{track.duration > 0 ? formatTime(track.duration) : '—'}</span>
      <MoreVertical className="ytm-queue-more" />
    </button>
  )
})

const BrowseItem = memo(function BrowseItem({ item, layout, onOpen }: { item: MusicBrowseItem; layout: MusicBrowseSection['layout']; onOpen: () => void }) {
  if (layout === 'list') {
    return (
      <button className="mobile-music-row" onClick={onOpen}>
        <span className={`mobile-music-art ${item.kind === 'artist' ? 'is-round' : ''}`} style={item.thumbnailUrl ? { backgroundImage: `url(${item.thumbnailUrl})` } : undefined} />
        <span className="mobile-music-copy"><b>{item.title}</b><small>{item.subtitle || 'YouTube Music'}</small></span>
        <MoreVertical />
      </button>
    )
  }
  return (
    <button className="mobile-music-card" onClick={onOpen}>
      <span className={`mobile-music-art ${item.kind === 'artist' ? 'is-round' : ''}`} style={item.thumbnailUrl ? { backgroundImage: `url(${item.thumbnailUrl})` } : undefined}>
        {item.videoId ? <i className="mobile-card-play"><Play fill="currentColor" /></i> : null}
      </span>
      <b>{item.title}</b>
      <small>{item.subtitle || 'YouTube Music'}</small>
    </button>
  )
})

function BrowseSectionView({ section, onOpen }: { section: MusicBrowseSection; onOpen: (item: MusicBrowseItem) => void }) {
  return (
    <section className={`mobile-music-section is-${section.layout}`}>
      <div className="mobile-section-title"><h2>{section.title}</h2><ChevronDown /></div>
      <div className={section.layout === 'rail' ? 'mobile-music-rail' : 'mobile-music-list'}>
        {section.items.map((item) => <BrowseItem key={item.id} item={item} layout={section.layout} onOpen={() => onOpen(item)} />)}
      </div>
    </section>
  )
}

const BrowseFilters = memo(function BrowseFilters({ filters, onOpen }: { filters: MusicBrowseFilter[]; onOpen: (filter: MusicBrowseFilter) => void }) {
  if (!filters.length) return null
  return <div className="mobile-filter-rail">{filters.map((filter) => <button key={filter.id} className={filter.selected ? 'is-selected' : ''} onClick={() => onOpen(filter)}>{filter.label}</button>)}</div>
})

const DetailHeader = memo(function DetailHeader({ header, onOpen }: { header: MusicBrowseHeader; onOpen: (href: string, label: string) => void }) {
  return (
    <section className={`mobile-detail-hero is-${header.kind}`}>
      <div className="mobile-detail-backdrop" style={header.thumbnailUrl ? { backgroundImage: `url(${header.thumbnailUrl})` } : undefined} />
      <div className={`mobile-detail-art ${header.kind === 'artist' || header.kind === 'profile' ? 'is-round' : ''}`} style={header.thumbnailUrl ? { backgroundImage: `url(${header.thumbnailUrl})` } : undefined} />
      <div className="mobile-detail-copy">
        <span>{header.kind === 'artist' ? 'SANATÇI' : header.kind === 'album' ? 'ALBÜM' : header.kind === 'playlist' ? 'OYNATMA LİSTESİ' : 'YOUTUBE MUSIC'}</span>
        <h1>{header.title}</h1>
        {header.subtitle ? <p>{header.subtitle}</p> : null}
        {header.description ? <small>{header.description}</small> : null}
      </div>
      <div className="mobile-detail-actions">
        {header.playHref ? <button className="is-primary" onClick={() => onOpen(header.playHref || '', 'Karıştır')}><Play fill="currentColor" />Karıştır</button> : null}
        {header.radioHref ? <button onClick={() => onOpen(header.radioHref || '', 'Mix')}><ListMusic />Mix</button> : null}
      </div>
    </section>
  )
})

export function MobileApp({ state, actions, connected, peerCount, room, pairingError = '' }: Props) {
  const track = getTrack(state)
  const liked = state.liked.includes(track.id)
  const idle = track.id === 'ytmusic:idle'
  const browse = state.browse
  const currentRoute: BrowseRoute = browse?.route === 'explore' || browse?.route === 'library' || browse?.route === 'search' || browse?.route === 'detail' ? browse.route : 'home'
  const [requestedRoute, setRequestedRoute] = useState<BrowseRoute>(currentRoute)
  const [playerOpen, setPlayerOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<InfoTab>('queue')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [requestedSearchQuery, setRequestedSearchQuery] = useState('')
  const [navigationRetries, setNavigationRetries] = useState(0)
  const [navigationError, setNavigationError] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const mobileUpdate = useMobileUpdate()
  const [pairedComputer] = useState(readMobilePairing)
  const queue = useMemo(() => {
    const result: Track[] = []
    const seenIds = new Set<string>()
    const seenTracks = new Set<string>()
    for (const id of state.queue) {
      const item = state.catalog[id]
      if (!item) continue
      const videoKey = item.youtubeVideoId || id
      const trackKey = queueTrackKey(item)
      const previous = result[result.length - 1]
      if (seenIds.has(videoKey) || seenTracks.has(trackKey) || (previous && queueTitleKey(previous) === queueTitleKey(item))) continue
      seenIds.add(videoKey)
      seenTracks.add(trackKey)
      result.push(item)
    }
    return result
  }, [state.catalog, state.queue])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2200)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (browse?.route === 'home' || browse?.route === 'explore' || browse?.route === 'library' || browse?.route === 'search' || browse?.route === 'detail') {
      setRequestedRoute(browse.route)
      if (browse.route === 'search') {
        try { setSearchQuery(new URL(browse.url).searchParams.get('q') || '') } catch {}
      }
    }
  }, [browse?.route, browse?.url])

  const currentSearchQuery = currentRoute === 'search' ? queryFromBrowseUrl(browse?.url) : ''
  const showingRequestedPage = requestedRoute === currentRoute
    && (requestedRoute !== 'search' || !requestedSearchQuery || currentSearchQuery.toLocaleLowerCase('tr') === requestedSearchQuery.toLocaleLowerCase('tr'))

  useEffect(() => {
    if (showingRequestedPage) {
      setNavigationError(false)
      setNavigationRetries(0)
      return
    }
    if (!connected) return
    const timer = window.setTimeout(() => {
      if (navigationRetries < 2) {
        actions.navigateMusic(requestedRoute === 'detail' ? 'home' : requestedRoute, requestedRoute === 'search' ? requestedSearchQuery : undefined)
        setNavigationRetries((current) => current + 1)
      } else {
        setNavigationError(true)
      }
    }, 3200)
    return () => window.clearTimeout(timer)
  }, [actions, connected, navigationRetries, requestedRoute, requestedSearchQuery, showingRequestedPage])

  const navigate = (destination: 'home' | 'explore' | 'library') => {
    setRequestedRoute(destination)
    setRequestedSearchQuery('')
    setNavigationRetries(0)
    setNavigationError(false)
    setPlayerOpen(false)
    actions.navigateMusic(destination)
  }

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    const query = searchQuery.trim()
    if (!query) return
    setRequestedRoute('search')
    setRequestedSearchQuery(query)
    setNavigationRetries(0)
    setNavigationError(false)
    setSearchOpen(false)
    actions.navigateMusic('search', query)
  }

  const retryNavigation = () => {
    setNavigationRetries(0)
    setNavigationError(false)
    actions.navigateMusic(requestedRoute === 'detail' ? 'home' : requestedRoute, requestedRoute === 'search' ? requestedSearchQuery : undefined)
  }

  const selectInfoTab = (tab: InfoTab) => {
    setActiveTab(tab)
    if (tab === 'lyrics' && (state.lyrics?.trackId !== track.id || state.lyrics?.status !== 'ready')) actions.requestLyrics()
  }

  const openItem = (item: MusicBrowseItem) => {
    actions.openMusicItem(item)
    if (item.videoId) {
      setNotice(`${item.title} PC’de açılıyor`)
      window.setTimeout(() => setPlayerOpen(true), 500)
    } else {
      setNotice(`${item.title} yükleniyor`)
    }
  }

  const openDetailAction = (href: string, label: string) => {
    actions.openMusicItem({ id: `detail:${label}:${href}`, title: label, subtitle: '', href, kind: 'unknown' })
    setNotice(`${label} PC’de açılıyor`)
  }

  const handleMobileUpdate = async () => {
    const message = mobileUpdate.updateAvailable ? await mobileUpdate.openUpdate() : await mobileUpdate.check()
    setNotice(message)
  }

  if (playerOpen) {
    return (
      <div className="ytm-mobile-shell is-player-open">
        <header className="ytm-mobile-header player-header">
          <button className="ytm-icon-button" onClick={() => setPlayerOpen(false)} aria-label="Geri"><ChevronLeft /></button>
          <div className="ytm-playing-from"><span>PC’DE ÇALIYOR</span><b>Ritim • {connected ? 'Bağlı' : 'Bağlanıyor'}</b></div>
          <button className="ytm-icon-button" onClick={() => setFeedbackOpen(true)} aria-label="Hata bildir"><Bug /></button>
        </header>
        <main className="ytm-player-screen">
          <div className="ytm-art-frame">
            <Cover index={track.cover} thumbnailUrl={track.thumbnailUrl} className="ytm-player-art" label={`${track.title} kapak görseli`} />
            {idle ? <div className="ytm-idle-art"><MonitorSpeaker /><span>PC’den bir şarkı aç</span></div> : null}
          </div>
          <section className="ytm-track-meta" aria-live="polite">
            <div><h1>{track.title}</h1><p>{track.artist}{track.collection && track.collection !== 'YouTube Music' ? ` • ${track.collection}` : ''}</p></div>
            <button className={`ytm-icon-button ytm-like ${liked ? 'is-liked' : ''}`} onClick={actions.toggleLike} aria-label="Favori"><Heart fill={liked ? 'currentColor' : 'none'} /></button>
          </section>
          <button className="ytm-output-device" onClick={() => setNotice('Ses PC’den geliyor')}>
            <MonitorSpeaker /><span><small>ŞU CİHAZDA OYNATILIYOR</small><b>Ritim PC</b></span><i className={connected ? 'is-online' : ''} />
          </button>
          <Progress position={state.position} duration={track.duration} onSeek={actions.seek} />
          <PlayerControls state={state} actions={actions} large />
          <div className="ytm-volume-control"><Volume1 /><input className="range range--volume" type="range" min="0" max="100" value={state.volume} style={{ '--range-value': `${state.volume}%` } as React.CSSProperties} onChange={(event) => actions.setVolume(Number(event.target.value))} aria-label="PC sesi" /><Volume2 /></div>
          <section className="ytm-info-sheet">
            <div className="ytm-info-tabs" role="tablist"><button className={activeTab === 'queue' ? 'is-active' : ''} onClick={() => selectInfoTab('queue')}>SIRADAKİ</button><button className={activeTab === 'lyrics' ? 'is-active' : ''} onClick={() => selectInfoTab('lyrics')}>ŞARKI SÖZLERİ</button><button className={activeTab === 'related' ? 'is-active' : ''} onClick={() => selectInfoTab('related')}>BENZER</button></div>
            {activeTab === 'queue' ? <div className="ytm-queue-list">{queue.slice(0, 12).map((item) => <QueueRow key={item.id} track={item} current={item.id === state.trackId} onSelect={() => actions.selectTrack(item.id)} />)}</div> : activeTab === 'lyrics' ? <LyricsPanel lyrics={state.lyrics?.trackId === track.id ? state.lyrics : undefined} /> : <div className="ytm-info-body"><ListMusic /><div><b>Benzer parçalar hazırlanıyor</b><p>Bu bölüm PC’deki YouTube Music verisiyle güncellenecek.</p></div></div>}
          </section>
        </main>
        <FeedbackSheet open={feedbackOpen} onClose={() => setFeedbackOpen(false)} connected={connected} peerCount={peerCount} room={room} pairingError={pairingError} trackTitle={track.title} trackId={track.id} />
        {notice ? <div className="ytm-toast" role="status">{notice}</div> : null}
      </div>
    )
  }

  return (
    <div className="ytm-mobile-shell is-browser-open">
      <header className="mobile-browse-header">
        <div className="mobile-brand"><i><Play fill="currentColor" /></i><span>Ritim</span></div>
        <div className="mobile-header-actions">
          <button onClick={() => setSearchOpen(true)} aria-label="Ara"><Search /></button>
          <button onClick={() => setFeedbackOpen(true)} aria-label="Hata bildir"><Bug /></button>
          {isNativeMobile ? <button className={mobileUpdate.updateAvailable ? 'has-update' : ''} onClick={() => void handleMobileUpdate()} aria-label="Güncellemeleri kontrol et">{mobileUpdate.updateAvailable ? <Download /> : <RefreshCw />}</button> : null}
          <button className="mobile-device-button" onClick={() => setNotice(connected ? `Ritim PC bağlı • ${peerCount} cihaz` : 'PC bağlantısı bekleniyor')} aria-label="PC bağlantısı"><MonitorSpeaker /><i className={connected ? 'is-online' : ''} /></button>
        </div>
      </header>

      <main className="mobile-browse-content">
        {requestedRoute === 'detail' ? (
          <button className="mobile-detail-back" onClick={actions.goBackMusic}><ChevronLeft />Geri</button>
        ) : (
          <div className="mobile-page-heading"><h1>{requestedRoute === 'search' ? browse?.title || 'Arama' : routeLabels[requestedRoute]}</h1>{connected ? <span>Ritim PC</span> : <span className="is-offline">Çevrimdışı</span>}</div>
        )}
        {showingRequestedPage && requestedRoute === 'detail' && browse?.header ? <DetailHeader header={browse.header} onOpen={openDetailAction} /> : null}
        {showingRequestedPage && (requestedRoute === 'search' || requestedRoute === 'library') ? <BrowseFilters filters={browse?.filters || []} onOpen={actions.openMusicFilter} /> : null}
        {!showingRequestedPage ? (
          <div className={`mobile-loading ${navigationError ? 'has-error' : ''}`}><i /><i /><i /><p>{navigationError ? `${routeLabels[requestedRoute]} yüklenemedi.` : `${routeLabels[requestedRoute]} PC’den yükleniyor…`}</p>{navigationError ? <button onClick={retryNavigation}>Tekrar dene</button> : null}</div>
        ) : browse?.sections.length ? (
          browse.sections.map((section) => <BrowseSectionView key={section.id} section={section} onOpen={openItem} />)
        ) : requestedRoute === 'detail' && browse?.header ? null : (
          <div className="mobile-empty-state"><MonitorSpeaker /><h2>PC’den içerik bekleniyor</h2><p>Ritim’de YouTube Music ana sayfası açıldığında kişisel önerilerin burada görünecek.</p></div>
        )}
      </main>

      {!idle ? (
        <div className="mobile-mini-player">
          <button className="mobile-mini-open" onClick={() => setPlayerOpen(true)} aria-label="Tam oynatıcıyı aç">
            <Cover index={track.cover} thumbnailUrl={track.thumbnailUrl} className="mobile-mini-cover" label="" />
            <span><b>{track.title}</b><small>{track.artist} • Ritim PC</small></span>
          </button>
          <button onClick={actions.togglePlay} aria-label={state.isPlaying ? 'Duraklat' : 'Oynat'}>{state.isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button>
          <button onClick={actions.next} aria-label="Sıradaki"><SkipForward fill="currentColor" /></button>
        </div>
      ) : null}

      <nav className="ytm-bottom-nav mobile-main-nav" aria-label="Ritim gezinme">
        <button className={requestedRoute === 'home' ? 'is-active' : ''} onClick={() => navigate('home')}><Home fill={requestedRoute === 'home' ? 'currentColor' : 'none'} /><span>Ana Sayfa</span></button>
        <button className={requestedRoute === 'explore' ? 'is-active' : ''} onClick={() => navigate('explore')}><Compass /><span>Keşfet</span></button>
        <button className={requestedRoute === 'search' ? 'is-active' : ''} onClick={() => setSearchOpen(true)}><Search /><span>Ara</span></button>
        <button className={requestedRoute === 'library' ? 'is-active' : ''} onClick={() => navigate('library')}><Library fill={requestedRoute === 'library' ? 'currentColor' : 'none'} /><span>Kitaplık</span></button>
      </nav>

      {searchOpen ? <div className="ytm-search-overlay"><form onSubmit={submitSearch}><button type="button" className="ytm-icon-button" onClick={() => setSearchOpen(false)} aria-label="Aramayı kapat"><X /></button><Search /><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Şarkı, albüm veya sanatçı ara" /><button type="submit">ARA</button></form><p>Sonuçlar kendi YouTube Music hesabından Ritim PC aracılığıyla gelir.</p></div> : null}
      <FeedbackSheet open={feedbackOpen} onClose={() => setFeedbackOpen(false)} connected={connected} peerCount={peerCount} room={room} pairingError={pairingError} trackTitle={track.title} trackId={track.id} />
      {!connected || pairingError ? (
        <div className="ytm-offline-banner">
          <i />
          <span>{pairingError || 'PC bağlantısı bekleniyor'}{pairedComputer ? <small>{pairedComputer.syncUrl.replace(/^https?:\/\//, '')}</small> : null}</span>
          {isNativeMobile ? <button onClick={() => { clearMobilePairing(); window.location.reload() }}>QR’ı yenile</button> : null}
        </div>
      ) : null}
      {notice ? <div className="ytm-toast" role="status">{notice}</div> : null}
    </div>
  )
}
