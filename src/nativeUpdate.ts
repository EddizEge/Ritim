import { registerPlugin } from '@capacitor/core'

export type NativeUpdateDownload = {
  status: 'idle' | 'pending' | 'downloading' | 'paused' | 'downloaded' | 'error'
  downloadedBytes: number
  totalBytes: number
  percent: number
  version?: string
  reason?: number
}

type RitimUpdatePlugin = {
  start(options: { url: string; fileName: string; version: string }): Promise<NativeUpdateDownload>
  status(): Promise<NativeUpdateDownload>
  clear(): Promise<void>
  install(): Promise<{ openedInstaller: boolean; openedSettings: boolean }>
}

const updateGlobal = globalThis as typeof globalThis & { __ritimUpdatePlugin?: RitimUpdatePlugin }
export const RitimUpdate = updateGlobal.__ritimUpdatePlugin || registerPlugin<RitimUpdatePlugin>('RitimUpdate')
updateGlobal.__ritimUpdatePlugin = RitimUpdate
