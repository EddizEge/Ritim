const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const test = require('node:test')
const { Server } = require('socket.io')
const { io: createClient } = require('socket.io-client')
const { createSocialHub } = require('../electron/social-hub.cjs')

function profile(id, displayName, deviceRole) {
  return {
    id,
    displayName,
    handle: `@${displayName.toLowerCase().replace(/\s/g, '')}`,
    initials: displayName.slice(0, 2),
    avatarUrl: `https://example.test/${encodeURIComponent(id)}.png`,
    avatarTone: 0,
    presence: 'online',
    deviceRole,
  }
}

test('PC ve telefon tek hesap, diğer cihazlar ayrı kullanıcı olarak görünür', async (context) => {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io)
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  const url = `http://127.0.0.1:${address.port}`
  const latestStates = new Map()

  const connect = async (name, accountId, deviceRole) => {
    const client = createClient(url, { autoConnect: false, transports: ['websocket'] })
    client.on('social:state', (state) => latestStates.set(name, state))
    client.connect()
    await new Promise((resolve) => client.once('connect', resolve))
    client.emit('social:join', {
      accountId,
      deviceId: `${name}-device`,
      deviceRole,
      profile: profile(accountId, name, deviceRole),
    })
    return client
  }

  const waitForState = async (name, predicate, timeout = 2000) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeout) {
      const state = latestStates.get(name)
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`${name} için beklenen sosyal durum gelmedi`)
  }

  const desktopA = await connect('Ediz PC', 'account-a', 'desktop')
  const phoneA = await connect('Ediz Telefon', 'account-a', 'companion')
  const stateA = await waitForState('Ediz PC', (state) => state.currentDeviceCount === 2)
  assert.equal(stateA.users.length, 0)
  assert.equal(stateA.companionConnected, true)
  assert.equal(stateA.currentUser.id, 'account-a')
  assert.equal(stateA.currentUser.displayName, 'Ediz PC')
  assert.equal(stateA.currentUser.avatarUrl, 'https://example.test/account-a.png')

  const desktopB = await connect('Deniz PC', 'account-b', 'desktop')
  const phoneB = await connect('Deniz Telefon', 'account-b', 'companion')
  const stateAWithB = await waitForState('Ediz PC', (state) => state.users.length === 1)
  const stateBWithA = await waitForState('Deniz PC', (state) => state.users.length === 1)
  assert.equal(stateAWithB.users[0].id, 'account-b')
  assert.equal(stateBWithA.users[0].id, 'account-a')

  const tooLongError = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Uzun mesaj reddedilmedi')), 2_000)
    desktopA.once('social:error', (error) => {
      clearTimeout(timer)
      resolve(error)
    })
  })
  const tooLongAck = await new Promise((resolve) => {
    desktopA.emit('social:message', {
      targetUserId: 'account-b',
      text: 'x'.repeat(501),
      clientMessageId: '40000000-0000-4000-8000-000000000000',
    }, resolve)
  })
  assert.equal(tooLongAck.code, 'message_too_long')
  assert.equal((await tooLongError).code, 'message_too_long')

  const firstClientMessageId = '40000000-0000-4000-8000-000000000001'
  const firstAck = await new Promise((resolve) => {
    desktopA.emit('social:message', {
      targetUserId: 'account-b',
      text: 'Selam Deniz',
      clientMessageId: firstClientMessageId,
    }, resolve)
  })
  assert.equal(firstAck.ok, true)
  assert.equal(firstAck.duplicate, false)
  const requestedState = await waitForState('Deniz PC', (state) => (
    state.conversations['account-a']?.length === 1
    && state.messageRequests[0]?.userId === 'account-a'
    && state.messageRequests[0]?.direction === 'incoming'
  ))
  assert.equal(requestedState.conversations['account-a'][0].text, 'Selam Deniz')
  assert.equal(requestedState.unreadCounts['account-a'], 0)
  assert.equal(requestedState.notifications.length, 1)
  assert.equal(requestedState.notifications[0].kind, 'message_request')
  await waitForState('Deniz Telefon', (state) => state.messageRequests[0]?.direction === 'incoming')
  await waitForState('Ediz PC', (state) => state.messageRequests[0]?.direction === 'outgoing')

  const duplicateAck = await new Promise((resolve) => {
    desktopA.emit('social:message', {
      targetUserId: 'account-b',
      text: 'Selam Deniz',
      clientMessageId: firstClientMessageId,
    }, resolve)
  })
  assert.deepEqual(duplicateAck, { ok: true, duplicate: true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(latestStates.get('Deniz PC').conversations['account-a'].length, 1)
  assert.equal(latestStates.get('Deniz PC').notifications.length, 1)

  desktopA.emit('social:message', { targetUserId: 'account-b', text: 'Beklerken ikinci mesaj' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(latestStates.get('Deniz PC').conversations['account-a'].length, 1)

  phoneB.emit('social:request-response', { requesterUserId: 'account-a', action: 'accept' })
  await waitForState('Deniz PC', (state) => state.messageRequests.length === 0)
  await waitForState('Deniz Telefon', (state) => state.messageRequests.length === 0)
  await waitForState('Ediz PC', (state) => state.messageRequests.length === 0)

  desktopA.emit('social:message', { targetUserId: 'account-b', text: 'Nasılsın?' })
  const messagedState = await waitForState('Deniz PC', (state) => (
    state.conversations['account-a']?.length === 2 && state.unreadCounts['account-a'] === 1
  ))
  assert.equal(messagedState.conversations['account-a'][1].text, 'Nasılsın?')
  assert.equal(messagedState.notifications.filter((notification) => !notification.read).length, 2)
  await waitForState('Deniz Telefon', (state) => state.unreadCounts['account-a'] === 1)
  phoneB.emit('social:read', { targetUserId: 'account-a' })
  await waitForState('Deniz PC', (state) => state.unreadCounts['account-a'] === 0)
  await waitForState('Deniz Telefon', (state) => state.unreadCounts['account-a'] === 0)
  phoneB.emit('social:notifications-read')
  await waitForState('Deniz PC', (state) => state.notifications.every((notification) => notification.read))
  await waitForState('Deniz Telefon', (state) => state.notifications.every((notification) => notification.read))

  phoneB.emit('social:message-reaction', {
    targetUserId: 'account-a',
    messageId: messagedState.conversations['account-a'][1].id,
    reaction: '🔥',
  })
  const messageReactionState = await waitForState('Ediz PC', (state) => (
    state.conversations['account-b']?.[1]?.reactions?.[0]?.reaction === '🔥'
    && state.notifications[0]?.kind === 'reaction'
  ))
  assert.equal(messageReactionState.notifications[0].body, '🔥')
  await waitForState('Ediz Telefon', (state) => state.notifications[0]?.kind === 'reaction')

  phoneB.emit('social:mute', { targetUserId: 'account-a' })
  await waitForState('Deniz PC', (state) => state.mutedUserIds.includes('account-a'))
  await waitForState('Deniz Telefon', (state) => state.mutedUserIds.includes('account-a'))
  desktopA.emit('social:message', { targetUserId: 'account-b', text: 'Sessizde de kaydolur' })
  const mutedMessageState = await waitForState('Deniz PC', (state) => (
    state.conversations['account-a']?.length === 3
  ))
  assert.equal(mutedMessageState.notifications.every((notification) => notification.read), true)
  phoneB.emit('social:mute', { targetUserId: 'account-a' })
  await waitForState('Deniz PC', (state) => !state.mutedUserIds.includes('account-a'))

  const reportSaved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Şikâyet kaydedilmedi')), 2_000)
    phoneB.once('social:report-saved', (result) => {
      clearTimeout(timer)
      resolve(result)
    })
  })
  phoneB.emit('social:report', {
    targetUserId: 'account-a',
    reason: 'Spam',
    detail: 'Alpha 3 güvenlik testi',
    messageId: messagedState.conversations['account-a'][1].id,
  })
  assert.equal((await reportSaved).targetUserId, 'account-a')

  desktopA.emit('social:reaction', { targetUserId: 'account-b', reaction: '🔥' })
  const reactedState = await waitForState('Ediz PC', (state) => state.users[0]?.reactionCount === 1)
  assert.equal(reactedState.users[0].lastReaction, '🔥')

  desktopB.emit('social:privacy', {
    profileVisibility: 'hidden',
    listeningVisibility: 'hidden',
  })
  await waitForState('Ediz PC', (state) => state.users.length === 0)
  desktopB.emit('social:privacy', {
    profileVisibility: 'everyone',
    listeningVisibility: 'everyone',
  })
  await waitForState('Ediz PC', (state) => state.users.length === 1)

  desktopB.emit('social:create-room', { title: 'Gece sürüşü', cover: 2 })
  const roomState = await waitForState('Ediz PC', (state) => state.rooms.length === 1)
  assert.equal(roomState.rooms[0].title, 'Gece sürüşü')
  assert.equal(roomState.rooms[0].ownerId, 'account-b')
  assert.equal(roomState.rooms[0].maxMembers, 8)
  const ownerRoomState = await waitForState('Deniz PC', (state) => (
    state.rooms[0]?.viewerRole === 'owner' && state.activeRoomId === state.rooms[0].id
  ))

  const joinedRoom = await new Promise((resolve) => {
    desktopA.emit('social:room-membership', { roomId: ownerRoomState.rooms[0].id }, resolve)
  })
  assert.deepEqual(joinedRoom, { ok: true, status: 'joined' })
  const listeningState = await waitForState('Ediz PC', (state) => (
    state.listeningWithUserId === 'account-b'
    && state.rooms[0]?.memberCount === 2
    && state.rooms[0]?.viewerRole === 'listener'
    && state.activeRoomId === state.rooms[0].id
  ))
  assert.equal(listeningState.rooms[0].memberCount, 2)

  const clockResult = await new Promise((resolve) => {
    desktopA.emit('social:clock:ping', {
      requestId: 'alpha4-clock-sample',
      clientSentAtMs: Date.now(),
    }, resolve)
  })
  assert.equal(clockResult.ok, true)
  assert.equal(clockResult.requestId, 'alpha4-clock-sample')
  assert.equal(clockResult.serverTimeMs > 0, true)

  const firstPlayback = await new Promise((resolve) => {
    desktopB.emit('social:room-playback:update', {
      roomId: ownerRoomState.rooms[0].id,
      videoId: 'alpha4-video-one',
      playbackPositionMs: 42_000,
      playbackState: 'playing',
      playbackRevision: 1,
    }, resolve)
  })
  assert.equal(firstPlayback.ok, true)
  assert.equal(firstPlayback.playback.ownerId, 'account-b')
  assert.equal(firstPlayback.playback.serverTimeMs > 0, true)
  const synchronizedPlayback = await waitForState('Ediz Telefon', (state) => (
    state.rooms[0]?.playback?.playbackRevision === 1
    && state.rooms[0].playback.videoId === 'alpha4-video-one'
  ))
  assert.equal(synchronizedPlayback.rooms[0].playback.playbackPositionMs, 42_000)

  const duplicatePlayback = await new Promise((resolve) => {
    desktopB.emit('social:room-playback:update', {
      roomId: ownerRoomState.rooms[0].id,
      videoId: 'alpha4-video-old',
      playbackPositionMs: 1_000,
      playbackState: 'paused',
      playbackRevision: 1,
    }, resolve)
  })
  assert.equal(duplicatePlayback.ok, false)
  assert.equal(duplicatePlayback.code, 'stale_revision')
  assert.equal(duplicatePlayback.playback.videoId, 'alpha4-video-one')

  const companionSpoof = await new Promise((resolve) => {
    phoneB.emit('social:room-playback:update', {
      roomId: ownerRoomState.rooms[0].id,
      videoId: 'companion-spoof',
      playbackPositionMs: 0,
      playbackState: 'playing',
      playbackRevision: 2,
    }, resolve)
  })
  assert.deepEqual(companionSpoof, { ok: false, code: 'playback_forbidden' })

  const listenerSpoof = await new Promise((resolve) => {
    desktopA.emit('social:room-playback:update', {
      roomId: ownerRoomState.rooms[0].id,
      videoId: 'listener-spoof',
      playbackPositionMs: 0,
      playbackState: 'playing',
      playbackRevision: 2,
    }, resolve)
  })
  assert.deepEqual(listenerSpoof, { ok: false, code: 'playback_forbidden' })

  const secondPlayback = await new Promise((resolve) => {
    desktopB.emit('social:room-playback:update', {
      roomId: ownerRoomState.rooms[0].id,
      videoId: 'alpha4-video-two',
      playbackPositionMs: 9_500,
      playbackState: 'paused',
      playbackRevision: 2,
    }, resolve)
  })
  assert.equal(secondPlayback.ok, true)
  await waitForState('Ediz PC', (state) => (
    state.rooms[0]?.playback?.playbackRevision === 2
    && state.rooms[0].playback.playbackState === 'paused'
  ))

  const playbackResult = await new Promise((resolve) => {
    desktopA.emit('social:room-playback:result', {
      roomId: ownerRoomState.rooms[0].id,
      playbackRevision: 2,
      status: 'applied',
      seekApplied: true,
      playbackStateApplied: false,
      driftMs: 2_300,
      roundTripMs: 54,
      reason: 'drift_correction',
    }, resolve)
  })
  assert.deepEqual(playbackResult, { ok: true })

  const ownerPlaybackResult = await new Promise((resolve) => {
    desktopB.emit('social:room-playback:result', {
      roomId: ownerRoomState.rooms[0].id,
      playbackRevision: 2,
      status: 'applied',
    }, resolve)
  })
  assert.deepEqual(ownerPlaybackResult, { ok: false, code: 'playback_result_forbidden' })

  const phonePlaybackResult = await new Promise((resolve) => {
    phoneA.emit('social:room-playback:result', {
      roomId: ownerRoomState.rooms[0].id,
      playbackRevision: 2,
      status: 'applied',
    }, resolve)
  })
  assert.deepEqual(phonePlaybackResult, { ok: false, code: 'playback_result_forbidden' })

  const leftRoom = await new Promise((resolve) => {
    desktopA.emit('social:room-membership', { roomId: ownerRoomState.rooms[0].id }, resolve)
  })
  assert.deepEqual(leftRoom, { ok: true, status: 'left' })
  const stoppedListeningState = await waitForState('Ediz PC', (state) => (
    !state.listeningWithUserId
    && state.rooms[0]?.memberCount === 1
    && !state.rooms[0]?.viewerRole
    && !state.activeRoomId
  ))
  assert.equal(stoppedListeningState.rooms[0].memberCount, 1)

  desktopB.emit('social:block', { targetUserId: 'account-a' })
  await waitForState('Ediz PC', (state) => state.users.length === 0 && state.rooms.length === 0)
  await waitForState('Deniz PC', (state) => (
    state.users.length === 0 && state.blockedUsers[0]?.id === 'account-a'
  ))
  desktopB.emit('social:block', { targetUserId: 'account-a' })
  await waitForState('Deniz PC', (state) => state.users.length === 1 && state.blockedUsers.length === 0)
  await waitForState('Ediz PC', (state) => state.users.length === 1)
  desktopB.emit('social:block', { targetUserId: 'account-a' })
  await waitForState('Ediz PC', (state) => state.users.length === 0)
  await waitForState('Deniz PC', (state) => state.blockedUsers[0]?.id === 'account-a')

  desktopB.disconnect()
  const disconnectedState = await waitForState('Ediz PC', (state) => state.users.length === 0)
  assert.equal(disconnectedState.rooms.length, 0)

  context.after(async () => {
    desktopA.disconnect()
    phoneA.disconnect()
    phoneB.disconnect()
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })
})

