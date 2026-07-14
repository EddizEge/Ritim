export type RepeatMode = 'off' | 'all' | 'one'

export type Track = {
  id: string
  title: string
  artist: string
  collection: string
  duration: number
  cover: number
  thumbnailUrl?: string
  youtubeVideoId?: string
  source: 'demo' | 'youtube' | 'ytmusic'
}

export type YouTubePlaylist = {
  id: string
  title: string
  itemCount: number
  thumbnailUrl?: string
}

export type YouTubeStatus = {
  available: boolean
  configured: boolean
  authenticated: boolean
  channelTitle?: string
}

export type MusicBrowseItem = {
  id: string
  title: string
  subtitle: string
  thumbnailUrl?: string
  href?: string
  videoId?: string
  kind: 'song' | 'video' | 'album' | 'artist' | 'profile' | 'playlist' | 'mix' | 'podcast' | 'episode' | 'unknown'
}

export type MusicBrowseFilter = {
  id: string
  label: string
  href: string
  selected: boolean
}

export type MusicBrowseHeader = {
  title: string
  subtitle: string
  description: string
  thumbnailUrl?: string
  kind: MusicBrowseItem['kind']
  playHref?: string
  radioHref?: string
}

export type MusicBrowseSection = {
  id: string
  title: string
  layout: 'rail' | 'list'
  items: MusicBrowseItem[]
}

export type MusicBrowseState = {
  route: 'home' | 'explore' | 'library' | 'search' | 'detail'
  title: string
  url: string
  filters: MusicBrowseFilter[]
  header?: MusicBrowseHeader
  sections: MusicBrowseSection[]
  updatedAt: number
}

export type PlayerState = {
  trackId: string
  isPlaying: boolean
  position: number
  volume: number
  shuffle: boolean
  repeat: RepeatMode
  liked: string[]
  queue: string[]
  catalog: Record<string, Track>
  browse?: MusicBrowseState
  updatedAt: number
}

export type PlayerActions = {
  togglePlay: () => void
  next: () => void
  previous: () => void
  selectTrack: (trackId: string) => void
  seek: (position: number) => void
  setVolume: (volume: number) => void
  navigateMusic: (destination: 'home' | 'explore' | 'library' | 'search', query?: string) => void
  openMusicItem: (item: MusicBrowseItem) => void
  openMusicFilter: (filter: MusicBrowseFilter) => void
  goBackMusic: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  toggleLike: () => void
  replaceQueue: (tracks: Track[], startTrackId?: string) => void
  syncFromMedia: (patch: Partial<Pick<PlayerState, 'isPlaying' | 'position'>>) => void
}
