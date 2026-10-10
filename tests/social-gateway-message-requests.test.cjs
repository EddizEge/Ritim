const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const test = require('node:test')
const { io: createClient } = require('socket.io-client')

// Opt-in end-to-end check against a gateway backed by real PostgreSQL and
// Redis (for example temporary containers), started with
// RITIM_AUTH_REQUIRED=false so the test can use tokenless legacy accounts.
// Beta 1 shipped without UPDATE on ritim.messages, so rejecting a message
// request and reacting to a message failed only in PostgreSQL mode.
const gatewayUrl = process.env.RITIM_SOCIAL_TEST_URL
const runId = crypto.randomUUID().slice(0, 8)

async function connect(displayName, states) {
  const client = createClient(gatewayUrl, { autoConnect: false, transports: ['websocket'], reconnection: false })
  client.on('social:state', (state) => states.set(displayName, state))
  client.connect()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${displayName} gateway bağlantı zaman aşımı`)), 5_000)
    client.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    client.once('connect_error', reject)
  })
  const accountId = `beta2-${runId}-${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  client.emit('social:join', {
    accountId,
    deviceId: `${accountId}-desktop`,
    deviceRole: 'desktop',
    profile: { displayName, handle: `@${accountId.replace(/-/g, '_').slice(0, 30)}`, initials: 'B2', avatarTone: 1 },
  })
  return client
}

async function waitForState(states, name, predicate, timeout = 6_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const state = states.get(name)
    if (state && predicate(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const last = states.get(name)
  const summary = last ? {
    users: last.users.map((user) => user.displayName),
    messageRequests: last.messageRequests.map((request) => `${request.direction}:${request.userId}`),
    conversations: Object.fromEntries(Object.entries(last.conversations).map(([id, messages]) => [id, messages.length])),
  } : null
  throw new Error(`${name} için beklenen sosyal durum gelmedi; son durum: ${JSON.stringify(summary)}`)
}

async function userIdOf(states, viewer, displayName) {
  const state = await waitForState(states, viewer, (candidate) => candidate.users.some((user) => user.displayName === displayName))
  return state.users.find((user) => user.displayName === displayName).id
}

function sendMessage(client, targetUserId, text) {
  return new Promise((resolve) => {
    client.emit('social:message', { targetUserId, text, clientMessageId: crypto.randomUUID() }, resolve)
  })
}

test('PostgreSQL modunda mesaj isteği reddedilir ve gönderen yeniden yazamaz', { skip: !gatewayUrl }, async (context) => {
  const states = new Map()
  const senderName = `Beta2 Gönderen ${runId}`
  const recipientName = `Beta2 Alıcı ${runId}`
  const sender = await connect(senderName, states)
  const recipient = await connect(recipientName, states)
  context.after(() => {
    sender.disconnect()
    recipient.disconnect()
  })

  const recipientId = await userIdOf(states, senderName, recipientName)
  const senderId = await userIdOf(states, recipientName, senderName)
  assert.equal((await sendMessage(sender, recipientId, 'Tanışalım mı?')).ok, true)
  await waitForState(states, recipientName, (state) => (
    state.messageRequests[0]?.direction === 'incoming' && state.messageRequests[0]?.userId === senderId
  ))

  recipient.emit('social:request-response', { requesterUserId: senderId, action: 'reject' })
  await waitForState(states, recipientName, (state) => (
    state.messageRequests.length === 0 && (state.conversations[senderId]?.length || 0) === 0
  ))

  const retry = await sendMessage(sender, recipientId, 'Tekrar deneme')
  assert.equal(retry.ok, false)
  assert.equal(retry.code, 'message_request_rejected')
})

test('PostgreSQL modunda kabul edilen konuşmadaki mesaja tepki verilir', { skip: !gatewayUrl }, async (context) => {
  const states = new Map()
  const authorName = `Beta2 Yazar ${runId}`
  const reactorName = `Beta2 Tepkici ${runId}`
  const author = await connect(authorName, states)
  const reactor = await connect(reactorName, states)
  context.after(() => {
    author.disconnect()
    reactor.disconnect()
  })

  const reactorId = await userIdOf(states, authorName, reactorName)
  const authorId = await userIdOf(states, reactorName, authorName)
  assert.equal((await sendMessage(author, reactorId, 'Merhaba')).ok, true)
  await waitForState(states, reactorName, (state) => state.messageRequests[0]?.userId === authorId)
  reactor.emit('social:request-response', { requesterUserId: authorId, action: 'accept' })
  await waitForState(states, reactorName, (state) => state.messageRequests.length === 0)

  assert.equal((await sendMessage(author, reactorId, 'Bu şarkıyı dinle')).ok, true)
  const withMessage = await waitForState(states, reactorName, (state) => state.conversations[authorId]?.length === 2)
  reactor.emit('social:message-reaction', {
    targetUserId: authorId,
    messageId: withMessage.conversations[authorId][1].id,
    reaction: '🔥',
  })
  await waitForState(states, authorName, (state) => (
    state.conversations[reactorId]?.[1]?.reactions?.some((reaction) => reaction.reaction === '🔥')
  ))
})

function ask(client, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} onayı gelmedi`)), 6_000)
    client.emit(event, payload, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

test('PostgreSQL modunda olaylar onay döner ve profil tepkisi bildirimi birleşir', { skip: !gatewayUrl }, async (context) => {
  const states = new Map()
  const senderName = `Beta3 Gönderen ${runId}`
  const recipientName = `Beta3 Alıcı ${runId}`
  const sender = await connect(senderName, states)
  const recipient = await connect(recipientName, states)
  context.after(() => {
    sender.disconnect()
    recipient.disconnect()
  })

  const recipientId = await userIdOf(states, senderName, recipientName)
  const senderId = await userIdOf(states, recipientName, senderName)
  assert.equal((await sendMessage(sender, recipientId, 'Onaylı istek')).ok, true)
  await waitForState(states, recipientName, (state) => state.messageRequests[0]?.userId === senderId)
  assert.deepEqual(
    await ask(recipient, 'social:request-response', { requesterUserId: senderId, action: 'accept' }),
    { ok: true },
  )
  assert.deepEqual(
    await ask(recipient, 'social:request-response', { requesterUserId: senderId, action: 'accept' }),
    { ok: false, code: 'request_not_found' },
  )

  assert.equal((await sendMessage(sender, recipientId, 'Tepki ver')).ok, true)
  const withMessage = await waitForState(states, recipientName, (state) => state.conversations[senderId]?.length === 2)
  assert.deepEqual(await ask(recipient, 'social:message-reaction', {
    targetUserId: senderId,
    messageId: withMessage.conversations[senderId][1].id,
    reaction: '😂',
  }), { ok: true })
  assert.deepEqual(await ask(recipient, 'social:message-reaction', {
    targetUserId: senderId,
    messageId: crypto.randomUUID(),
    reaction: '😂',
  }), { ok: false, code: 'reaction_blocked' })

  assert.deepEqual(await ask(sender, 'social:reaction', { targetUserId: recipientId, reaction: '🔥' }), { ok: true })
  assert.deepEqual(await ask(sender, 'social:reaction', { targetUserId: recipientId, reaction: '♥' }), { ok: true })
  const notified = await waitForState(states, recipientName, (state) => (
    state.notifications.some((item) => item.kind === 'profile_reaction' && item.body === '♥')
  ))
  const profileReactions = notified.notifications.filter((item) => item.kind === 'profile_reaction')
  assert.equal(profileReactions.length, 1, 'okunmamış profil tepkisi tek satırda birleşir')
  assert.equal(profileReactions[0].actorId, senderId)
  assert.equal(profileReactions[0].messageId, undefined)

  assert.deepEqual(await ask(recipient, 'social:block', { targetUserId: senderId }), { ok: true })
  assert.deepEqual(
    await ask(sender, 'social:reaction', { targetUserId: recipientId, reaction: '👍' }),
    { ok: false, code: 'reaction_blocked' },
  )
})