test('Beta 1 ayar snapshotı hesap tercihlerini ve çevrimdışı moderasyon özetini güvenle eşitler', async (context) => {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io)
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${httpServer.address().port}`
  const states = new Map()
  const clients = []

  context.after(async () => {
    clients.forEach((client) => client.disconnect())
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })

  const connect = async (name, accountId, deviceRole) => {
    const client = createClient(url, { transports: ['websocket'] })
    clients.push(client)
    client.on('social:state', (state) => states.set(name, state))
    await new Promise((resolve) => client.once('connect', resolve))
    client.emit('social:join', {
      accountId,
      deviceId: `${name}-device`,
      deviceRole,
      profile: profile(accountId, name, deviceRole),
    })
    return client
  }

  const waitFor = async (name, predicate, timeout = 2_000) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeout) {
      const state = states.get(name)
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`${name} için Beta 1 ayar durumu gelmedi`)
  }

  const viewerDesktop = await connect('Beta Ayar PC', 'beta-settings-viewer', 'desktop')
  const viewerPhone = await connect('Beta Ayar Telefon', 'beta-settings-viewer', 'companion')
  const target = await connect('Beta Hedef', 'beta-settings-target', 'desktop')
  await waitFor('Beta Ayar PC', (state) => state.currentDeviceCount === 2 && state.users.length === 1)

  viewerDesktop.emit('social:message', {
    targetUserId: 'beta-settings-target',
    text: 'Sessize alma ilişkisi için istek',
    clientMessageId: '80000000-0000-4000-8000-000000000001',
  })
  await waitFor('Beta Hedef', (state) => state.messageRequests[0]?.userId === 'beta-settings-viewer')
  target.emit('social:request-response', { requesterUserId: 'beta-settings-viewer', action: 'accept' })
  await waitFor('Beta Ayar PC', (state) => state.messageRequests.length === 0)

  viewerPhone.emit('social:notification-preferences', {
    messagesEnabled: false,
    reactionsEnabled: true,
    deviceEnabled: true,
  })
  const desktopPreferences = await waitFor('Beta Ayar PC', (state) => (
    state.notificationPreferences?.messagesEnabled === false
    && state.notificationPreferences?.deviceEnabled === false
  ))
  const phonePreferences = await waitFor('Beta Ayar Telefon', (state) => (
    state.notificationPreferences?.messagesEnabled === false
    && state.notificationPreferences?.deviceEnabled === false
  ))
  assert.deepEqual(desktopPreferences.notificationPreferences, {
    messagesEnabled: false,
    reactionsEnabled: true,
    deviceEnabled: false,
  })
  assert.deepEqual(phonePreferences.notificationPreferences, desktopPreferences.notificationPreferences)

  viewerPhone.emit('social:mute', { targetUserId: 'beta-settings-target' })
  const mutedState = await waitFor('Beta Ayar PC', (state) => (
    state.mutedUserIds.includes('beta-settings-target')
    && state.mutedUsers?.[0]?.id === 'beta-settings-target'
  ))
  assert.equal(mutedState.mutedUsers[0].displayName, 'Beta Hedef')

  viewerDesktop.emit('social:block', { targetUserId: 'beta-settings-target' })
  await waitFor('Beta Ayar Telefon', (state) => state.blockedUsers?.[0]?.id === 'beta-settings-target')

  const reportSaved = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Beta 1 şikâyet özeti kaydedilmedi')), 2_000)
    viewerPhone.once('social:report-saved', (result) => {
      clearTimeout(timer)
      resolve(result)
    })
  })
  viewerPhone.emit('social:report', {
    targetUserId: 'beta-settings-target',
    reason: 'Spam',
    detail: 'Snapshot içinde görünmemesi gereken özel açıklama',
  })
  assert.deepEqual(await reportSaved, { targetUserId: 'beta-settings-target' })
  const reportState = await waitFor('Beta Ayar PC', (state) => state.reportSummary?.total === 1)
  const recentReport = reportState.reportSummary.recent[0]
  assert.deepEqual(Object.keys(recentReport).sort(), [
    'createdAt',
    'displayName',
    'reason',
    'status',
    'targetUserId',
  ])
  assert.equal(recentReport.targetUserId, 'beta-settings-target')
  assert.equal(recentReport.displayName, 'Beta Hedef')
  assert.equal(recentReport.reason, 'Spam')
  assert.equal(recentReport.status, 'received')
  assert.equal(recentReport.createdAt > 0, true)
  await waitFor('Beta Ayar Telefon', (state) => state.reportSummary?.total === 1)
  await waitFor('Beta Hedef', (state) => state.reportSummary?.total === 0)

  target.disconnect()
  const offlineState = await waitFor('Beta Ayar PC', (state) => (
    state.blockedUsers?.[0]?.presence === 'offline'
    && state.mutedUsers?.[0]?.presence === 'offline'
  ))
  assert.equal(offlineState.blockedUsers[0].id, 'beta-settings-target')
  assert.equal(offlineState.mutedUsers[0].id, 'beta-settings-target')
  assert.equal(offlineState.reportSummary.recent[0].displayName, 'Beta Hedef')

  viewerDesktop.emit('social:block', { targetUserId: 'beta-settings-target' })
  await waitFor('Beta Ayar PC', (state) => state.blockedUsers.length === 0)
  viewerPhone.emit('social:mute', { targetUserId: 'beta-settings-target' })
  await waitFor('Beta Ayar Telefon', (state) => state.mutedUsers.length === 0)
})

test('oda sahibi PC çevrimdışı kalınca oda korunur, erişim ve oynatma hataları güvenle yönetilir', async (context) => {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const abuseEvents = []
  const hub = createSocialHub(io, { onAbuse: (event) => abuseEvents.push(event) })
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  const url = `http://127.0.0.1:${address.port}`
  const latestStates = new Map()
  const clients = []

  context.after(async () => {
    for (const client of clients) client.disconnect()
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })

  const connect = async (name, accountId, deviceRole) => {
    const client = createClient(url, { autoConnect: false, transports: ['websocket'] })
    clients.push(client)
    client.on('social:state', (state) => latestStates.set(name, state))
    client.connect()
    await new Promise((resolve) => client.once('connect', resolve))
    client.emit('social:join', {
      accountId,
      deviceId: `${name}-device`,
      deviceRole,
      profile: profile(accountId, name, deviceRole),
    })
    return client
  }
  const waitForState = async (name, predicate, timeout = 2_000) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeout) {
      const state = latestStates.get(name)
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`${name} için beklenen oda yaşam döngüsü durumu gelmedi`)
  }
  const roomMembership = (client, roomId) => new Promise((resolve) => {
    client.emit('social:room-membership', { roomId }, resolve)
  })

  const listener = await connect('Dinleyici PC', 'listener-account', 'desktop')
  const ownerDesktop = await connect('Oda Sahibi PC', 'owner-account', 'desktop')
  let ownerPhone = await connect('Oda Sahibi Telefon', 'owner-account', 'companion')
  const outsider = await connect('Yeni Dinleyici PC', 'outsider-account', 'desktop')

  ownerDesktop.emit('social:create-room', { title: 'Dayanıklı oda', cover: 4 })
  const initialRoom = await waitForState('Dinleyici PC', (state) => (
    state.rooms[0]?.title === 'Dayanıklı oda'
    && state.rooms[0]?.lifecycle === 'waiting'
    && state.rooms[0]?.ownerDesktopOnline === true
  ))
  const roomId = initialRoom.rooms[0].id
  assert.deepEqual(await roomMembership(listener, roomId), { ok: true, status: 'joined' })

  const outsiderMessage = await new Promise((resolve) => {
    outsider.emit('social:room-message', {
      roomId,
      text: 'Odaya katılmadan gönderilememeli',
      clientMessageId: '60000000-0000-4000-8000-000000000001',
    }, resolve)
  })
  assert.deepEqual(outsiderMessage, { ok: false, code: 'room_access_denied' })
  const outsiderState = await waitForState('Yeni Dinleyici PC', (state) => state.rooms[0]?.id === roomId)
  assert.deepEqual(outsiderState.roomMessages, {})

  const roomMessageId = '60000000-0000-4000-8000-000000000002'
  const roomMessage = await new Promise((resolve) => {
    ownerPhone.emit('social:room-message', {
      roomId,
      text: 'Bu nakarat çok iyi',
      clientMessageId: roomMessageId,
    }, resolve)
  })
  assert.deepEqual(roomMessage, { ok: true, duplicate: false })
  const roomChatState = await waitForState('Dinleyici PC', (state) => (
    state.roomMessages?.[roomId]?.[0]?.text === 'Bu nakarat çok iyi'
  ))
  assert.equal(roomChatState.roomMessages[roomId][0].senderId, 'owner-account')
  await waitForState('Oda Sahibi PC', (state) => state.roomMessages?.[roomId]?.length === 1)

  const duplicateRoomMessage = await new Promise((resolve) => {
    ownerPhone.emit('social:room-message', {
      roomId,
      text: 'Bu nakarat çok iyi',
      clientMessageId: roomMessageId,
    }, resolve)
  })
  assert.deepEqual(duplicateRoomMessage, { ok: true, duplicate: true })

  const longRoomMessage = await new Promise((resolve) => {
    listener.emit('social:room-message', {
      roomId,
      text: 'x'.repeat(281),
      clientMessageId: '60000000-0000-4000-8000-000000000003',
    }, resolve)
  })
  assert.deepEqual(longRoomMessage, { ok: false, code: 'room_message_too_long' })

  const firstReaction = await new Promise((resolve) => {
    listener.emit('social:room-reaction', { roomId, reaction: '🔥' }, resolve)
  })
  assert.deepEqual(firstReaction, { ok: true })
  const reactedRoomState = await waitForState('Oda Sahibi Telefon', (state) => (
    state.roomReactions?.[roomId]?.some((reaction) => reaction.reaction === '🔥')
  ))
  assert.equal(reactedRoomState.roomReactions[roomId][0].actorId, 'listener-account')

  for (let index = 0; index < 11; index += 1) {
    const allowedReaction = await new Promise((resolve) => {
      listener.emit('social:room-reaction', { roomId, reaction: '👏' }, resolve)
    })
    assert.equal(allowedReaction.ok, true)
  }
  const limitedReaction = await new Promise((resolve) => {
    listener.emit('social:room-reaction', { roomId, reaction: '🎵' }, resolve)
  })
  assert.deepEqual(limitedReaction, { ok: false, code: 'rate_limited' })
  assert.equal(abuseEvents.some((event) => event.category === 'socket_event:room-reaction'), true)

  const playbackAck = await new Promise((resolve) => {
    ownerDesktop.emit('social:room-playback:update', {
      roomId,
      videoId: 'alpha4-lifecycle-video',
      playbackPositionMs: 18_000,
      playbackState: 'playing',
      playbackRevision: 1,
    }, resolve)
  })
  assert.equal(playbackAck.ok, true)
  await waitForState('Dinleyici PC', (state) => state.rooms[0]?.lifecycle === 'live')

  const failedResult = await new Promise((resolve) => {
    listener.emit('social:room-playback:result', {
      roomId,
      playbackRevision: 1,
      status: 'failed',
      reason: 'track_unavailable',
      error: 'Video is not available for this account',
    }, resolve)
  })
  assert.deepEqual(failedResult, { ok: true })
  const unavailableState = await waitForState('Dinleyici PC', (state) => (
    state.rooms[0]?.viewerPlaybackStatus === 'unavailable'
  ))
  assert.equal(unavailableState.rooms[0].viewerPlaybackError, 'Video is not available for this account')

  listener.emit('social:room-playback:result', {
    roomId,
    playbackRevision: 1,
    status: 'applied',
  })
  await waitForState('Dinleyici PC', (state) => state.rooms[0]?.viewerPlaybackStatus === 'ready')

  ownerDesktop.disconnect()
  const offlineState = await waitForState('Dinleyici PC', (state) => (
    state.rooms[0]?.id === roomId
    && state.rooms[0]?.lifecycle === 'owner_offline'
    && state.rooms[0]?.ownerDesktopOnline === false
    && state.rooms[0]?.playback?.playbackRevision === 1
  ))
  assert.equal(offlineState.activeRoomId, roomId)

  ownerPhone.disconnect()
  const fullyOfflineState = await waitForState('Dinleyici PC', (state) => (
    state.rooms[0]?.id === roomId
    && state.rooms[0]?.lifecycle === 'owner_offline'
    && state.rooms[0]?.memberCount === 2
    && !state.users.some((user) => user.id === 'owner-account')
  ))
  assert.equal(fullyOfflineState.rooms[0].memberInitials.includes('OD'), true)

  const offlineJoin = await roomMembership(outsider, roomId)
  assert.deepEqual(offlineJoin, { ok: false, code: 'room_owner_offline' })
  assert.deepEqual(await roomMembership(listener, roomId), { ok: true, status: 'left' })

  ownerPhone = await connect('Oda Sahibi Telefon 2', 'owner-account', 'companion')
  const ownerDesktopAgain = await connect('Oda Sahibi PC 2', 'owner-account', 'desktop')
  await waitForState('Yeni Dinleyici PC', (state) => (
    state.rooms[0]?.id === roomId
    && state.rooms[0]?.lifecycle === 'live'
    && state.rooms[0]?.playback?.playbackRevision === 1
  ))
  assert.deepEqual(await roomMembership(listener, roomId), { ok: true, status: 'joined' })

  ownerPhone.emit('social:privacy', {
    profileVisibility: 'everyone',
    listeningVisibility: 'hidden',
  })
  await waitForState('Dinleyici PC', (state) => !state.activeRoomId && state.rooms.length === 0)

  ownerPhone.emit('social:privacy', {
    profileVisibility: 'everyone',
    listeningVisibility: 'everyone',
  })
  await waitForState('Dinleyici PC', (state) => state.rooms[0]?.id === roomId)
  assert.deepEqual(await roomMembership(listener, roomId), { ok: true, status: 'joined' })
  ownerPhone.emit('social:block', { targetUserId: 'listener-account' })
  await waitForState('Dinleyici PC', (state) => !state.activeRoomId && state.rooms.length === 0)

  ownerPhone.emit('social:block', { targetUserId: 'listener-account' })
  await waitForState('Dinleyici PC', (state) => state.rooms[0]?.id === roomId)
  ownerDesktopAgain.emit('social:create-room', {})
  await waitForState('Dinleyici PC', (state) => state.rooms.length === 0)
})

