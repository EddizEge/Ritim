const crypto = require('node:crypto')

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function sanitizeTrack(track) {
  if (!track || !cleanText(track.title, 160)) return undefined
  return {
    id: cleanText(track.id, 160),
    videoId: cleanText(track.videoId, 32) || undefined,
    title: cleanText(track.title, 160),
    artist: cleanText(track.artist, 120),
    duration: Math.max(0, Number(track.duration) || 0),
    position: Math.max(0, Number(track.position) || 0),
    cover: Math.max(0, Number(track.cover) || 0),
    thumbnailUrl: cleanText(track.thumbnailUrl, 1000) || undefined,
    isPlaying: Boolean(track.isPlaying),
  }
}

function createSocialHub(io, { store } = {}) {
  const messages = []
  const reactions = new Map()
  const listening = new Map()
  const rooms = new Map()
  let emitChain = Promise.resolve()

  function socialSockets() {
    return [...io.sockets.sockets.values()].filter((socket) => socket.data.socialAccountId)
  }

  function socketsForAccount(accountId) {
    return socialSockets().filter((socket) => socket.data.socialAccountId === accountId)
  }

  function accountProfiles() {
    const accounts = new Map()
    for (const socket of socialSockets()) {
      const profile = socket.data.socialProfile
      if (!profile?.id) continue
      const current = accounts.get(profile.id)
      const desktopWins = profile.deviceRole === 'desktop' && current?.deviceRole !== 'desktop'
      if (!current || desktopWins) accounts.set(profile.id, profile)
      else if (!current.currentTrack && profile.currentTrack) {
        accounts.set(profile.id, { ...current, currentTrack: profile.currentTrack })
      }
    }
    return accounts
  }

  function publicUser(profile) {
    const reaction = reactions.get(profile.id)
    return {
      id: profile.id,
      displayName: profile.displayName,
      handle: profile.handle,
      initials: profile.initials,
      avatarUrl: profile.avatarUrl,
      avatarTone: profile.avatarTone,
      presence: 'online',
      currentTrack: profile.currentTrack,
      reactionCount: reaction?.count || 0,
      lastReaction: reaction?.lastReaction || undefined,
    }
  }

  function cleanOrphanedMemoryState(profiles) {
    for (const [listenerId, targetId] of listening.entries()) {
      if (!profiles.has(listenerId) || !profiles.has(targetId)) listening.delete(listenerId)
    }
    for (const socialRoom of rooms.values()) {
      if (!profiles.has(socialRoom.ownerId)) rooms.delete(socialRoom.id)
    }
  }

  async function emitAllStates() {
    const profiles = accountProfiles()
    const accountIds = [...profiles.keys()]
    if (!store) cleanOrphanedMemoryState(profiles)

    const [selectedMessages, selectedRooms, selectedListening] = store
      ? await Promise.all([
          store.loadMessages(accountIds),
          store.loadRooms(accountIds),
          store.loadListening(accountIds),
        ])
      : [messages, [...rooms.values()], listening]

    for (const socket of socialSockets()) {
      const accountId = socket.data.socialAccountId
      const currentProfile = profiles.get(accountId)
      if (!currentProfile) continue
      const users = [...profiles.values()]
        .filter((profile) => profile.id !== accountId)
        .map(publicUser)
      const conversations = {}
      for (const user of users) {
        conversations[user.id] = selectedMessages.filter((message) => (
          (message.senderId === accountId && message.targetId === user.id)
          || (message.senderId === user.id && message.targetId === accountId)
        )).map(({ targetId: _targetId, ...message }) => message)
      }
      const publicRooms = store
        ? selectedRooms.map((socialRoom) => ({
            id: socialRoom.id,
            title: socialRoom.title,
            memberCount: socialRoom.memberCount,
            cover: socialRoom.cover,
            isLive: true,
            memberInitials: socialRoom.memberInitials,
          }))
        : selectedRooms.map((socialRoom) => {
            const memberIds = new Set([socialRoom.ownerId])
            for (const [memberId, targetId] of selectedListening.entries()) {
              if (targetId === socialRoom.ownerId) memberIds.add(memberId)
            }
            const memberProfiles = [...memberIds].map((id) => profiles.get(id)).filter(Boolean)
            return {
              id: socialRoom.id,
              title: socialRoom.title,
              memberCount: memberProfiles.length,
              cover: socialRoom.cover,
              isLive: true,
              memberInitials: memberProfiles.map((profile) => profile.initials).slice(0, 4),
            }
          })
      const accountDevices = socketsForAccount(accountId)

      socket.emit('social:state', {
        currentUser: publicUser(currentProfile),
        currentDeviceCount: accountDevices.length,
        companionConnected: accountDevices.some((peer) => peer.data.socialDeviceRole === 'companion'),
        users,
        rooms: publicRooms,
        conversations,
        selectedUserId: users[0]?.id || '',
        listeningWithUserId: selectedListening.get(accountId),
        activeRoomId: selectedRooms.find((socialRoom) => socialRoom.ownerId === accountId)?.id,
      })
    }
  }

  function scheduleEmit() {
    emitChain = emitChain
      .then(() => emitAllStates())
      .catch((error) => console.error('[Ritim Social] Durum yayınlanamadı:', error))
    return emitChain
  }

  function safely(label, handler) {
    return (...args) => {
      Promise.resolve(handler(...args)).catch((error) => {
        console.error(`[Ritim Social] ${label}:`, error)
      })
    }
  }

  function sanitizeProfile(accountId, deviceRole, profile) {
    const displayName = cleanText(profile?.displayName, 60)
    if (!accountId || !displayName) return null
    return {
      id: accountId,
      displayName,
      handle: cleanText(profile.handle, 64) || '@ritim',
      initials: cleanText(profile.initials, 3).toLocaleUpperCase('tr') || 'R',
      avatarUrl: cleanText(profile.avatarUrl, 1000) || undefined,
      avatarTone: Math.max(0, Math.min(11, Number(profile.avatarTone) || 0)),
      presence: 'online',
      currentTrack: sanitizeTrack(profile.currentTrack),
      deviceRole,
    }
  }

  function profileForIdentity(profile, identity) {
    if (!identity) return profile
    return {
      ...profile,
      displayName: identity.displayName,
      handle: identity.handle,
      initials: identity.initials,
      avatarUrl: identity.avatarUrl,
      avatarTone: identity.avatarTone,
    }
  }

  function attach(socket) {
    socket.on('social:join', safely('Katılım kaydedilemedi', async ({ accountId, deviceId, deviceRole, profile } = {}) => {
      const identity = socket.data.socialIdentity
      const normalizedAccountId = cleanText(identity?.accountId || accountId, 80)
      const normalizedDeviceId = cleanText(identity?.deviceId || deviceId, 100)
      const normalizedRole = identity
        ? (identity.deviceRole === 'companion' ? 'companion' : 'desktop')
        : (deviceRole === 'desktop' ? 'desktop' : 'companion')
      const sanitized = sanitizeProfile(
        normalizedAccountId,
        normalizedRole,
        profileForIdentity(profile, identity),
      )
      if (!normalizedAccountId || !normalizedDeviceId || !sanitized) return
      socket.data.socialAccountId = normalizedAccountId
      socket.data.socialDeviceId = normalizedDeviceId
      socket.data.socialDeviceRole = normalizedRole
      socket.data.socialProfile = sanitized
      if (store) await store.upsertProfile(normalizedAccountId, normalizedDeviceId, sanitized)
      await scheduleEmit()
    }))

    socket.on('social:profile', safely('Profil güncellenemedi', async ({ profile } = {}) => {
      const accountId = socket.data.socialAccountId
      const deviceId = socket.data.socialDeviceId
      const deviceRole = socket.data.socialDeviceRole
      if (!accountId || !deviceId || !deviceRole) return
      const sanitized = sanitizeProfile(
        accountId,
        deviceRole,
        profileForIdentity(profile, socket.data.socialIdentity),
      )
      if (!sanitized) return
      socket.data.socialProfile = sanitized
      if (store) await store.upsertProfile(accountId, deviceId, sanitized)
      await scheduleEmit()
    }))

    socket.on('social:message', safely('Mesaj kaydedilemedi', async ({ targetUserId, text } = {}) => {
      const senderId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      const cleanMessage = cleanText(text, 500)
      const profiles = accountProfiles()
      if (!senderId || !targetId || targetId === senderId || !cleanMessage || !profiles.has(targetId)) return
      const message = {
        id: crypto.randomUUID(),
        senderId,
        targetId,
        text: cleanMessage,
        sentAt: Date.now(),
      }
      if (store) await store.saveMessage(message)
      else {
        messages.push(message)
        if (messages.length > 200) messages.splice(0, messages.length - 200)
      }
      await scheduleEmit()
    }))

    socket.on('social:reaction', ({ targetUserId, reaction } = {}) => {
      const senderId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      if (!senderId || !targetId || targetId === senderId || !accountProfiles().has(targetId)) return
      const current = reactions.get(targetId) || { count: 0 }
      reactions.set(targetId, {
        count: Math.min(999, current.count + 1),
        lastReaction: cleanText(reaction, 8) || '♥',
      })
      void scheduleEmit()
    })

    socket.on('social:listening', safely('Dinleme durumu güncellenemedi', async ({ targetUserId } = {}) => {
      const senderId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      if (!senderId) return
      if (store) {
        if (!targetId || targetId === senderId) await store.clearListening(senderId)
        else if (accountProfiles().has(targetId)) await store.toggleListening(senderId, targetId)
      } else if (!targetId || targetId === senderId || listening.get(senderId) === targetId) {
        listening.delete(senderId)
      } else if (accountProfiles().has(targetId)) {
        listening.set(senderId, targetId)
      }
      await scheduleEmit()
    }))

    socket.on('social:create-room', safely('Oda güncellenemedi', async ({ title, cover } = {}) => {
      const ownerId = socket.data.socialAccountId
      const owner = accountProfiles().get(ownerId)
      if (!ownerId || !owner) return
      const cleanTitle = cleanText(title, 100) || `${owner.displayName} dinliyor`
      const cleanCover = Math.max(0, Math.min(11, Number(cover) || 0))
      if (store) {
        await store.toggleRoom(ownerId, cleanTitle, cleanCover)
      } else {
        const existing = [...rooms.values()].find((socialRoom) => socialRoom.ownerId === ownerId)
        if (existing) rooms.delete(existing.id)
        else {
          const id = `room-${crypto.randomUUID()}`
          rooms.set(id, { id, ownerId, title: cleanTitle, cover: cleanCover })
        }
      }
      await scheduleEmit()
    }))

    socket.on('disconnect', safely('Bağlantı kapanışı temizlenemedi', async () => {
      const accountId = socket.data.socialAccountId
      const deviceId = socket.data.socialDeviceId
      if (!accountId) return
      if (store && deviceId) await store.removePresence(accountId, deviceId)
      await new Promise((resolve) => setImmediate(resolve))
      if (store && socketsForAccount(accountId).length === 0) await store.clearListening(accountId)
      await scheduleEmit()
    }))
  }

  const presenceHeartbeat = store
    ? setInterval(() => {
        for (const socket of socialSockets()) {
          const { socialAccountId, socialDeviceId, socialProfile } = socket.data
          if (socialAccountId && socialDeviceId && socialProfile) {
            void store.touchPresence(socialAccountId, socialDeviceId, socialProfile)
              .catch((error) => console.error('[Ritim Social] Presence yenilenemedi:', error))
          }
        }
      }, 20_000)
    : undefined
  presenceHeartbeat?.unref()

  function close() {
    if (presenceHeartbeat) clearInterval(presenceHeartbeat)
  }

  return { attach, emitAllStates: scheduleEmit, close }
}

module.exports = { createSocialHub }
