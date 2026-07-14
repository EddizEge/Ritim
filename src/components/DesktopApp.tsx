import { useEffect, useState, type FormEvent } from 'react'
import {
  Bell, ChevronLeft, ChevronRight, CircleUserRound, Compass, ExternalLink, Heart, Home,
  Library, ListMusic, LoaderCircle, LogOut, MessageSquareText, MonitorSmartphone, Music2,
  MoreVertical, Plus, Search, Volume2, X,
} from 'lucide-react'
import { formatTime, getTrack, playlists as demoPlaylists, tracks as demoTracks } from '../data'
import type { YouTubeLibraryController } from '../hooks/useYouTubeLibrary'
import type { PlayerActions, PlayerState, Track, YouTubePlaylist } from '../types'
import { Cover } from './Cover'
import { PlayerControls } from './PlayerControls'
import { Progress } from './Progress'
import { YouTubePlayer } from './YouTubePlayer'
import { YouTubeMark } from './YouTubeMark'

type Props = {
  state: PlayerState
  actions: PlayerActions
  connected: boolean
  peerCount: number
  room: string
  youtube: YouTubeLibraryController
}

type DesktopView = 'home' | 'music'

function Sidebar({ connected, peerCount, youtube, activeView, onViewChange }: Pick<Props, 'connected' | 'peerCount' | 'youtube'> & { activeView: DesktopView; onViewChange: (view: DesktopView) => void }) {
  const livePlaylists = youtube.status.authenticated ? youtube.playlists : []
  return (
    <aside className="sidebar">
      <div className="wordmark"><span>R</span>Ritim</div>
      <nav className="primary-nav" aria-label="Ana menü">
        <button className={`nav-item ${activeView === 'home' ? 'is-selected' : ''}`} onClick={() => onViewChange('home')}><Home fill={activeView === 'home' ? 'currentColor' : 'none'} />Ritim Ana Sayfa</button>
        <button className={`nav-item music-nav-item ${activeView === 'music' ? 'is-selected' : ''}`} onClick={() => onViewChange('music')}><Music2 />YouTube Music</button>
        <button className="nav-item"><Compass />Keşfet</button>
        <button className="nav-item"><Library />Kitaplık</button>
      </nav>
      <div className="sidebar-heading"><span>{livePlaylists.length ? 'YouTube listelerim' : 'Çalma listelerim'}</span><Plus /></div>
      <div className="playlist-list">
        {livePlaylists.length ? livePlaylists.map((playlist, index) => (
          <button className="playlist-item" key={playlist.id} onClick={() => youtube.loadPlaylist(playlist)}>
            <Cover index={index % 6} thumbnailUrl={playlist.thumbnailUrl} label={playlist.title} />
            <span><b>{playlist.title}</b><small>{playlist.itemCount ? `${playlist.itemCount} video` : 'YouTube'}</small></span>
          </button>
        )) : demoPlaylists.map(([name, count, cover]) => (
          <button className="playlist-item" key={name}>
            <Cover index={cover} label={name} />
            <span><b>{name}</b><small>{count}</small></span>
          </button>
        ))}
      </div>
      <div className="device-chip">
        <MonitorSmartphone />
        <span>{connected ? (peerCount > 1 ? 'Telefon bağlı' : 'Bağlantı hazır') : 'Çevrimdışı'}</span>
        <i className={connected ? 'online' : ''} />
      </div>
    </aside>
  )
}

function AlbumRail({ title, items, state, actions }: { title: string; items: Track[]; state: PlayerState; actions: PlayerActions }) {
  return (
    <section className="rail-section">
      <div className="section-heading"><h2>{title}</h2><button>Tümünü gör <ChevronRight /></button></div>
      {items.length ? (
        <div className="album-rail">
          {items.slice(0, 5).map((track) => (
            <button className={`album-card ${state.trackId === track.id ? 'is-playing' : ''}`} key={track.id} onClick={() => actions.replaceQueue(items, track.id)}>
              <div className="album-art-wrap"><Cover index={track.cover} thumbnailUrl={track.thumbnailUrl} label={`${track.title} kapak görseli`} /><span className="card-play">▶</span></div>
              <b>{track.title}</b>
              <small>{track.artist}</small>
            </button>
          ))}
        </div>
      ) : <div className="empty-rail">Bu bölümde oynatılabilir video bulunamadı.</div>}
    </section>
  )
}

