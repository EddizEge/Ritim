const DiscordRPC = require('discord-rpc')

function createDiscordPresence(clientId) {
  if (!clientId) {
    console.log('[Ritim] Discord Rich Presence kapali: RITIM_DISCORD_CLIENT_ID ayarlanmamis.')
    return { update() {}, destroy() {} }
  }

  const rpc = new DiscordRPC.Client({ transport: 'ipc' })
  let ready = false
  let lastKey = ''
  let pending = null

  rpc.on('ready', () => {
    ready = true
    if (pending) update(pending)
  })
  rpc.login({ clientId }).catch((error) => console.warn('[Ritim] Discord baglantisi kurulamadi:', error.message))

  function update(payload) {
    pending = payload
    if (!ready) return
    const key = `${payload.title}|${payload.artist}|${payload.isPlaying}`
    if (key === lastKey) return
    lastKey = key
    rpc.setActivity({
      type: 2,
      details: payload.title,
      state: `${payload.artist} • ${payload.isPlaying ? 'Dinliyor' : 'Duraklatıldı'}`,
      startTimestamp: payload.isPlaying && payload.startedAt ? new Date(payload.startedAt) : undefined,
      instance: false,
    }).catch(() => {})
  }

  return {
    update,
    destroy() {
      try { rpc.destroy() } catch { /* Discord zaten kapali olabilir. */ }
    },
  }
}

module.exports = { createDiscordPresence }
