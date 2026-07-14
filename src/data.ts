import type { PlayerState, Track } from './types'

export const tracks: Track[] = [
  { id: 'geceye-donus', title: 'Geceye Dönüş', artist: 'Mavi Atlas', collection: 'Geceye Dal', duration: 236, cover: 0, source: 'demo' },
  { id: 'sehir-isiklari', title: 'Şehir Işıkları', artist: 'Eva Durak', collection: 'Kırmızı Çizgiler', duration: 228, cover: 1, source: 'demo' },
  { id: 'lofi-zamani', title: 'Lo-Fi Zamanı', artist: 'Pusula', collection: 'Sonsuz', duration: 261, cover: 2, source: 'demo' },
  { id: 'yalniz-degilsin', title: 'Yalnız Değilsin', artist: 'Mavi Atlas', collection: 'Kıyı', duration: 216, cover: 3, source: 'demo' },
  { id: 'yeni-kesifler', title: 'Yeni Keşifler', artist: 'Kerem Duru', collection: 'Yeni Keşifler', duration: 244, cover: 4, source: 'demo' },
  { id: 'boslukta', title: 'Boşlukta', artist: 'Kerem Duru', collection: 'Yörünge', duration: 249, cover: 5, source: 'demo' },
]

export const demoCatalog = Object.fromEntries(tracks.map((track) => [track.id, track]))

export function getTrack(state: PlayerState, trackId = state.trackId) {
  return state.catalog[trackId] || demoCatalog[trackId] || tracks[0]
}

export const initialPlayerState: PlayerState = {
  trackId: tracks[0].id,
  isPlaying: false,
  position: 102,
  volume: 68,
  shuffle: false,
  repeat: 'off',
  liked: [tracks[0].id],
  queue: tracks.map((track) => track.id),
  catalog: demoCatalog,
  browse: {
    route: 'home',
    title: 'Ana Sayfa',
    url: 'https://music.youtube.com/',
    filters: [],
    sections: [],
    updatedAt: 0,
  },
  updatedAt: Date.now(),
}

export const playlists = [
  ['Gece Sürüşü', '28 şarkı', 0],
  ['Odak Modu', '41 şarkı', 3],
  ['Hafta Sonu', '35 şarkı', 2],
  ['Eskiler', '52 şarkı', 5],
  ['Favorilerim', '102 şarkı', 1],
  ['Yeni Keşifler', '67 şarkı', 4],
] as const

export function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds))
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}
