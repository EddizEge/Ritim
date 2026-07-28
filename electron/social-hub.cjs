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

function createSocialHub(io, { store, onAbuse } = {}) {
  const messages = []
  const reactions = new Map()
  const listening = new Map()
  const rooms = new Map()
  const privacy = new Map()
  const blocks = new Set()
  const readMarkers = new Map()
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

  function publicUser(profile, reaction, showListening = true) {
    return {
      id: profile.id,
      displayName: profile.displayName,
      handle: profile.handle,
      initials: profile.initials,
      avatarUrl: profile.avatarUrl,
      avatarTone: profile.avatarTone,
      presence: 'online',
      currentTrack: showListening ? profile.currentTrack : undefined,
      reactionCount: reaction?.count || 0,
      lastReaction: reaction?.lastReaction || undefined,
    }
  }

  function memoryAccess(accountIds) {
    const access = new Map()
    for (const viewerId of accountIds) {
      const rules = new Map()
      for (const targetId of accountIds) {
        const targetPrivacy = privacy.get(targetId) || {
          profileVisibility: 'everyone',
          listeningVisibility: 'everyone',
        }
        const blocked = blocks.has(`${viewerId}:${targetId}`) || blocks.has(`${targetId}:${viewerId}`)
        const hasConversation = messages.some((message) => (
          (message.senderId === viewerId && message.targetId === targetId)
          || (message.senderId === targetId && message.targetId === viewerId)
        ))
        rules.set(targetId, {
          profile: viewerId === targetId || (!blocked && (
            targetPrivacy.profileVisibility === 'everyone'
            || (targetPrivacy.profileVisibility === 'contacts' && hasConversation)
          )),
          listening: viewerId === targetId || (!blocked && (
            targetPrivacy.listeningVisibility === 'everyone'
            || (targetPrivacy.listeningVisibility === 'contacts' && hasConversation)
          )),
        })
      }
      access.set(viewerId, rules)
    }
    return access
  }

  function memoryUnread(accountIds) {
    const unread = new Map()
    for (const accountId of accountIds) {
      const byPeer = new Map()
      for (const peerId of accountIds) {
        if (peerId === accountId) continue
        const conversation = messages.filter((message) => (
          (message.senderId === accountId && message.targetId === peerId)
          || (message.senderId === peerId && message.targetId === accountId)
        ))
        const lastReadId = readMarkers.get(`${accountId}:${peerId}`)
        const lastReadIndex = lastReadId
          ? conversation.findIndex((message) => message.id === lastReadId)
          : -1
        const count = conversation
          .slice(lastReadIndex + 1)
          .filter((message) => message.senderId === peerId && message.targetId === accountId)
          .length
        byPeer.set(peerId, count)
      }
      unread.set(accountId, byPeer)
    }
    return unread
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

    const [selectedMessages, selectedRooms, selectedListening, selectedReactions, access, privacyEntries, unread] = store
      ? await Promise.all([
          store.loadMessages(accountIds),
          store.loadRooms(accountIds),
          store.loadListening(accountIds),
          store.loadReactions(accountIds),
          store.loadAccess(accountIds),
          Promise.all(accountIds.map(async (accountId) => [accountId, await store.loadPrivacy(accountId)])),
          store.loadUnreadCounts(accountIds),
        ])
      : [
          messages,
          [...rooms.values()],
          listening,
          reactions,
          memoryAccess(accountIds),
          accountIds.map((accountId) => [accountId, privacy.get(accountId) || {
            profileVisibility: 'everyone',
            listeningVisibility: 'everyone',
          }]),
          memoryUnread(accountIds),
        ]
    const privacyByAccount = new Map(privacyEntries)

    for (const socket of socialSockets()) {
      const accountId = socket.data.socialAccountId
      const currentProfile = profiles.get(accountId)
      if (!currentProfile) continue
      const accountAccess = access.get(accountId) || new Map()
      const users = [...profiles.values()]
        .filter((profile) => profile.id !== accountId && accountAccess.get(profile.id)?.profile !== false)
        .map((profile) => publicUser(
          profile,
          selectedReactions.get(profile.id),
          accountAccess.get(profile.id)?.listening !== false,
        ))
      const conversations = {}
      const unreadCounts = {}
      for (const user of users) {
        conversations[user.id] = selectedMessages.filter((message) => (
          (message.senderId === accountId && message.targetId === user.id)
          || (message.senderId === user.id && message.targetId === accountId)
        )).map(({ targetId: _targetId, ...message }) => message)
        unreadCounts[user.id] = Math.max(0, Number(unread.get(accountId)?.get(user.id)) || 0)
      }
      const visibleRooms = selectedRooms.filter((socialRoom) => (
        socialRoom.ownerId === accountId
        || (
          accountAccess.get(socialRoom.ownerId)?.profile !== false
          && accountAccess.get(socialRoom.ownerId)?.listening !== false
        )
      ))
      const publicRooms = store
        ? visibleRooms.map((socialRoom) => ({
            id: socialRoom.id,
            title: socialRoom.title,
            memberCount: socialRoom.memberCount,
            cover: socialRoom.cover,
            isLive: true,
            memberInitials: socialRoom.memberInitials,
          }))
        : visibleRooms.map((socialRoom) => {
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
        currentUser: publicUser(currentProfile, selectedReactions.get(accountId)),
        privacy: privacyByAccount.get(accountId) || {
          profileVisibility: 'everyone',
          listeningVisibility: 'everyone',
        },
        currentDeviceCount: accountDevices.length,
        companionConnected: accountDevices.some((peer) => peer.data.socialDeviceRole === 'companion'),
        users,
        rooms: publicRooms,
        conversations,
        unreadCounts,
        selectedUserId: users[0]?.id || '',
        listeningWithUserId: accountAccess.get(selectedListening.get(accountId))?.listening === false
          ? undefined
          : selectedListening.get(accountId),
        activeRoomId: selectedRooms.find((socialRoom) => socialRoom.ownerId === accountId)?.id,
      })
    }
  }

  function eventAllowed(socket, eventName, limit, windowMs) {
    const now = Date.now()
    const limits = socket.data.socialEventLimits || new Map()
    socket.data.socialEventLimits = limits
    const current = limits.get(eventName)
    const entry = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + windowMs }
      : { ...current, count: current.count + 1 }
    limits.set(eventName, entry)
    if (entry.count <= limit) return true
    const fingerprint = crypto.createHash('sha256')
      .update(socket.data.socialAccountId || socket.id)
      .digest('hex')
      .slice(0, 16)
    onAbuse?.({
      category: `socket_event:${eventName}`,
      fingerprint,
      limit,
      windowMs,
    })
    socket.emit('social:error', {
      code: 'rate_limited',
      event: eventName,
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    })
    return false
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
      if (!eventAllowed(socket, 'join', 10, 60_000)) return
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
      if (!eventAllowed(socket, 'profile', 180, 60_000)) return
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
      if (!eventAllowed(socket, 'message', 20, 60_000)) return
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

    socket.on('social:reaction', safely('Tepki kaydedilemedi', async ({ targetUserId, reaction } = {}) => {
      if (!eventAllowed(socket, 'reaction', 30, 60_000)) return
      const senderId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      if (!senderId || !targetId || targetId === senderId || !accountProfiles().has(targetId)) return
      const cleanReaction = cleanText(reaction, 8) || '♥'
      if (store) await store.saveReaction({ actorId: senderId, targetId, reaction: cleanReaction })
      else {
        const current = reactions.get(targetId) || { count: 0 }
        reactions.set(targetId, {
          count: Math.min(999, current.count + 1),
          lastReaction: cleanReaction,
        })
      }
      await scheduleEmit()
    }))

    socket.on('social:read', safely('Okundu bilgisi kaydedilemedi', async ({ targetUserId } = {}) => {
      if (!eventAllowed(socket, 'read', 120, 60_000)) return
      const accountId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      if (!accountId || !targetId || accountId === targetId || !accountProfiles().has(targetId)) return
      if (store) {
        await store.markConversationRead(accountId, targetId)
      } else {
        const lastMessage = messages.findLast((message) => (
          (message.senderId === accountId && message.targetId === targetId)
          || (message.senderId === targetId && message.targetId === accountId)
        ))
        if (lastMessage) readMarkers.set(`${accountId}:${targetId}`, lastMessage.id)
      }
      await scheduleEmit()
    }))

    socket.on('social:listening', safely('Dinleme durumu güncellenemedi', async ({ targetUserId } = {}) => {
      if (!eventAllowed(socket, 'listening', 20, 60_000)) return
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
      if (!eventAllowed(socket, 'create-room', 10, 60_000)) return
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

    socket.on('social:privacy', safely('Gizlilik ayarı güncellenemedi', async ({
      profileVisibility,
      listeningVisibility,
    } = {}) => {
      if (!eventAllowed(socket, 'privacy', 12, 60_000)) return
      const accountId = socket.data.socialAccountId
      if (!accountId) return
      const allowedValues = new Set(['everyone', 'contacts', 'hidden'])
      const preferences = {
        profileVisibility: allowedValues.has(profileVisibility) ? profileVisibility : 'everyone',
        listeningVisibility: allowedValues.has(listeningVisibility) ? listeningVisibility : 'everyone',
      }
      if (store) await store.updatePrivacy(accountId, preferences)
      else privacy.set(accountId, preferences)
      await scheduleEmit()
    }))

    socket.on('social:block', safely('Engelleme ayarı güncellenemedi', async ({ targetUserId } = {}) => {
      if (!eventAllowed(socket, 'block', 12, 60_000)) return
      const accountId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      if (!accountId || !targetId || accountId === targetId || !accountProfiles().has(targetId)) return
      if (store) await store.toggleBlock(accountId, targetId)
      else {
        const key = `${accountId}:${targetId}`
        if (blocks.has(key)) blocks.delete(key)
        else blocks.add(key)
      }
      listening.delete(accountId)
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
