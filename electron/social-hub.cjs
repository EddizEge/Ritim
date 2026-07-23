const crypto = require('node:crypto')

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function createSocialHub(io) {
  const roomRecords = new Map()

  function recordFor(room) {
    let record = roomRecords.get(room)
    if (!record) {
      record = {
        messages: [],
        reactions: new Map(),
        listening: new Map(),
        rooms: new Map(),
      }
      roomRecords.set(room, record)
    }
    return record
  }

  function socketsInRoom(room) {
    const socketIds = io.sockets.adapter.rooms.get(room) || new Set()
    return [...socketIds].map((id) => io.sockets.sockets.get(id)).filter(Boolean)
  }

  function profilesInRoom(room) {
    const profiles = new Map()
    for (const socket of socketsInRoom(room)) {
      const profile = socket.data.socialProfile
      if (profile?.id) profiles.set(profile.id, profile)
    }
    return profiles
  }

  function publicUser(profile, record) {
    const reaction = record.reactions.get(profile.id)
    return {
      ...profile,
      reactionCount: reaction?.count || 0,
      lastReaction: reaction?.lastReaction || undefined,
    }
  }

  function emitState(room) {
    const record = recordFor(room)
    const profiles = profilesInRoom(room)

    for (const socket of socketsInRoom(room)) {
      const currentProfile = socket.data.socialProfile
      if (!currentProfile?.id) continue
      const users = [...profiles.values()]
        .filter((profile) => profile.id !== currentProfile.id)
        .map((profile) => publicUser(profile, record))
      const conversations = {}
      for (const user of users) {
        conversations[user.id] = record.messages.filter((message) => (
          (message.senderId === currentProfile.id && message.targetId === user.id)
          || (message.senderId === user.id && message.targetId === currentProfile.id)
        )).map(({ targetId: _targetId, ...message }) => message)
      }
      const rooms = [...record.rooms.values()].map((socialRoom) => {
        const memberIds = new Set([socialRoom.ownerId])
        for (const [memberId, targetId] of record.listening.entries()) {
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

      socket.emit('social:state', {
        currentUser: publicUser(currentProfile, record),
        users,
        rooms,
        conversations,
        selectedUserId: users[0]?.id || '',
        listeningWithUserId: record.listening.get(currentProfile.id),
        activeRoomId: [...record.rooms.values()].find((socialRoom) => socialRoom.ownerId === currentProfile.id)?.id,
      })
    }
  }

  function attach(socket) {
    socket.on('social:profile', ({ room, profile } = {}) => {
      if (!room || socket.data.room !== room || !profile) return
      const id = cleanText(profile.id, 80)
      const displayName = cleanText(profile.displayName, 60)
      if (!id || !displayName) return
      socket.data.socialProfile = {
        id,
        displayName,
        handle: cleanText(profile.handle, 64) || '@ritim',
        initials: cleanText(profile.initials, 3).toLocaleUpperCase('tr') || 'R',
        avatarTone: Math.max(0, Math.min(11, Number(profile.avatarTone) || 0)),
        presence: ['online', 'away', 'offline'].includes(profile.presence) ? profile.presence : 'online',
        currentTrack: profile.currentTrack && cleanText(profile.currentTrack.title, 160)
          ? {
              id: cleanText(profile.currentTrack.id, 160),
              videoId: cleanText(profile.currentTrack.videoId, 32) || undefined,
              title: cleanText(profile.currentTrack.title, 160),
              artist: cleanText(profile.currentTrack.artist, 120),
              duration: Math.max(0, Number(profile.currentTrack.duration) || 0),
              position: Math.max(0, Number(profile.currentTrack.position) || 0),
              cover: Math.max(0, Number(profile.currentTrack.cover) || 0),
              thumbnailUrl: cleanText(profile.currentTrack.thumbnailUrl, 1000) || undefined,
              isPlaying: Boolean(profile.currentTrack.isPlaying),
            }
          : undefined,
        reactionCount: 0,
      }
      emitState(room)
    })

    socket.on('social:message', ({ room, targetUserId, text } = {}) => {
      const sender = socket.data.socialProfile
      if (!sender?.id || socket.data.room !== room) return
      const targetId = cleanText(targetUserId, 80)
      const cleanMessage = cleanText(text, 500)
      if (!targetId || !cleanMessage || !profilesInRoom(room).has(targetId)) return
      const record = recordFor(room)
      record.messages.push({
        id: crypto.randomUUID(),
        senderId: sender.id,
        targetId,
        text: cleanMessage,
        sentAt: Date.now(),
      })
      if (record.messages.length > 200) record.messages.splice(0, record.messages.length - 200)
      emitState(room)
    })

    socket.on('social:reaction', ({ room, targetUserId, reaction } = {}) => {
      const sender = socket.data.socialProfile
      if (!sender?.id || socket.data.room !== room) return
      const targetId = cleanText(targetUserId, 80)
      if (!targetId || !profilesInRoom(room).has(targetId)) return
      const record = recordFor(room)
      const current = record.reactions.get(targetId) || { count: 0 }
      record.reactions.set(targetId, {
        count: Math.min(999, current.count + 1),
        lastReaction: cleanText(reaction, 8) || '♥',
      })
      emitState(room)
    })

    socket.on('social:listening', ({ room, targetUserId } = {}) => {
      const sender = socket.data.socialProfile
      if (!sender?.id || socket.data.room !== room) return
      const targetId = cleanText(targetUserId, 80)
      const record = recordFor(room)
      if (!targetId || record.listening.get(sender.id) === targetId) record.listening.delete(sender.id)
      else if (profilesInRoom(room).has(targetId)) record.listening.set(sender.id, targetId)
      emitState(room)
    })

    socket.on('social:create-room', ({ room, title, cover } = {}) => {
      const owner = socket.data.socialProfile
      if (!owner?.id || socket.data.room !== room) return
      const record = recordFor(room)
      const existing = [...record.rooms.values()].find((socialRoom) => socialRoom.ownerId === owner.id)
      if (existing) record.rooms.delete(existing.id)
      else {
        const id = `room-${crypto.randomUUID()}`
        record.rooms.set(id, {
          id,
          ownerId: owner.id,
          title: cleanText(title, 100) || `${owner.displayName} dinliyor`,
          cover: Math.max(0, Number(cover) || 0),
        })
      }
      emitState(room)
    })
  }

  function joined(socket, room) {
    socket.data.socialRoom = room
    emitState(room)
  }

  function disconnected(socket) {
    const room = socket.data.socialRoom
    const profileId = socket.data.socialProfile?.id
    if (!room) return
    const record = roomRecords.get(room)
    if (record && profileId) {
      record.listening.delete(profileId)
      for (const [listenerId, targetId] of record.listening.entries()) {
        if (targetId === profileId) record.listening.delete(listenerId)
      }
      const ownedRoom = [...record.rooms.values()].find((socialRoom) => socialRoom.ownerId === profileId)
      if (ownedRoom) record.rooms.delete(ownedRoom.id)
    }
    emitState(room)
    if (socketsInRoom(room).length === 0) roomRecords.delete(room)
  }

  return { attach, joined, disconnected }
}

module.exports = { createSocialHub }