function Queue({ state, actions }: Pick<Props, 'state' | 'actions'>) {
  return (
    <section className="queue-panel">
      <div className="queue-heading"><h3>Sıradaki <span>{state.queue.length} parça</span></h3><button>Temizle</button><MoreVertical /></div>
      <div className="queue-rows">
        {state.queue.slice(0, 4).map((id, index) => {
          const track = getTrack(state, id)
          return (
            <button className={state.trackId === id ? 'queue-row is-current' : 'queue-row'} key={id} onClick={() => actions.selectTrack(id)}>
              <span className="queue-number">{index + 1}</span>
              <Cover index={track.cover} thumbnailUrl={track.thumbnailUrl} label="" />
              <b>{track.title}<small>{track.artist}</small></b>
              <span>{track.collection}</span>
              <span>{formatTime(track.duration)}</span>
              <ListMusic />
            </button>
          )
        })}
      </div>
    </section>
  )
}

function BottomPlayer({ state, actions, connected, room }: Omit<Props, 'peerCount' | 'youtube'>) {
  const track = getTrack(state)
  const liked = state.liked.includes(track.id)
  const isMusicTrack = track.source === 'ytmusic'
  return (
    <footer className="bottom-player">
      <div className="now-playing-mini">
        <Cover index={track.cover} thumbnailUrl={track.thumbnailUrl} label={track.title} />
        <span><b>{track.title}</b><small>{track.artist}</small></span>
        <button className={liked ? 'is-liked' : ''} onClick={actions.toggleLike}><Heart fill={liked ? 'currentColor' : 'none'} /></button>
      </div>
      <div className="transport">
        <PlayerControls state={state} actions={actions} />
        <Progress position={state.position} duration={track.duration} onSeek={actions.seek} compact />
      </div>
      <div className="player-utilities">
        <div className="sync-pill"><MonitorSmartphone /><span>{connected ? room : 'Yerel mod'}</span><i className={connected ? 'online' : ''} /></div>
        <Volume2 />
        <input className="range range--volume" type="range" min="0" max="100" value={state.volume} disabled={isMusicTrack} style={{ '--range-value': `${state.volume}%` } as React.CSSProperties} onChange={(event) => actions.setVolume(Number(event.target.value))} aria-label={isMusicTrack ? 'Sesi YouTube Music görünümünden ayarla' : 'Ses'} />
        <MessageSquareText />
        <ListMusic />
      </div>
    </footer>
  )
}

function MusicConnectPanel({ onOpenMusic }: { onOpenMusic: () => void }) {
  return (
    <section className="youtube-connect-panel music-connect-panel">
      <div className="youtube-mark"><Music2 /></div>
      <div>
        <h1>Kendi YouTube Music ana sayfan Ritim’in içinde</h1>
        <p>Resmî Music görünümünü aç; kişisel önerilerin, geçmişin, listelerin ve kitaplığın Google hesabındaki haliyle gelsin. Çalan parça eski Ritim oynatıcısıyla ve telefonla eşleşir.</p>
      </div>
      <button className="youtube-primary" onClick={onOpenMusic}><Music2 />YouTube Music’i aç</button>
    </section>
  )
}

function YouTubeConnectPanel({ youtube }: { youtube: YouTubeLibraryController }) {
  const desktopOnly = !youtube.status.available
  return (
    <section className="youtube-connect-panel">
      <div className="youtube-mark"><YouTubeMark /></div>
      <div>
        <h1>{desktopOnly ? 'YouTube bağlantısı masaüstünde çalışır' : 'YouTube hesabını Ritim’e bağla'}</h1>
        <p>{desktopOnly ? 'Google oturumu ve gerçek oynatma için uygulamayı Electron masaüstü kabuğunda aç.' : 'Çalma listelerini, beğendiğin videoları ve aramayı getir; telefondan aynı oynatıcıyı kontrol et.'}</p>
        {youtube.error ? <div className="youtube-inline-error">{youtube.error}</div> : null}
      </div>
      <button className="youtube-primary" disabled={desktopOnly || youtube.loading} onClick={youtube.connect}>
        {youtube.loading ? <LoaderCircle className="spin" /> : <YouTubeMark />}
        {youtube.status.configured ? 'Google ile bağlan' : 'Kurulumu başlat'}
      </button>
    </section>
  )
}

