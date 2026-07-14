import type { Track, YouTubePlaylist, YouTubeStatus } from './types'

export {}

declare global {
  interface Window {
    ritimDesktop?: {
      updatePresence: (payload: { title: string; artist: string; isPlaying: boolean; startedAt?: number }) => void
      platform: string
      music: {
        setVisible: (visible: boolean) => Promise<boolean>
        command: (command: { type: string; value?: number | string }) => void
      }
      youtube: {
        status: () => Promise<YouTubeStatus>
        configure: (credentials: { clientId: string; clientSecret?: string }) => Promise<YouTubeStatus>
        signIn: () => Promise<YouTubeStatus>
        signOut: () => Promise<YouTubeStatus>
        home: () => Promise<{ playlists: YouTubePlaylist[]; tracks: Track[] }>
        playlist: (input: { playlistId: string; title: string }) => Promise<Track[]>
        search: (query: string) => Promise<Track[]>
        openConsole: () => Promise<void>
      }
    }
  }
}
