const DiscordRPC = require('discord-rpc')

function createDiscordPresence(clientId) {
  if (!clientId) {
    console.log('[Ritim] Discord Rich Presence kapali: RITIM_DISCORD_CLIENT_ID ayarlanmamis.')
    return { update() {}, destroy() {} }
  }

  let rpc = null
  let ready = false
  let destroyed = false
  let lastKey = ''
  let pending = null
  let retryTimer = null

  function scheduleReconnect() {
    if (destroyed || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, 15000)
  }

  function connect() {
    if (destroyed || rpc) return
    const client = new DiscordRPC.Client({ transport: 'ipc' })
    rpc = client
    client.once('ready', () => {
      ready = true
      lastKey = ''
      console.log('[Ritim] Discord Rich Presence baglandi.')
      if (pending) update(pending)
    })
    client.once('disconnected', () => {
      if (rpc !== client) return
      ready = false
      rpc = null
      scheduleReconnect()
    })
    client.login({ clientId }).catch((error) => {
      if (rpc !== client) return
      console.warn('[Ritim] Discord baglantisi kurulamadi:', error.message)
      ready = false
      rpc = null
      try { client.destroy() } catch {}
      scheduleReconnect()
    })
  }

  connect()

  function update(payload) {
    if (!payload || typeof payload !== 'object') return
    const title = String(payload.title || '').trim().slice(0, 128)
    const artist = String(payload.artist || '').trim().slice(0, 100)
    if (!title || title === 'YouTube Music') return
    pending = { ...payload, title, artist }
    if (!ready || !rpc) return
    const key = `${title}|${artist}|${payload.isPlaying}|${Math.floor(Number(payload.startedAt) / 10000)}`
    if (key === lastKey) return
    lastKey = key
    const activity = {
      type: 2,
      details: title,
      state: `${artist || 'YouTube Music'} • ${payload.isPlaying ? 'Dinliyor' : 'Duraklatıldı'}`,
      startTimestamp: payload.isPlaying && payload.startedAt ? new Date(payload.startedAt) : undefined,
      largeImageKey: 'ritim',
      largeImageText: 'Ritim • YouTube Music',
      instance: false,
    }
    rpc.setActivity(activity).catch((error) => {
      const fallback = { ...activity }
      delete fallback.largeImageKey
      delete fallback.largeImageText
      return rpc?.setActivity(fallback).catch(() => {
        console.warn('[Ritim] Discord etkinligi guncellenemedi:', error.message)
        lastKey = ''
      })
    })
  }

  return {
    update,
    destroy() {
      destroyed = true
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      try { rpc?.clearActivity() } catch {}
      try { rpc?.destroy() } catch { /* Discord zaten kapali olabilir. */ }
      rpc = null
      ready = false
    },
  }
}

module.exports = { createDiscordPresence }