function YouTubeSetupDialog({ youtube }: { youtube: YouTubeLibraryController }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void youtube.configureAndConnect({ clientId, clientSecret }).catch(() => {})
  }
  if (!youtube.setupOpen) return null
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="youtube-dialog" role="dialog" aria-modal="true" aria-labelledby="youtube-setup-title">
        <button className="dialog-close" onClick={() => youtube.setSetupOpen(false)} aria-label="Kapat"><X /></button>
        <YouTubeMark className="dialog-youtube" />
        <h2 id="youtube-setup-title">Google OAuth kurulumu</h2>
        <ol>
          <li>Google Cloud’da YouTube Data API v3’ü etkinleştir.</li>
          <li>“Masaüstü uygulaması” türünde OAuth istemcisi oluştur.</li>
          <li>İstemci kimliği ve gizli anahtarı aşağıya yapıştır.</li>
        </ol>
        <button className="cloud-link" type="button" onClick={youtube.openConsole}><ExternalLink />Google Cloud kimlik bilgilerini aç</button>
        <form onSubmit={submit}>
          <label>İstemci kimliği<input required value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="…apps.googleusercontent.com" /></label>
          <label>İstemci gizli anahtarı<input value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder="GOCSPX-…" /></label>
          {youtube.error ? <div className="youtube-inline-error">{youtube.error}</div> : null}
          <button className="youtube-primary" disabled={youtube.loading}>{youtube.loading ? <LoaderCircle className="spin" /> : <YouTubeMark />}Kaydet ve Google’a bağlan</button>
        </form>
        <p className="security-note">Bilgiler ve Google token’ları Windows’un güvenli depolamasıyla şifrelenir; telefona gönderilmez.</p>
      </section>
    </div>
  )
}

function ConnectedStrip({ youtube }: { youtube: YouTubeLibraryController }) {
  return (
    <div className="youtube-connected-strip">
      <YouTubeMark />
      <span><b>{youtube.status.channelTitle || 'YouTube hesabı'}</b><small>Bağlı • resmî API</small></span>
      {youtube.loading ? <LoaderCircle className="spin" /> : null}
      {youtube.error ? <em>{youtube.error}</em> : null}
      <button onClick={youtube.disconnect}><LogOut />Bağlantıyı kes</button>
    </div>
  )
}

export function DesktopApp(props: Props) {
  const [query, setQuery] = useState('')
  const [activeView, setActiveView] = useState<DesktopView>('home')
  const currentTrack = getTrack(props.state)
  const liveItems = props.youtube.status.authenticated ? props.youtube.tracks : demoTracks
  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    if (query.trim()) void props.youtube.search(query)
  }

  useEffect(() => {
    void window.ritimDesktop?.music.setVisible(activeView === 'music')
    return () => { void window.ritimDesktop?.music.setVisible(false) }
  }, [activeView])

  return (
    <div className="desktop-shell">
      <Sidebar connected={props.connected} peerCount={props.peerCount} youtube={props.youtube} activeView={activeView} onViewChange={setActiveView} />
      <main className="desktop-content">
        <header className="topbar">
          <div className="history-buttons"><button><ChevronLeft /></button><button><ChevronRight /></button></div>
          <form className="search-box" onSubmit={submitSearch}><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} disabled={!props.youtube.status.authenticated} placeholder={props.youtube.status.authenticated ? 'YouTube’da şarkı, sanatçı veya albüm ara' : 'YouTube’u bağladıktan sonra ara'} /></form>
          <div className="topbar-actions"><button><Bell /></button><button title={props.youtube.status.channelTitle || 'Hesap'}><CircleUserRound /></button></div>
        </header>
        <div className="content-scroll">
          {activeView === 'music' ? (
            <section className="music-host-placeholder" aria-label="YouTube Music görünümü">
              <Music2 />
              <h1>YouTube Music yükleniyor</h1>
              <p>Masaüstü uygulamasında kişisel Music ana sayfan bu alanda açılır.</p>
            </section>
          ) : (
            <>
              <MusicConnectPanel onOpenMusic={() => setActiveView('music')} />
              {props.youtube.status.authenticated ? <ConnectedStrip youtube={props.youtube} /> : null}
              <AlbumRail title={props.youtube.status.authenticated ? props.youtube.sectionTitle : 'Sana özel'} items={liveItems} state={props.state} actions={props.actions} />
              <AlbumRail title={props.youtube.status.authenticated ? 'Sıradaki keşifler' : 'Son çalınanlar'} items={liveItems.length > 3 ? [...liveItems.slice(3), ...liveItems.slice(0, 3)] : liveItems} state={props.state} actions={props.actions} />
              <div className={currentTrack.source === 'youtube' ? 'lower-media-row' : ''}>
                <Queue state={props.state} actions={props.actions} />
                {currentTrack.source === 'youtube' ? <YouTubePlayer track={currentTrack} state={props.state} actions={props.actions} /> : null}
              </div>
            </>
          )}
        </div>
      </main>
      <BottomPlayer state={props.state} actions={props.actions} connected={props.connected} room={props.room} />
    </div>
  )
}