test('reddedilen mesaj isteği silinir ve yalnızca alıcı yeni istek başlatabilir', async (context) => {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io)
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${httpServer.address().port}`
  const states = new Map()
  const connect = async (name, accountId) => {
    const client = createClient(url, { transports: ['websocket'] })
    client.on('social:state', (state) => states.set(name, state))
    await new Promise((resolve) => client.once('connect', resolve))
    client.emit('social:join', {
      accountId,
      deviceId: `${accountId}-desktop`,
      deviceRole: 'desktop',
      profile: profile(accountId, name, 'desktop'),
    })
    return client
  }
  const waitFor = async (name, predicate) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 2_000) {
      const state = states.get(name)
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`${name} için mesaj isteği durumu gelmedi`)
  }
  const sender = await connect('Gönderen', 'request-sender')
  const recipient = await connect('Alıcı', 'request-recipient')
  context.after(async () => {
    sender.disconnect()
    recipient.disconnect()
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })
  await waitFor('Gönderen', (state) => state.users.length === 1)

  sender.emit('social:message', { targetUserId: 'request-recipient', text: 'Tanışalım mı?' })
  await waitFor('Alıcı', (state) => state.messageRequests[0]?.direction === 'incoming')
  recipient.emit('social:request-response', { requesterUserId: 'request-sender', action: 'reject' })
  await waitFor('Alıcı', (state) => (
    state.messageRequests.length === 0 && state.conversations['request-sender']?.length === 0
  ))

  const rejectedError = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Reddedilen istek yeniden gönderilebildi')), 2_000)
    sender.once('social:error', (error) => {
      clearTimeout(timer)
      resolve(error)
    })
  })
  sender.emit('social:message', { targetUserId: 'request-recipient', text: 'Tekrar deneme' })
  assert.equal((await rejectedError).code, 'message_request_rejected')

  recipient.emit('social:message', { targetUserId: 'request-sender', text: 'Ben yazmak istedim.' })
  const reversed = await waitFor('Gönderen', (state) => state.messageRequests[0]?.direction === 'incoming')
  assert.equal(reversed.messageRequests[0].userId, 'request-recipient')
})

test('Alpha.4 odası sahibi dahil sekiz hesapla sınırlıdır', async (context) => {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io)
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${httpServer.address().port}`
  const states = new Map()
  const clients = []
  context.after(async () => {
    clients.forEach((client) => client.disconnect())
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })

  const connect = async (accountId, displayName) => {
    const client = createClient(url, { transports: ['websocket'] })
    client.on('social:state', (state) => states.set(accountId, state))
    await new Promise((resolve) => client.once('connect', resolve))
    client.emit('social:join', {
      accountId,
      deviceId: `${accountId}-desktop`,
      deviceRole: 'desktop',
      profile: profile(accountId, displayName, 'desktop'),
    })
    clients.push(client)
    return client
  }
  const waitFor = async (accountId, predicate) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 2_000) {
      const state = states.get(accountId)
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`${accountId} için oda kapasite durumu gelmedi`)
  }

  const owner = await connect('room-owner', 'Oda Sahibi')
  const listeners = []
  for (let index = 1; index <= 8; index += 1) {
    listeners.push(await connect(`room-listener-${index}`, `Dinleyici ${index}`))
  }
  await waitFor('room-owner', (state) => state.users.length === 8)
  owner.emit('social:create-room', { title: 'Sekiz kişilik oda', cover: 3 })
  const ownerState = await waitFor('room-owner', (state) => state.rooms[0]?.viewerRole === 'owner')
  const roomId = ownerState.rooms[0].id

  for (const listener of listeners.slice(0, 7)) {
    const result = await new Promise((resolve) => {
      listener.emit('social:room-membership', { roomId }, resolve)
    })
    assert.deepEqual(result, { ok: true, status: 'joined' })
  }
  const fullState = await waitFor('room-owner', (state) => state.rooms[0]?.memberCount === 8)
  assert.equal(fullState.rooms[0].maxMembers, 8)

  const fullError = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dokuzuncu hesap oda sınırında reddedilmedi')), 2_000)
    listeners[7].once('social:error', (error) => {
      clearTimeout(timer)
      resolve(error)
    })
  })
  const rejected = await new Promise((resolve) => {
    listeners[7].emit('social:room-membership', { roomId }, resolve)
  })
  assert.deepEqual(rejected, { ok: false, code: 'room_full' })
  assert.equal((await fullError).code, 'room_full')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(states.get('room-owner').rooms[0].memberCount, 8)
})

