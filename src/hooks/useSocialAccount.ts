import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getSocialAccount,
  resumeSocialAccount,
  revokeSocialDevice,
  signOutSocialAccount,
  type SocialAuthOptions,
} from '../social/auth'
import type { SocialAccountSummary } from '../social/types'

export type SocialAccountState = SocialAccountSummary & {
  status: 'loading' | 'ready' | 'offline' | 'error'
  error?: string
}

const emptyAccount: SocialAccountSummary = {
  authenticated: false,
  currentDeviceId: '',
  devices: [],
}

export function useSocialAccount(options: SocialAuthOptions) {
  const stableOptions = useMemo(() => options, [
    options.isCompanion,
    options.pairingToken,
    options.socialUrl,
    options.syncUrl,
  ])
  const [state, setState] = useState<SocialAccountState>({ ...emptyAccount, status: 'loading' })

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading', error: undefined }))
    try {
      const account = await getSocialAccount(stableOptions)
      setState({ ...account, status: 'ready' })
      return account
    } catch (error) {
      setState((current) => ({
        ...current,
        status: navigator.onLine ? 'error' : 'offline',
        error: error instanceof Error ? error.message : 'Hesap bilgileri alınamadı.',
      }))
      return null
    }
  }, [stableOptions])

  useEffect(() => { void refresh() }, [refresh])

  const revokeDevice = useCallback(async (deviceId: string) => {
    await revokeSocialDevice(stableOptions, deviceId)
    await refresh()
  }, [refresh, stableOptions])

  const signOut = useCallback(async () => {
    await signOutSocialAccount(stableOptions)
    setState({ ...emptyAccount, status: 'ready' })
  }, [stableOptions])

  const reconnect = useCallback(async () => {
    setState({ ...emptyAccount, status: 'loading' })
    await resumeSocialAccount(stableOptions)
    await refresh()
  }, [refresh, stableOptions])

  return { state, actions: { refresh, revokeDevice, signOut, reconnect } }
}
