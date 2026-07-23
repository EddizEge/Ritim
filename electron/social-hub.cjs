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

function createSocialHub(io) {
  const messages = []
  const reactions = new Map()
  const listening = new Map()
  const rooms = new Map()

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

  function cleanOrphanedState(profiles) {
    for (const [listenerId, targetId] of listening.entries()) {
      if (!profiles.has(listenerId) || !profiles.has(targetId)) listening.delete(listenerId)
    }
    for (const socialRoom of rooms.values()) {
      if (!profiles.has(socialRoom.ownerId)) rooms.delete(socialRoom.id)
    }
  }

  function emitAllStates() {
    const profiles = accountProfiles()
    cleanOrphanedState(profiles)

    for (const socket of socialSockets()) {
      const accountId = socket.data.socialAccountId
      const currentProfile = profiles.get(accountId)
      if (!currentProfile) continue
      const users = [...profiles.values()]
        .filter((profile) => profile.id !== accountId)
        .map(publicUser)
      const conversations = {}
      for (const user of users) {
        conversations[user.id] = messages.filter((message) => (
          (message.senderId === accountId && message.targetId === user.id)
          || (message.senderId === user.id && message.targetId === accountId)
        )).map(({ targetId: _targetId, ...message }) => message)
      }
      const publicRooms = [...rooms.values()].map((socialRoom) => {
        const memberIds = new Set([socialRoom.ownerId])
        for (const [memberId, targetId] of listening.entries()) {
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
        listeningWithUserId: listening.get(accountId),
        activeRoomId: [...rooms.values()].find((socialRoom) => socialRoom.ownerId === accountId)?.id,
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

  function attach(socket) {
    socket.on('social:join', ({ accountId, deviceId, deviceRole, profile } = {}) => {
      const normalizedAccountId = cleanText(accountId, 80)
      const normalizedDeviceId = cleanText(deviceId, 100)
      const normalizedRole = deviceRole === 'desktop' ? 'desktop' : 'companion'
      const sanitized = sanitizeProfile(normalizedAccountId, normalizedRole, profile)
      if (!normalizedAccountId || !normalizedDeviceId || !sanitized) return
      socket.data.socialAccountId = normalizedAccountId
      socket.data.socialDeviceId = normalizedDeviceId
      socket.data.socialDeviceRole = normalizedRole
      socket.data.socialProfile = sanitized
      emitAllStates()
    })

    socket.on('social:profile', ({ profile } = {}) => {
      const accountId = socket.data.socialAccountId
      const deviceRole = socket.data.socialDeviceRole
      if (!accountId || !deviceRole) return
      const sanitized = sanitizeProfile(accountId, deviceRole, profile)
      if (!sanitized) return
      socket.data.socialProfile = sanitized
      emitAllStates()
    })

    socket.on('social:message', ({ targetUserId, text } = {}) => {
      const senderId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      const cleanMessage = cleanText(text, 500)
      const profiles = accountProfiles()
      if (!senderId || !targetId || targetId === senderId || !cleanMessage || !profiles.has(targetId)) return
      messages.push({
        id: crypto.randomUUID(),
        senderId,
        targetId,
        text: cleanMessage,
        sentAt: Date.now(),
      })
      if (messages.length > 200) messages.splice(0, messages.length - 200)
      emitAllStates()
    })

    socket.on('social:reaction', ({ targetUserId, reaction } = {}) => {
      const senderId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      if (!senderId || !targetId || targetId === senderId || !accountProfiles().has(targetId)) return
      const current = reactions.get(targetId) || { count: 0 }
      reactions.set(targetId, {
        count: Math.min(999, current.count + 1),
        lastReaction: cleanText(reaction, 8) || '♥',
      })
      emitAllStates()
    })

    socket.on('social:listening', ({ targetUserId } = {}) => {
      const senderId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      if (!senderId) return
      if (!targetId || targetId === senderId || listening.get(senderId) === targetId) listening.delete(senderId)
      else if (accountProfiles().has(targetId)) listening.set(senderId, targetId)
      emitAllStates()
    })

    socket.on('social:create-room', ({ title, cover } = {}) => {
      const ownerId = socket.data.socialAccountId
      const owner = accountProfiles().get(ownerId)
      if (!ownerId || !owner) return
      const existing = [...rooms.values()].find((socialRoom) => socialRoom.ownerId === ownerId)
      if (existing) rooms.delete(existing.id)
      else {
        const id = `room-${crypto.randomUUID()}`
        rooms.set(id, {
          id,
          ownerId,
          title: cleanText(title, 100) || `${owner.displayName} dinliyor`,
          cover: Math.max(0, Number(cover) || 0),
        })
      }
      emitAllStates()
    })

    socket.on('disconnect', () => {
      const accountId = socket.data.socialAccountId
      if (!accountId) return
      setImmediate(emitAllStates)
    })
  }

  return { attach, emitAllStates }
}

module.exports = { createSocialHub }