test('doğrulanmış socket kimliği istemcinin account ve profil iddiasını ezer', async (context) => {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io)
  const verifiedIdentity = {
    accountId: '10000000-0000-4000-8000-000000000001',
    deviceId: '20000000-0000-4000-8000-000000000001',
    sessionId: '30000000-0000-4000-8000-000000000001',
    deviceRole: 'companion',
    displayName: 'Doğrulanmış Kullanıcı',
    handle: '@verified_user',
    initials: 'DK',
    avatarUrl: 'https://example.test/verified.png',
    avatarTone: 7,
  }
  io.on('connection', (socket) => {
    socket.data.socialIdentity = verifiedIdentity
    hub.attach(socket)
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  const client = createClient(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
  })
  context.after(async () => {
    client.disconnect()
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })

  const statePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Doğrulanmış sosyal durum gelmedi')), 2000)
    client.on('social:state', (state) => {
      clearTimeout(timer)
      resolve(state)
    })
  })
  await new Promise((resolve) => client.once('connect', resolve))
  client.emit('social:join', {
    accountId: 'spoofed-account',
    deviceId: 'spoofed-device',
    deviceRole: 'desktop',
    profile: profile('spoofed-account', 'Sahte Kullanıcı', 'desktop'),
  })
  const state = await statePromise

  assert.equal(state.currentUser.id, verifiedIdentity.accountId)
  assert.equal(state.currentUser.displayName, verifiedIdentity.displayName)
  assert.equal(state.currentUser.handle, verifiedIdentity.handle)
  assert.equal(state.currentUser.avatarUrl, verifiedIdentity.avatarUrl)
  assert.equal(state.companionConnected, true)
})

