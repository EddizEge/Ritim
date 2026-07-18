import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type NativeMediaAction = 'playPause' | 'next' | 'previous'

type MediaState = {
  title: string
  artist: string
  artwork?: string
  playing: boolean
  position: number
  duration: number
}

type RitimMediaPlugin = {
  update(state: MediaState): Promise<void>
  stop(): Promise<void>
  requestNotificationPermission(): Promise<void>
  addListener(eventName: 'mediaAction', listener: (event: { action: NativeMediaAction }) => void): Promise<PluginListenerHandle>
}

export const RitimMedia = registerPlugin<RitimMediaPlugin>('RitimMedia')
