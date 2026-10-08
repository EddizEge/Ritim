const crypto = require('node:crypto')
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_ROOM_MEMBERS = 8
const MAX_PLAYBACK_POSITION_MS = 24 * 60 * 60 * 1000
const ROOM_SYNC_RESULT_STALE_MS = 15_000
const MAX_ROOM_SYNC_ROUND_TRIP_MS = 60_000
const MAX_ROOM_SYNC_DRIFT_MS = 60_000

function accountLookupKey(value) {
  return UUID_PATTERN.test(value)
    ? value
    : crypto.createHash('sha256').update(value).digest('hex')
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

// Clients can send any JSON value; handlers that destructure their payload
// synchronously must never see null or a primitive.
function objectPayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
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

function sanitizeRoomPlayback(value, ownerId) {
  const roomId = cleanText(value?.roomId, 80)
  const videoId = cleanText(value?.videoId, 32)
  const playbackRevision = Math.floor(Number(value?.playbackRevision) || 0)
  const playbackPositionMs = Math.floor(Number(value?.playbackPositionMs) || 0)
  if (
    !roomId
    || !videoId
    || !Number.isSafeInteger(playbackRevision)
    || playbackRevision < 1
    || playbackPositionMs < 0
    || playbackPositionMs > MAX_PLAYBACK_POSITION_MS
    || !['playing', 'paused'].includes(value?.playbackState)
  ) return null
  return {
    roomId,
    ownerId,
    videoId,
    playbackPositionMs,
    playbackState: value.playbackState,
    playbackRevision,
  }
}

function clampRoomSyncMetric(value, minimum, maximum) {
  const selected = Number(value)
  if (!Number.isFinite(selected)) return 0
  return Math.round(Math.max(minimum, Math.min(maximum, selected)))
}

function summarizeRoomSyncResult(result, playbackRevision, now = Date.now()) {
  const currentRevision = Math.floor(Number(playbackRevision) || 0)
  const currentTime = Number(now)
  const reportedAtMs = Number(result?.reportedAtMs)
  if (
    !result
    || currentRevision < 1
    || result.playbackRevision !== currentRevision
    || !Number.isFinite(currentTime)
    || !Number.isFinite(reportedAtMs)
  ) return { status: 'waiting' }

  const measuredAt = Math.max(0, Math.min(Math.floor(currentTime), Math.floor(reportedAtMs)))
  if (currentTime - measuredAt > ROOM_SYNC_RESULT_STALE_MS) return { status: 'waiting' }

  const corrected = result.status === 'applied' && (
    result.seekApplied
    || result.playbackStateApplied
  )
  return {
    status: result.status === 'failed' ? 'unavailable' : corrected ? 'corrected' : 'synced',
    roundTripMs: clampRoomSyncMetric(result.roundTripMs, 0, MAX_ROOM_SYNC_ROUND_TRIP_MS),
    driftMs: clampRoomSyncMetric(result.driftMs, -MAX_ROOM_SYNC_DRIFT_MS, MAX_ROOM_SYNC_DRIFT_MS),
    measuredAt,
  }
}

function createSocialHub(io, { store, onAbuse } = {}) {
  const messages = []
  const reactions = new Map()
  const listening = new Map()
  const rooms = new Map()
  const roomPlayback = new Map()
  const roomMessages = new Map()
  const roomReactions = new Map()
  const privacy = new Map()
  const blocks = new Set()
  const readMarkers = new Map()
  const messageRequests = new Map()
  const notifications = new Map()
  const notificationPreferences = new Map()
  const mutedConversations = new Set()
  const reports = []
  const knownProfiles = new Map()
  let emitChain = Promise.resolve()

  function conversationKey(leftId, rightId) {
    return [leftId, rightId].sort().join(':')
  }

  function preferencesFor(accountId) {
    const selected = notificationPreferences.get(accountId)
    return {
      messagesEnabled: selected?.messagesEnabled !== false,
      reactionsEnabled: selected?.reactionsEnabled !== false,
      deviceEnabled: false,
    }
  }

  function pushMemoryNotification(recipientId, notification) {
    const preferences = preferencesFor(recipientId)
    if (
      (notification.kind === 'reaction' && !preferences.reactionsEnabled)
      || (notification.kind !== 'reaction' && !preferences.messagesEnabled)
      || (notification.actorId && mutedConversations.has(`${recipientId}:${notification.actorId}`))
    ) return
    const selected = notifications.get(recipientId) || []
    selected.unshift({
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      read: false,
      ...notification,
    })
    notifications.set(recipientId, selected.slice(0, 50))
  }

  function socialSockets() {
    return [...io.sockets.sockets.values()].filter((socket) => socket.data.socialAccountId)
  }

  function socketsForAccount(accountId) {
    return socialSockets().filter((socket) => socket.data.socialAccountId === accountId)
  }

  function viewerRoomPlaybackState(accountId, socialRoom, playback, viewerIsListener, now) {
    if (!viewerIsListener) {
      return {
        viewerPlaybackStatus: 'idle',
        viewerPlaybackError: undefined,
        syncSummary: undefined,
      }
    }
    const latestResult = socketsForAccount(accountId)
      .filter((peer) => (
        peer.data.socialDeviceRole === 'desktop'
        && peer.data.socialRoomPlaybackResult?.roomId === socialRoom.id
        && peer.data.socialRoomPlaybackResult?.playbackRevision === playback?.playbackRevision
      ))
      .map((peer) => peer.data.socialRoomPlaybackResult)
      .sort((left, right) => right.reportedAtMs - left.reportedAtMs)[0]
    const syncSummary = summarizeRoomSyncResult(latestResult, playback?.playbackRevision, now)
    return {
      viewerPlaybackStatus: syncSummary.status === 'unavailable'
        ? 'unavailable'
        : ['synced', 'corrected'].includes(syncSummary.status)
          ? 'ready'
          : 'idle',
      viewerPlaybackError: syncSummary.status === 'unavailable' ? latestResult?.error : undefined,
      syncSummary,
    }
  }

  function desktopAccountKeysForCurrentSockets() {
    return new Set(
      socialSockets()
        .filter((socket) => socket.data.socialDeviceRole === 'desktop')
        .map((socket) => accountLookupKey(socket.data.socialAccountId)),
    )
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
      presence: profile.presence || 'online',
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
        const isContact = messageRequests.get(conversationKey(viewerId, targetId))?.status === 'accepted'
        rules.set(targetId, {
          profile: viewerId === targetId || (!blocked && (
            targetPrivacy.profileVisibility === 'everyone'
            || (targetPrivacy.profileVisibility === 'contacts' && isContact)
          )),
          listening: viewerId === targetId || (!blocked && (
            targetPrivacy.listeningVisibility === 'everyone'
            || (targetPrivacy.listeningVisibility === 'contacts' && isContact)
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
        if (messageRequests.get(conversationKey(accountId, peerId))?.status !== 'accepted') {
          byPeer.set(peerId, 0)
          continue
        }
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

  function memoryMessageRequests(accountIds) {
    const selected = new Map(accountIds.map((accountId) => [accountId, []]))
    for (const request of messageRequests.values()) {
      if (request.status !== 'pending') continue
      if (!selected.has(request.requesterId) || !selected.has(request.recipientId)) continue
      const firstMessage = messages.find((message) => (
        message.senderId === request.requesterId && message.targetId === request.recipientId
      ))
      if (!firstMessage) continue
      selected.get(request.requesterId).push({
        userId: request.recipientId,
        direction: 'outgoing',
        preview: firstMessage.text,
        sentAt: firstMessage.sentAt,
      })
      selected.get(request.recipientId).push({
        userId: request.requesterId,
        direction: 'incoming',
        preview: firstMessage.text,
        sentAt: firstMessage.sentAt,
      })
    }
    return selected
  }

  function memoryModeration(accountIds) {
    const muted = new Map(accountIds.map((accountId) => [accountId, new Set()]))
    const blocked = new Map(accountIds.map((accountId) => [accountId, new Set()]))
    const mutedUsers = new Map(accountIds.map((accountId) => [accountId, []]))
    const blockedUsers = new Map(accountIds.map((accountId) => [accountId, []]))
    for (const key of mutedConversations) {
      const [viewerId, targetId] = key.split(':')
      const target = knownProfiles.get(targetId)
      if (!muted.has(viewerId) || !target) continue
      muted.get(viewerId).add(targetId)
      mutedUsers.get(viewerId).push(publicUser({
        ...target,
        presence: 'offline',
        currentTrack: undefined,
      }, undefined, false))
    }
    for (const key of blocks) {
      const [viewerId, targetId] = key.split(':')
      const target = knownProfiles.get(targetId)
      if (!blocked.has(viewerId) || !target) continue
      blocked.get(viewerId).add(targetId)
      blockedUsers.get(viewerId).push(publicUser({
        ...target,
        presence: 'offline',
        currentTrack: undefined,
      }, undefined, false))
    }
    return { muted, blocked, mutedUsers, blockedUsers }
  }

  function memoryReportSummaries(accountIds) {
    return new Map(accountIds.map((accountId) => {
      const selected = reports
        .filter((report) => report.reporterId === accountId)
        .sort((left, right) => right.createdAt - left.createdAt)
      return [accountId, {
        total: selected.length,
        recent: selected.slice(0, 20).map((report) => ({
          targetUserId: report.targetId,
          displayName: knownProfiles.get(report.targetId)?.displayName || 'Ritim kullanıcısı',
          reason: report.reason,
          createdAt: report.createdAt,
          status: 'received',
        })),
      }]
    }))
  }

  function cleanOrphanedMemoryState(profiles) {
    for (const listenerId of listening.keys()) {
      if (!profiles.has(listenerId)) listening.delete(listenerId)
    }
  }

  async function emitAllStates() {
    const profiles = accountProfiles()
    const accountIds = [...profiles.keys()]
    if (!store) cleanOrphanedMemoryState(profiles)

    const [
      selectedMessages,
      selectedRooms,
      selectedListening,
      selectedReactions,
      access,
      privacyEntries,
      unread,
      selectedRequests,
      selectedNotifications,
      selectedNotificationPreferences,
      moderation,
      reportSummaries,
    ] = store
      ? await Promise.all([
          store.loadMessages(accountIds),
          store.loadRooms(accountIds),
          store.loadListening(accountIds),
          store.loadReactions(accountIds),
          store.loadAccess(accountIds),
          Promise.all(accountIds.map(async (accountId) => [accountId, await store.loadPrivacy(accountId)])),
          store.loadUnreadCounts(accountIds),
          store.loadMessageRequests(accountIds),
          store.loadNotifications(accountIds),
          store.loadNotificationPreferences(accountIds),
          store.loadModerationState(accountIds),
          store.loadReportSummaries
            ? store.loadReportSummaries(accountIds)
            : Promise.resolve(memoryReportSummaries(accountIds)),
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
          memoryMessageRequests(accountIds),
          new Map(accountIds.map((accountId) => [accountId, notifications.get(accountId) || []])),
          new Map(accountIds.map((accountId) => [accountId, preferencesFor(accountId)])),
          memoryModeration(accountIds),
          memoryReportSummaries(accountIds),
        ]
    const privacyByAccount = new Map(privacyEntries)
    const playbackByRoom = store?.loadRoomPlaybacks
      ? await store.loadRoomPlaybacks(selectedRooms.map((room) => room.id))
      : roomPlayback
    const messagesByRoom = store?.loadRoomMessages
      ? await store.loadRoomMessages(selectedRooms.map((room) => room.id), accountIds)
      : roomMessages
    const now = Date.now()
    for (const [roomId, selected] of roomReactions.entries()) {
      const active = selected.filter((reaction) => reaction.expiresAt > now)
      if (active.length) roomReactions.set(roomId, active)
      else roomReactions.delete(roomId)
    }
    const desktopAccountKeys = desktopAccountKeysForCurrentSockets()

    for (const socket of socialSockets()) {
      const accountId = socket.data.socialAccountId
      const currentProfile = profiles.get(accountId)
      if (!currentProfile) continue
      const accountAccess = access.get(accountId) || new Map()
      const mutedUserIds = [...(moderation.muted.get(accountId) || new Set())]
      const blockedUserIds = moderation.blocked.get(accountId) || new Set()
      const users = [...profiles.values()]
        .filter((profile) => profile.id !== accountId && accountAccess.get(profile.id)?.profile !== false)
        .map((profile) => publicUser(
          profile,
          selectedReactions.get(profile.id),
          accountAccess.get(profile.id)?.listening !== false,
        ))
      const moderationUsers = (selectedUsers, fallbackIds) => {
        const selected = selectedUsers?.length
          ? selectedUsers
          : [...fallbackIds].map((targetId) => profiles.get(targetId) || knownProfiles.get(targetId)).filter(Boolean)
        return selected.map((storedUser) => {
          const liveProfile = profiles.get(storedUser.id)
          return liveProfile
            ? publicUser(liveProfile, selectedReactions.get(storedUser.id), false)
            : publicUser({ ...storedUser, presence: 'offline', currentTrack: undefined }, undefined, false)
        })
      }
      const mutedUsers = moderationUsers(moderation.mutedUsers?.get(accountId), mutedUserIds)
      const blockedUsers = moderationUsers(moderation.blockedUsers?.get(accountId), blockedUserIds)
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
            ...(() => {
              const playback = playbackByRoom.get(socialRoom.id)
              const ownerDesktopOnline = desktopAccountKeys.has(accountLookupKey(socialRoom.ownerId))
              const viewerPlayback = viewerRoomPlaybackState(
                accountId,
                socialRoom,
                playback,
                socialRoom.memberIds.includes(accountId) && socialRoom.ownerId !== accountId,
                now,
              )
              return {
                ownerDesktopOnline,
                lifecycle: ownerDesktopOnline ? (playback ? 'live' : 'waiting') : 'owner_offline',
                ...viewerPlayback,
              }
            })(),
            id: socialRoom.id,
            ownerId: socialRoom.ownerId,
            title: socialRoom.title,
            memberCount: socialRoom.memberCount,
            maxMembers: MAX_ROOM_MEMBERS,
            cover: socialRoom.cover,
            isLive: desktopAccountKeys.has(accountLookupKey(socialRoom.ownerId)),
            memberInitials: socialRoom.memberInitials,
            playback: playbackByRoom.get(socialRoom.id),
            viewerRole: socialRoom.ownerId === accountId
              ? 'owner'
              : socialRoom.memberIds.includes(accountId)
                ? 'listener'
                : undefined,
          }))
        : visibleRooms.map((socialRoom) => {
            const memberIds = new Set([socialRoom.ownerId])
            for (const [memberId, targetId] of selectedListening.entries()) {
              if (targetId === socialRoom.ownerId) memberIds.add(memberId)
            }
            const memberProfiles = [...memberIds].map((id) => profiles.get(id)).filter(Boolean)
            const memberInitials = memberProfiles.map((profile) => profile.initials)
            if (!profiles.has(socialRoom.ownerId) && socialRoom.ownerInitials) {
              memberInitials.unshift(socialRoom.ownerInitials)
            }
            const playback = playbackByRoom.get(socialRoom.id)
            const ownerDesktopOnline = desktopAccountKeys.has(accountLookupKey(socialRoom.ownerId))
            const viewerPlayback = viewerRoomPlaybackState(
              accountId,
              socialRoom,
              playback,
              selectedListening.get(accountId) === socialRoom.ownerId && socialRoom.ownerId !== accountId,
              now,
            )
            return {
              id: socialRoom.id,
              ownerId: socialRoom.ownerId,
              title: socialRoom.title,
              memberCount: memberIds.size,
              maxMembers: MAX_ROOM_MEMBERS,
              cover: socialRoom.cover,
              isLive: ownerDesktopOnline,
              ownerDesktopOnline,
              lifecycle: ownerDesktopOnline ? (playback ? 'live' : 'waiting') : 'owner_offline',
              ...viewerPlayback,
              memberInitials: memberInitials.slice(0, 4),
              playback: playbackByRoom.get(socialRoom.id),
              viewerRole: socialRoom.ownerId === accountId
                ? 'owner'
                : selectedListening.get(accountId) === socialRoom.ownerId
                  ? 'listener'
                  : undefined,
            }
          })
      const accountDevices = socketsForAccount(accountId)
      const memberRoomIds = publicRooms
        .filter((socialRoom) => socialRoom.viewerRole)
        .map((socialRoom) => socialRoom.id)
      const visibleRoomMessages = Object.fromEntries(memberRoomIds.map((roomId) => [
        roomId,
        (messagesByRoom.get(roomId) || []).slice(-50),
      ]))
      const visibleRoomReactions = Object.fromEntries(memberRoomIds.map((roomId) => [
        roomId,
        (roomReactions.get(roomId) || []).filter((reaction) => reaction.expiresAt > Date.now()),
      ]))

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
        roomMessages: visibleRoomMessages,
        roomReactions: visibleRoomReactions,
        conversations,
        unreadCounts,
        messageRequests: selectedRequests.get(accountId) || [],
        notifications: selectedNotifications.get(accountId) || [],
        notificationPreferences: selectedNotificationPreferences.get(accountId) || preferencesFor(accountId),
        mutedUserIds,
        mutedUsers,
        blockedUsers,
        reportSummary: reportSummaries.get(accountId) || { total: 0, recent: [] },
        selectedUserId: users[0]?.id || '',
        listeningWithUserId: accountAccess.get(selectedListening.get(accountId))?.listening === false
          ? undefined
          : selectedListening.get(accountId),
        activeRoomId: publicRooms.find((socialRoom) => socialRoom.viewerRole)?.id,
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
    const report = (error) => console.error(`[Ritim Social] ${label}:`, error)
    return (...args) => {
      let result
      try {
        result = handler(...args)
      } catch (error) {
        // A synchronous throw inside a Socket.IO listener would otherwise
        // become an uncaught exception and stop the gateway for everyone.
        report(error)
        return
      }
      Promise.resolve(result).catch(report)
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
      knownProfiles.set(normalizedAccountId, sanitized)
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
      knownProfiles.set(accountId, sanitized)
      if (store) await store.upsertProfile(accountId, deviceId, sanitized)
      await scheduleEmit()
    }))

    socket.on('social:message', safely('Mesaj kaydedilemedi', async ({
      targetUserId,
      text,
      clientMessageId,
    } = {}, acknowledge) => {
      const reply = (value) => {
        if (typeof acknowledge === 'function') acknowledge(value)
      }
      if (!eventAllowed(socket, 'message', 20, 60_000)) {
        reply({ ok: false, code: 'rate_limited' })
        return
      }
      const senderId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      const rawMessage = String(text || '').trim()
      if (rawMessage.length > 500) {
        socket.emit('social:error', { code: 'message_too_long', event: 'message' })
        reply({ ok: false, code: 'message_too_long' })
        return
      }
      const cleanMessage = cleanText(rawMessage, 500)
      const profiles = accountProfiles()
      if (!senderId || !targetId || targetId === senderId || !cleanMessage || !profiles.has(targetId)) {
        reply({ ok: false, code: 'message_blocked' })
        return
      }
      const message = {
        id: UUID_PATTERN.test(clientMessageId) ? clientMessageId : crypto.randomUUID(),
        senderId,
        targetId,
        text: cleanMessage,
        sentAt: Date.now(),
        reactions: [],
      }
      if (store) {
        try {
          const result = await store.saveMessage(message)
          if (result?.duplicate) {
            reply({ ok: true, duplicate: true })
            return
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          const code = /yanıt bekliyor/i.test(errorMessage)
            ? 'message_request_pending'
            : /reddedildi/i.test(errorMessage)
              ? 'message_request_rejected'
              : 'message_blocked'
          socket.emit('social:error', { code, event: 'message' })
          reply({ ok: false, code })
          return
        }
      } else {
        if (messages.some((candidate) => candidate.id === message.id && candidate.senderId === senderId)) {
          reply({ ok: true, duplicate: true })
          return
        }
        const key = conversationKey(senderId, targetId)
        const request = messageRequests.get(key)
        if (request?.status === 'pending') {
          socket.emit('social:error', { code: 'message_request_pending', event: 'message' })
          reply({ ok: false, code: 'message_request_pending' })
          return
        }
        if (request?.status === 'rejected') {
          if (request.recipientId !== senderId) {
            socket.emit('social:error', { code: 'message_request_rejected', event: 'message' })
            reply({ ok: false, code: 'message_request_rejected' })
            return
          }
          messageRequests.set(key, {
            requesterId: senderId,
            recipientId: targetId,
            status: 'pending',
            createdAt: message.sentAt,
          })
        }
        if (!request) {
          messageRequests.set(key, {
            requesterId: senderId,
            recipientId: targetId,
            status: 'pending',
            createdAt: message.sentAt,
          })
        }
        messages.push(message)
        pushMemoryNotification(targetId, {
          actorId: senderId,
          kind: request?.status === 'accepted' ? 'message' : 'message_request',
          messageId: message.id,
          body: message.text,
        })
        if (messages.length > 200) messages.splice(0, messages.length - 200)
      }
      reply({ ok: true, duplicate: false })
      await scheduleEmit()
    }))

    socket.on('social:message-reaction', safely('Mesaj tepkisi kaydedilemedi', async ({
      targetUserId,
      messageId,
      reaction,
    } = {}) => {
      if (!eventAllowed(socket, 'message-reaction', 40, 60_000)) return
      const actorId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      const selectedMessageId = cleanText(messageId, 80)
      const allowedReactions = new Set(['♥', '🔥', '😂', '👍'])
      if (
        !actorId
        || !targetId
        || actorId === targetId
        || !selectedMessageId
        || !allowedReactions.has(reaction)
      ) return
      if (store) {
        await store.saveMessageReaction(actorId, targetId, selectedMessageId, reaction)
      } else {
        if (messageRequests.get(conversationKey(actorId, targetId))?.status !== 'accepted') return
        if (blocks.has(`${actorId}:${targetId}`) || blocks.has(`${targetId}:${actorId}`)) return
        const message = messages.find((candidate) => candidate.id === selectedMessageId && (
          (candidate.senderId === actorId && candidate.targetId === targetId)
          || (candidate.senderId === targetId && candidate.targetId === actorId)
        ))
        if (!message) return
        const current = message.reactions.find((item) => item.actorId === actorId)
        if (current?.reaction === reaction) {
          message.reactions = message.reactions.filter((item) => item.actorId !== actorId)
        } else {
          message.reactions = [
            ...message.reactions.filter((item) => item.actorId !== actorId),
            { actorId, reaction },
          ]
          if (message.senderId !== actorId) {
            pushMemoryNotification(message.senderId, {
              actorId,
              kind: 'reaction',
              messageId: message.id,
              body: reaction,
            })
          }
        }
      }
      await scheduleEmit()
    }))

    socket.on('social:notifications-read', safely('Bildirimler okunamadı', async () => {
      if (!eventAllowed(socket, 'notifications-read', 60, 60_000)) return
      const accountId = socket.data.socialAccountId
      if (!accountId) return
      if (store) await store.markNotificationsRead(accountId)
      else {
        notifications.set(accountId, (notifications.get(accountId) || []).map((item) => ({
          ...item,
          read: true,
        })))
      }
      await scheduleEmit()
    }))

    socket.on('social:notification-preferences', safely('Bildirim ayarları kaydedilemedi', async ({
      messagesEnabled,
      reactionsEnabled,
    } = {}) => {
      if (!eventAllowed(socket, 'notification-preferences', 20, 60_000)) return
      const accountId = socket.data.socialAccountId
      if (!accountId) return
      const selected = {
        messagesEnabled: messagesEnabled !== false,
        reactionsEnabled: reactionsEnabled !== false,
        deviceEnabled: false,
      }
      if (store) await store.updateNotificationPreferences(accountId, selected)
      else notificationPreferences.set(accountId, selected)
      await scheduleEmit()
    }))

    socket.on('social:mute', safely('Sessize alma ayarı kaydedilemedi', async ({ targetUserId } = {}) => {
      if (!eventAllowed(socket, 'mute', 20, 60_000)) return
      const accountId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      if (
        !accountId
        || !targetId
        || accountId === targetId
        || (!store && !knownProfiles.has(targetId))
      ) return
      if (store) {
        await store.toggleMute(accountId, targetId)
      } else {
        if (messageRequests.get(conversationKey(accountId, targetId))?.status !== 'accepted') return
        const key = `${accountId}:${targetId}`
        if (mutedConversations.has(key)) mutedConversations.delete(key)
        else mutedConversations.add(key)
      }
      await scheduleEmit()
    }))

    socket.on('social:report', safely('Şikâyet kaydedilemedi', async ({
      targetUserId,
      reason,
      detail,
      messageId,
    } = {}) => {
      if (!eventAllowed(socket, 'report', 6, 60 * 60_000)) return
      const reporterId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      const cleanReason = cleanText(reason, 120)
      const cleanDetail = cleanText(detail, 2000)
      const cleanMessageId = cleanText(messageId, 80)
      if (
        !reporterId
        || !targetId
        || reporterId === targetId
        || cleanReason.length < 3
        || (!store && !knownProfiles.has(targetId))
      ) return
      if (store) {
        await store.saveReport(reporterId, targetId, cleanReason, cleanDetail, cleanMessageId)
      } else {
        reports.push({
          id: crypto.randomUUID(),
          reporterId,
          targetId,
          reason: cleanReason,
          detail: cleanDetail,
          messageId: cleanMessageId || undefined,
          createdAt: Date.now(),
        })
        if (reports.length > 100) reports.splice(0, reports.length - 100)
      }
      socket.emit('social:report-saved', { targetUserId: targetId })
      await scheduleEmit()
    }))

    socket.on('social:request-response', safely('Mesaj isteği yanıtlanamadı', async ({
      requesterUserId,
      action,
    } = {}) => {
      if (!eventAllowed(socket, 'request-response', 30, 60_000)) return
      const recipientId = socket.data.socialAccountId
      const requesterId = cleanText(requesterUserId, 80)
      if (
        !recipientId
        || !requesterId
        || requesterId === recipientId
        || !['accept', 'reject'].includes(action)
      ) return
      if (store) {
        await store.respondToMessageRequest(recipientId, requesterId, action)
      } else {
        const key = conversationKey(recipientId, requesterId)
        const request = messageRequests.get(key)
        if (
          !request
          || request.status !== 'pending'
          || request.requesterId !== requesterId
          || request.recipientId !== recipientId
        ) return
        request.status = action === 'accept' ? 'accepted' : 'rejected'
        if (action === 'accept') {
          const lastMessage = messages.findLast((message) => (
            message.senderId === requesterId && message.targetId === recipientId
          ))
          if (lastMessage) readMarkers.set(`${recipientId}:${requesterId}`, lastMessage.id)
        } else {
          for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index]
            if (
              (message.senderId === requesterId && message.targetId === recipientId)
              || (message.senderId === recipientId && message.targetId === requesterId)
            ) messages.splice(index, 1)
          }
        }
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
        try {
          if (!targetId || targetId === senderId) await store.clearListening(senderId)
          else if (accountProfiles().has(targetId)) {
            const ownerDesktopOnline = socketsForAccount(targetId)
              .some((peer) => peer.data.socialDeviceRole === 'desktop')
            if (!ownerDesktopOnline) throw new Error('Oda sahibi bilgisayarı çevrimdışı.')
            await store.toggleListening(senderId, targetId)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          socket.emit('social:error', {
            code: /çevrimdışı/i.test(message)
              ? 'room_owner_offline'
              : /erişim/i.test(message)
                ? 'room_access_denied'
                : /dolu/i.test(message) ? 'room_full' : 'room_not_found',
            event: 'listening',
          })
          return
        }
      } else if (!targetId || targetId === senderId || listening.get(senderId) === targetId) {
        listening.delete(senderId)
      } else if (accountProfiles().has(targetId)) {
        const targetRoom = [...rooms.values()].find((room) => room.ownerId === targetId)
        const memberCount = targetRoom
          ? 1 + [...listening.values()].filter((ownerId) => ownerId === targetId).length
          : 0
        if (!targetRoom) {
          socket.emit('social:error', { code: 'room_not_found', event: 'listening' })
          return
        }
        if (!socketsForAccount(targetId).some((peer) => peer.data.socialDeviceRole === 'desktop')) {
          socket.emit('social:error', { code: 'room_owner_offline', event: 'listening' })
          return
        }
        if (memberCount >= MAX_ROOM_MEMBERS) {
          socket.emit('social:error', { code: 'room_full', event: 'listening' })
          return
        }
        listening.set(senderId, targetId)
      }
      await scheduleEmit()
    }))

    socket.on('social:room-membership', safely('Oda üyeliği güncellenemedi', async ({
      roomId,
    } = {}, acknowledge) => {
      const reply = (value) => {
        if (typeof acknowledge === 'function') acknowledge(value)
      }
      if (!eventAllowed(socket, 'room-membership', 20, 60_000)) {
        reply({ ok: false, code: 'rate_limited' })
        return
      }
      const accountId = socket.data.socialAccountId
      const selectedRoomId = cleanText(roomId, 80)
      if (!accountId || !selectedRoomId) {
        reply({ ok: false, code: 'room_not_found' })
        return
      }
      let status
      if (store) {
        try {
          const leaving = await store.isRoomListener(accountId, selectedRoomId)
          if (!leaving) {
            const ownerKey = await store.loadRoomOwnerKey(selectedRoomId)
            if (!ownerKey) throw new Error('Dinleme odası bulunamadı.')
            if (!desktopAccountKeysForCurrentSockets().has(ownerKey)) {
              throw new Error('Oda sahibi bilgisayarı çevrimdışı.')
            }
          }
          status = await store.toggleRoomMembership(accountId, selectedRoomId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const code = /çevrimdışı/i.test(message)
            ? 'room_owner_offline'
            : /erişim/i.test(message)
              ? 'room_access_denied'
              : /dolu/i.test(message)
            ? 'room_full'
            : /sahibi/i.test(message)
              ? 'room_owner'
              : 'room_not_found'
          socket.emit('social:error', { code, event: 'room-membership' })
          reply({ ok: false, code })
          return
        }
      } else {
        const room = rooms.get(selectedRoomId)
        if (!room) {
          reply({ ok: false, code: 'room_not_found' })
          return
        }
        if (room.ownerId === accountId) {
          reply({ ok: false, code: 'room_owner' })
          return
        }
        if (listening.get(accountId) === room.ownerId) {
          listening.delete(accountId)
          status = 'left'
        } else {
          if (!socketsForAccount(room.ownerId).some((peer) => peer.data.socialDeviceRole === 'desktop')) {
            socket.emit('social:error', { code: 'room_owner_offline', event: 'room-membership' })
            reply({ ok: false, code: 'room_owner_offline' })
            return
          }
          const memberCount = 1 + [...listening.values()]
            .filter((ownerId) => ownerId === room.ownerId).length
          if (memberCount >= MAX_ROOM_MEMBERS) {
            socket.emit('social:error', { code: 'room_full', event: 'room-membership' })
            reply({ ok: false, code: 'room_full' })
            return
          }
          listening.set(accountId, room.ownerId)
          status = 'joined'
        }
      }
      for (const peer of socketsForAccount(accountId)) {
        peer.data.socialRoomPlaybackResult = undefined
      }
      reply({ ok: true, status })
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
        const existing = (await store.loadRooms([ownerId])).some((room) => room.ownerId === ownerId)
        if (!existing && !socketsForAccount(ownerId).some((peer) => peer.data.socialDeviceRole === 'desktop')) {
          socket.emit('social:error', { code: 'room_owner_offline', event: 'create-room' })
          return
        }
        await store.toggleRoom(ownerId, cleanTitle, cleanCover)
      } else {
        const existing = [...rooms.values()].find((socialRoom) => socialRoom.ownerId === ownerId)
        if (existing) {
          rooms.delete(existing.id)
          roomPlayback.delete(existing.id)
          roomMessages.delete(existing.id)
          roomReactions.delete(existing.id)
          for (const [memberId, targetOwnerId] of listening.entries()) {
            if (targetOwnerId === ownerId) listening.delete(memberId)
          }
        }
        else {
          if (!socketsForAccount(ownerId).some((peer) => peer.data.socialDeviceRole === 'desktop')) {
            socket.emit('social:error', { code: 'room_owner_offline', event: 'create-room' })
            return
          }
          listening.delete(ownerId)
          const id = `room-${crypto.randomUUID()}`
          rooms.set(id, {
            id,
            ownerId,
            ownerInitials: owner.initials,
            title: cleanTitle,
            cover: cleanCover,
          })
        }
      }
      await scheduleEmit()
    }))

    socket.on('social:room-message', safely('Oda mesajı kaydedilemedi', async ({
      roomId,
      text,
      clientMessageId,
    } = {}, acknowledge) => {
      const reply = (value) => {
        if (typeof acknowledge === 'function') acknowledge(value)
      }
      if (!eventAllowed(socket, 'room-message', 12, 60_000)) {
        reply({ ok: false, code: 'rate_limited' })
        return
      }
      const senderId = socket.data.socialAccountId
      const selectedRoomId = cleanText(roomId, 80)
      const rawMessage = String(text || '').trim()
      if (rawMessage.length > 280) {
        socket.emit('social:error', { code: 'room_message_too_long', event: 'room-message' })
        reply({ ok: false, code: 'room_message_too_long' })
        return
      }
      const cleanMessage = cleanText(rawMessage, 280)
      if (!senderId || !selectedRoomId || !cleanMessage) {
        reply({ ok: false, code: 'room_access_denied' })
        return
      }
      const allowed = store?.isRoomMember
        ? await store.isRoomMember(senderId, selectedRoomId)
        : Boolean(
            rooms.get(selectedRoomId)
            && (
              rooms.get(selectedRoomId).ownerId === senderId
              || listening.get(senderId) === rooms.get(selectedRoomId).ownerId
            )
          )
      if (!allowed) {
        socket.emit('social:error', { code: 'room_access_denied', event: 'room-message' })
        reply({ ok: false, code: 'room_access_denied' })
        return
      }
      const message = {
        id: UUID_PATTERN.test(clientMessageId) ? clientMessageId : crypto.randomUUID(),
        roomId: selectedRoomId,
        senderId,
        text: cleanMessage,
        sentAt: Date.now(),
      }
      if (store?.saveRoomMessage) {
        try {
          const result = await store.saveRoomMessage(senderId, message)
          if (result?.duplicate) {
            reply({ ok: true, duplicate: true })
            return
          }
        } catch {
          socket.emit('social:error', { code: 'room_access_denied', event: 'room-message' })
          reply({ ok: false, code: 'room_access_denied' })
          return
        }
      } else {
        const selected = roomMessages.get(selectedRoomId) || []
        if (selected.some((candidate) => candidate.id === message.id && candidate.senderId === senderId)) {
          reply({ ok: true, duplicate: true })
          return
        }
        selected.push(message)
        roomMessages.set(selectedRoomId, selected.slice(-50))
      }
      reply({ ok: true, duplicate: false })
      await scheduleEmit()
    }))

    socket.on('social:room-reaction', safely('Oda tepkisi gönderilemedi', async ({
      roomId,
      reaction,
    } = {}, acknowledge) => {
      const reply = (value) => {
        if (typeof acknowledge === 'function') acknowledge(value)
      }
      if (!eventAllowed(socket, 'room-reaction', 12, 10_000)) {
        reply({ ok: false, code: 'rate_limited' })
        return
      }
      const actorId = socket.data.socialAccountId
      const selectedRoomId = cleanText(roomId, 80)
      const allowedReactions = new Set(['♥', '🔥', '👏', '🎵'])
      const allowed = actorId && selectedRoomId && allowedReactions.has(reaction) && (
        store?.isRoomMember
          ? await store.isRoomMember(actorId, selectedRoomId)
          : Boolean(
              rooms.get(selectedRoomId)
              && (
                rooms.get(selectedRoomId).ownerId === actorId
                || listening.get(actorId) === rooms.get(selectedRoomId).ownerId
              )
            )
      )
      if (!allowed) {
        socket.emit('social:error', { code: 'room_access_denied', event: 'room-reaction' })
        reply({ ok: false, code: 'room_access_denied' })
        return
      }
      const createdAt = Date.now()
      const selected = roomReactions.get(selectedRoomId) || []
      selected.push({
        id: crypto.randomUUID(),
        roomId: selectedRoomId,
        actorId,
        reaction,
        createdAt,
        expiresAt: createdAt + 8_000,
      })
      roomReactions.set(selectedRoomId, selected.slice(-24))
      reply({ ok: true })
      await scheduleEmit()
      const expiryTimer = setTimeout(scheduleEmit, 8_100)
      expiryTimer.unref?.()
    }))

    socket.on('social:room-playback:update', safely('Oda oynatma durumu güncellenemedi', async (payload = {}, acknowledge) => {
      const reply = (value) => {
        if (typeof acknowledge === 'function') acknowledge(value)
      }
      if (!eventAllowed(socket, 'room-playback', 180, 60_000)) {
        reply({ ok: false, code: 'rate_limited' })
        return
      }
      const ownerId = socket.data.socialAccountId
      if (!ownerId || socket.data.socialDeviceRole !== 'desktop') {
        reply({ ok: false, code: 'playback_forbidden' })
        return
      }
      const candidate = sanitizeRoomPlayback(payload, ownerId)
      if (!candidate) {
        reply({ ok: false, code: 'playback_invalid' })
        return
      }

      let result
      if (store?.publishRoomPlayback) {
        try {
          result = await store.publishRoomPlayback(ownerId, candidate)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          reply({
            ok: false,
            code: /eski|revision/i.test(message) ? 'stale_revision' : 'playback_forbidden',
          })
          return
        }
      } else {
        const room = rooms.get(candidate.roomId)
        if (!room || room.ownerId !== ownerId) {
          reply({ ok: false, code: 'playback_forbidden' })
          return
        }
        const previous = roomPlayback.get(candidate.roomId)
        if (previous && candidate.playbackRevision <= previous.playbackRevision) {
          reply({ ok: false, code: 'stale_revision', playback: previous })
          return
        }
        result = {
          accepted: true,
          playback: { ...candidate, serverTimeMs: Date.now() },
        }
        roomPlayback.set(candidate.roomId, result.playback)
      }

      if (!result?.accepted) {
        reply({ ok: false, code: 'stale_revision', playback: result?.playback })
        return
      }
      reply({ ok: true, playback: result.playback })
      await scheduleEmit()
    }))

    socket.on('social:clock:ping', (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') return
      const { requestId, clientSentAtMs } = objectPayload(payload)
      if (!socket.data.socialAccountId || !eventAllowed(socket, 'clock-ping', 30, 60_000)) {
        acknowledge({ ok: false })
        return
      }
      acknowledge({
        ok: true,
        requestId: cleanText(requestId, 80),
        clientSentAtMs: Number(clientSentAtMs) || 0,
        serverTimeMs: Date.now(),
      })
    })

    socket.on('social:room-playback:result', safely('Oda oynatma sonucu kaydedilemedi', async (payload = {}, acknowledge) => {
      const reply = (value) => {
        if (typeof acknowledge === 'function') acknowledge(value)
      }
      if (!eventAllowed(socket, 'room-playback-result', 180, 60_000)) {
        reply({ ok: false, code: 'rate_limited' })
        return
      }
      const accountId = socket.data.socialAccountId
      const roomId = cleanText(payload.roomId, 80)
      const playbackRevision = Math.floor(Number(payload.playbackRevision) || 0)
      if (
        !accountId
        || socket.data.socialDeviceRole !== 'desktop'
        || !roomId
        || !Number.isSafeInteger(playbackRevision)
        || playbackRevision < 1
      ) {
        reply({ ok: false, code: 'playback_result_forbidden' })
        return
      }
      const allowed = store?.isRoomListener
        ? await store.isRoomListener(accountId, roomId)
        : Boolean(rooms.get(roomId) && listening.get(accountId) === rooms.get(roomId).ownerId)
      if (!allowed) {
        reply({ ok: false, code: 'playback_result_forbidden' })
        return
      }
      const previousResult = socket.data.socialRoomPlaybackResult
      socket.data.socialRoomPlaybackResult = {
        roomId,
        playbackRevision,
        status: payload.status === 'applied' ? 'applied' : 'failed',
        seekApplied: Boolean(payload.seekApplied),
        playbackStateApplied: Boolean(payload.playbackStateApplied),
        driftMs: Math.max(-86_400_000, Math.min(86_400_000, Number(payload.driftMs) || 0)),
        roundTripMs: Math.max(0, Math.min(60_000, Number(payload.roundTripMs) || 0)),
        reason: cleanText(payload.reason, 64),
        error: cleanText(payload.error, 240),
        reportedAtMs: Date.now(),
      }
      if (socket.data.socialRoomPlaybackResultExpiryTimer) {
        clearTimeout(socket.data.socialRoomPlaybackResultExpiryTimer)
      }
      socket.data.socialRoomPlaybackResultExpiryTimer = setTimeout(
        scheduleEmit,
        ROOM_SYNC_RESULT_STALE_MS + 25,
      )
      socket.data.socialRoomPlaybackResultExpiryTimer.unref?.()
      reply({ ok: true })
      if (
        previousResult?.roomId !== socket.data.socialRoomPlaybackResult.roomId
        || previousResult?.playbackRevision !== socket.data.socialRoomPlaybackResult.playbackRevision
        || previousResult?.status !== socket.data.socialRoomPlaybackResult.status
        || previousResult?.seekApplied !== socket.data.socialRoomPlaybackResult.seekApplied
        || previousResult?.playbackStateApplied !== socket.data.socialRoomPlaybackResult.playbackStateApplied
        || previousResult?.driftMs !== socket.data.socialRoomPlaybackResult.driftMs
        || previousResult?.roundTripMs !== socket.data.socialRoomPlaybackResult.roundTripMs
        || previousResult?.reason !== socket.data.socialRoomPlaybackResult.reason
        || previousResult?.error !== socket.data.socialRoomPlaybackResult.error
      ) await scheduleEmit()
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
      else {
        privacy.set(accountId, preferences)
        if (preferences.listeningVisibility !== 'everyone') {
          for (const [listenerId, ownerId] of listening.entries()) {
            if (ownerId !== accountId) continue
            const isContact = messageRequests.get(conversationKey(listenerId, accountId))?.status === 'accepted'
            if (preferences.listeningVisibility === 'hidden' || !isContact) listening.delete(listenerId)
          }
        }
      }
      await scheduleEmit()
    }))

    socket.on('social:block', safely('Engelleme ayarı güncellenemedi', async ({ targetUserId } = {}) => {
      if (!eventAllowed(socket, 'block', 12, 60_000)) return
      const accountId = socket.data.socialAccountId
      const targetId = cleanText(targetUserId, 80)
      if (
        !accountId
        || !targetId
        || accountId === targetId
        || (!store && !knownProfiles.has(targetId))
      ) return
      let blocked
      if (store) blocked = await store.toggleBlock(accountId, targetId)
      else {
        const key = `${accountId}:${targetId}`
        if (blocks.has(key)) {
          blocks.delete(key)
          blocked = false
        } else {
          blocks.add(key)
          blocked = true
        }
      }
      if (blocked) {
        if (listening.get(accountId) === targetId) listening.delete(accountId)
        if (listening.get(targetId) === accountId) listening.delete(targetId)
      }
      await scheduleEmit()
    }))

    socket.on('disconnect', safely('Bağlantı kapanışı temizlenemedi', async () => {
      const accountId = socket.data.socialAccountId
      const deviceId = socket.data.socialDeviceId
      if (socket.data.socialRoomPlaybackResultExpiryTimer) {
        clearTimeout(socket.data.socialRoomPlaybackResultExpiryTimer)
      }
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
    for (const socket of socialSockets()) {
      if (socket.data.socialRoomPlaybackResultExpiryTimer) {
        clearTimeout(socket.data.socialRoomPlaybackResultExpiryTimer)
      }
    }
  }

  return { attach, emitAllStates: scheduleEmit, close }
}

module.exports = { createSocialHub, summarizeRoomSyncResult }
