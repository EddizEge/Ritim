const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const test = require('node:test')
const { Server } = require('socket.io')
const { io: createClient } = require('socket.io-client')
const { createSocialHub } = require('../electron/social-hub.cjs')

async function startHub(context) {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io)
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${httpServer.address().port}`
  const states = new Map()
  const clients = []
  context.after(async () => {
    for (const client of clients) client.disconnect()
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })

  async function connect(accountId) {
    const client = createClient(url, { autoConnect: false, transports: ['websocket'], reconnection: false })
    clients.push(client)
    client.on('social:state', (state) => states.set(accountId, state))
    client.connect()
    await new Promise((resolve) => client.once('connect', resolve))
    client.emit('social:join', {
      accountId,
      deviceId: `${accountId}-desktop`,
      deviceRole: 'desktop',
      profile: { displayName: accountId, avatarTone: 1 },
    })
    return client
  }

  async function waitFor(accountId, predicate, label = 'beklenen durum') {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 2_000) {
      const state = states.get(accountId)
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`${accountId}: ${label} gelmedi`)
  }

  return { connect, waitFor }
}

const ask = (client, event, payload) => new Promise((resolve) => client.emit(event, payload, resolve))
const profileReactions = (state) => state.notifications.filter((item) => item.kind === 'profile_reaction')

async function befriend(waitFor, requester, requesterId, recipient, recipientId) {
  assert.equal((await ask(requester, 'social:message', { targetUserId: recipientId, text: 'Merhaba' })).ok, true)
  await waitFor(recipientId, (state) => state.messageRequests.some((request) => request.userId === requesterId))
  recipient.emit('social:request-response', { requesterUserId: requesterId, action: 'accept' })
  await waitFor(recipientId, (state) => state.messageRequests.length === 0)
}

// Each reaction raises the target's counter even when no notification is
// written, so the counter shows the reaction was processed.
async function react(client, waitFor, targetId, reaction) {
  const before = (await waitFor(targetId, () => true)).currentUser.reactionCount
  client.emit('social:reaction', { targetUserId: targetId, reaction })
  return waitFor(targetId, (state) => state.currentUser.reactionCount > before, `${reaction} tepkisi`)
}

test('profil tepkisi hedefe tek okunmamış bildirim olarak düşer ve tekrarında güncellenir', async (context) => {
  const { connect, waitFor } = await startHub(context)
  const target = await connect('pt-hedef')
  const fan = await connect('pt-hayran')
  await waitFor('pt-hedef', (state) => state.users.length === 1)

  const first = profileReactions(await react(fan, waitFor, 'pt-hedef', '🔥'))
  assert.equal(first.length, 1)
  assert.equal(first[0].actorId, 'pt-hayran')
  assert.equal(first[0].body, '🔥')
  assert.equal(first[0].read, false)
  assert.equal('messageId' in first[0], false, 'profil tepkisinde messageId olmamalı')

  await new Promise((resolve) => setTimeout(resolve, 5))
  const merged = profileReactions(await react(fan, waitFor, 'pt-hedef', '♥'))
  assert.equal(merged.length, 1, 'okunmamış tepki varken yenisi eklenmez')
  assert.equal(merged[0].id, first[0].id)
  assert.equal(merged[0].body, '♥')
  assert.ok(merged[0].createdAt > first[0].createdAt, 'zaman yeni tepkiye göre güncellenir')

  target.emit('social:notifications-read')
  await waitFor('pt-hedef', (state) => state.notifications.every((item) => item.read))
  const afterRead = await react(fan, waitFor, 'pt-hedef', '👍')
  const reactions = profileReactions(afterRead)
  assert.equal(reactions.length, 2, 'okunduktan sonraki tepki yeni bildirimdir')
  assert.equal(afterRead.notifications[0].body, '👍')
  assert.equal(afterRead.notifications[0].read, false)

  const fanState = await waitFor('pt-hayran', () => true)
  assert.equal(profileReactions(fanState).length, 0, 'gönderene bildirim düşmez')
})

test('profil tepkisi bildirimi tepki tercihi ve sessize almaya uyar', async (context) => {
  const { connect, waitFor } = await startHub(context)
  const target = await connect('pt-tercih-hedef')
  const fan = await connect('pt-tercih-hayran')
  const friend = await connect('pt-tercih-arkadas')
  await waitFor('pt-tercih-hedef', (state) => state.users.length === 2)

  target.emit('social:notification-preferences', { messagesEnabled: true, reactionsEnabled: false })
  await waitFor('pt-tercih-hedef', (state) => state.notificationPreferences.reactionsEnabled === false)
  assert.equal(profileReactions(await react(fan, waitFor, 'pt-tercih-hedef', '🔥')).length, 0)

  target.emit('social:notification-preferences', { messagesEnabled: false, reactionsEnabled: true })
  await waitFor('pt-tercih-hedef', (state) => state.notificationPreferences.reactionsEnabled === true)
  assert.equal(
    profileReactions(await react(fan, waitFor, 'pt-tercih-hedef', '🔥')).length,
    1,
    'mesaj bildirimi kapalıyken tepki bildirimi yine düşer',
  )

  await befriend(waitFor, friend, 'pt-tercih-arkadas', target, 'pt-tercih-hedef')
  target.emit('social:mute', { targetUserId: 'pt-tercih-arkadas' })
  await waitFor('pt-tercih-hedef', (state) => state.mutedUserIds.includes('pt-tercih-arkadas'))
  const muted = await react(friend, waitFor, 'pt-tercih-hedef', '♥')
  assert.equal(
    profileReactions(muted).filter((item) => item.actorId === 'pt-tercih-arkadas').length,
    0,
    'sessize alınan kişinin tepkisi bildirim üretmez',
  )
})

test('engel ve profil gizliliği reddettiği tepki için bildirim üretmez', async (context) => {
  const { connect, waitFor } = await startHub(context)
  const target = await connect('pt-gizli-hedef')
  const blocked = await connect('pt-gizli-engelli')
  const stranger = await connect('pt-gizli-yabanci')
  const fan = await connect('pt-gizli-hayran')
  await waitFor('pt-gizli-hedef', (state) => state.users.length === 3)

  target.emit('social:block', { targetUserId: 'pt-gizli-engelli' })
  await waitFor('pt-gizli-engelli', (state) => !state.users.some((user) => user.id === 'pt-gizli-hedef'))
  blocked.emit('social:reaction', { targetUserId: 'pt-gizli-hedef', reaction: '🔥' })

  target.emit('social:privacy', { profileVisibility: 'contacts', listeningVisibility: 'everyone' })
  await waitFor('pt-gizli-yabanci', (state) => !state.users.some((user) => user.id === 'pt-gizli-hedef'))
  stranger.emit('social:reaction', { targetUserId: 'pt-gizli-hedef', reaction: '😂' })

  target.emit('social:privacy', { profileVisibility: 'everyone', listeningVisibility: 'everyone' })
  await waitFor('pt-gizli-hayran', (state) => state.users.some((user) => user.id === 'pt-gizli-hedef'))
  const reacted = await react(fan, waitFor, 'pt-gizli-hedef', '♥')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(reacted.currentUser.reactionCount, 1, 'reddedilen tepkiler sayılmaz')
  assert.deepEqual(
    profileReactions(reacted).map((item) => [item.actorId, item.body]),
    [['pt-gizli-hayran', '♥']],
  )
})

test('profil tepkisi gövdesi yarım emoji bırakmadan kısaltılır', async (context) => {
  const { connect, waitFor } = await startHub(context)
  await connect('pt-uzun-hedef')
  const fan = await connect('pt-uzun-hayran')
  await waitFor('pt-uzun-hedef', (state) => state.users.length === 1)

  // Seven ASCII letters and a surrogate pair: the eighth unit is a high surrogate.
  const reacted = await react(fan, waitFor, 'pt-uzun-hedef', 'abcdefg🔥')
  const [notification] = profileReactions(reacted)
  assert.equal(notification.body, 'abcdefg')
  assert.equal(reacted.currentUser.lastReaction, 'abcdefg')
})