test('socket olay hız sınırı tepki spamini keser ve istemciyi bilgilendirir', async (context) => {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const abuseEvents = []
  const hub = createSocialHub(io, { onAbuse: (event) => abuseEvents.push(event) })
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  const url = `http://127.0.0.1:${address.port}`
  const sender = createClient(url, { autoConnect: false, transports: ['websocket'] })
  const target = createClient(url, { autoConnect: false, transports: ['websocket'] })
  context.after(async () => {
    sender.disconnect()
    target.disconnect()
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })
  const connected = Promise.all([
    new Promise((resolve) => sender.once('connect', resolve)),
    new Promise((resolve) => target.once('connect', resolve)),
  ])
  sender.connect()
  target.connect()
  await connected
  sender.emit('social:join', {
    accountId: 'rate-a',
    deviceId: 'rate-a-device',
    deviceRole: 'desktop',
    profile: profile('rate-a', 'Rate A', 'desktop'),
  })
  target.emit('social:join', {
    accountId: 'rate-b',
    deviceId: 'rate-b-device',
    deviceRole: 'desktop',
    profile: profile('rate-b', 'Rate B', 'desktop'),
  })

  const messageLimited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mesaj hız sınırı çalışmadı')), 2_000)
    sender.on('social:error', (error) => {
      if (error.code !== 'rate_limited' || error.event !== 'message') return
      clearTimeout(timer)
      resolve(error)
    })
  })
  for (let index = 0; index < 21; index += 1) {
    sender.emit('social:message', {
      targetUserId: 'rate-b',
      text: `Hız sınırı ${index}`,
      clientMessageId: `50000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    })
  }
  const messageError = await messageLimited
  assert.equal(messageError.retryAfter > 0, true)
  assert.equal(abuseEvents.some((event) => event.category === 'socket_event:message'), true)

  const limited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tepki hız sınırı çalışmadı')), 2_000)
    sender.on('social:error', (error) => {
      if (error.code !== 'rate_limited' || error.event !== 'reaction') return
      clearTimeout(timer)
      resolve(error)
    })
  })
  for (let index = 0; index < 31; index += 1) {
    sender.emit('social:reaction', { targetUserId: 'rate-b', reaction: '♥' })
  }
  const error = await limited
  assert.equal(error.retryAfter > 0, true)
  assert.equal(abuseEvents.some((event) => event.category === 'socket_event:reaction'), true)
})
