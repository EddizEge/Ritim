const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { createServer } = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Server } = require('socket.io')
const { io: createClient } = require('socket.io-client')
const { createSocialHub } = require('../electron/social-hub.cjs')
const { startSyncServer } = require('../electron/sync-server.cjs')

// Socket.IO delivers whatever JSON value a client sends. Every one of these must
// be ignored safely: a single uncaught exception would stop the social gateway
// process or the Electron main process for everyone.
const MALFORMED_PAYLOADS = [null, 42, 'metin', ['dizi'], true]

const SYNC_EVENTS = ['room:join', 'room:request-state', 'player:update', 'player:command', 'player:command:ack']

const SOCIAL_EVENTS = [
  'social:join',
  'social:profile',
  'social:message',
  'social:message-reaction',
  'social:notifications-read',
  'social:notification-preferences',
  'social:mute',
  'social:report',
  'social:request-response',
  'social:reaction',
  'social:read',
  'social:listening',
  'social:room-membership',
  'social:create-room',
  'social:room-message',
  'social:room-reaction',
  'social:room-playback:update',
  'social:clock:ping',
  'social:room-playback:result',
  'social:privacy',
  'social:block',
]

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function waitForEvent(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent)
      reject(new Error(`${event} olayı zamanında gelmedi`))
    }, timeoutMs)
    const onEvent = (payload) => {
      clearTimeout(timer)
      resolve(payload)
    }
    socket.once(event, onEvent)
  })
}

async function connectClient(baseUrl) {
  const socket = createClient(baseUrl, { forceNew: true, reconnection: false, transports: ['websocket'] })
  if (!socket.connected) await waitForEvent(socket, 'connect')
  return socket
}

test('Sync V2 bozuk olay yüklerini yok sayar ve normal komut akışını sürdürür', async (context) => {
  const distPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-sync-malformed-'))
  await fs.writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>Ritim test</title>')
  const pairingToken = 'malformed_payload_pairing_token_1234567890'
  const server = startSyncServer(distPath, 0, { pairingToken })
  await new Promise((resolve) => server.once('listening', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const sockets = []

  context.after(async () => {
    for (const socket of sockets) socket.close()
    await server.io.close()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(distPath, { recursive: true, force: true })
  })

  const attacker = await connectClient(baseUrl)
  sockets.push(attacker)
  for (const event of SYNC_EVENTS) {
    attacker.emit(event)
    for (const payload of MALFORMED_PAYLOADS) attacker.emit(event, payload)
  }
  // A well-formed envelope with malformed inner values must not leak garbage
  // state to phones either.
  attacker.emit('room:join', { room: 'ATTACK-ROOM', role: 'desktop', state: 'metin' })
  attacker.emit('player:update', { room: 'ATTACK-ROOM', state: 42 })
  await delay(150)

  const desktop = await connectClient(baseUrl)
  const companion = await connectClient(baseUrl)
  sockets.push(desktop, companion)
  const desktopJoined = waitForEvent(desktop, 'room:status')
  desktop.emit('room:join', { room: 'MALFORMED-ROOM', role: 'desktop', state: { syncRevision: 0, trackId: 'ilk' } })
  await desktopJoined
  const companionState = waitForEvent(companion, 'player:state')
  companion.emit('room:join', { room: 'MALFORMED-ROOM', role: 'companion', token: pairingToken })
  assert.equal((await companionState).trackId, 'ilk')

  const command = { id: 'malformed-flow-command', type: 'togglePlay', issuedAt: Date.now() }
  const commandAtDesktop = waitForEvent(desktop, 'player:command')
  companion.emit('player:command', { room: 'MALFORMED-ROOM', command })
  assert.deepEqual(await commandAtDesktop, command)
  const ackAtCompanion = waitForEvent(companion, 'player:command:ack')
  desktop.emit('player:command:ack', { id: command.id, type: command.type, status: 'applied', appliedAt: Date.now() })
  assert.equal((await ackAtCompanion).status, 'applied')

  const observer = await connectClient(baseUrl)
  sockets.push(observer)
  const attackRoomState = new Promise((resolve) => {
    observer.once('player:state', resolve)
    setTimeout(() => resolve(null), 300)
  })
  observer.emit('room:join', { room: 'ATTACK-ROOM', role: 'companion', token: pairingToken })
  const leaked = await attackRoomState
  assert.ok(leaked === null || typeof leaked === 'object', 'telefon yalnızca nesne durum almalı')
  assert.ok(leaked === null || !Object.prototype.hasOwnProperty.call(leaked, '0'), 'metin durum karakter karakter yayılmamalı')
})

test('Sosyal hub bozuk olay yüklerini yok sayar ve saat ölçümüne yanıt vermeyi sürdürür', async (context) => {
  context.mock.method(console, 'error', () => {})
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io)
  io.on('connection', (socket) => hub.attach(socket))
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${httpServer.address().port}`
  const sockets = []

  context.after(async () => {
    for (const socket of sockets) socket.close()
    hub.close?.()
    await io.close()
  })

  const attacker = await connectClient(baseUrl)
  sockets.push(attacker)
  for (const event of SOCIAL_EVENTS) {
    attacker.emit(event)
    for (const payload of MALFORMED_PAYLOADS) {
      attacker.emit(event, payload)
      attacker.emit(event, payload, () => {})
    }
  }
  await delay(200)

  const client = await connectClient(baseUrl)
  sockets.push(client)
  const joined = waitForEvent(client, 'social:state')
  client.emit('social:join', {
    accountId: 'malformed-payload-account',
    deviceId: 'malformed-payload-desktop',
    deviceRole: 'desktop',
    profile: { displayName: 'Bozuk Yük Testi' },
  })
  await joined

  const ack = await new Promise((resolve) => {
    client.emit('social:clock:ping', { requestId: 'saat-1', clientSentAtMs: 1234 }, resolve)
  })
  assert.equal(ack.ok, true)
  assert.equal(ack.requestId, 'saat-1')
  assert.equal(ack.clientSentAtMs, 1234)
  assert.ok(Number.isFinite(ack.serverTimeMs))

  const malformedAck = await new Promise((resolve) => {
    client.emit('social:clock:ping', null, resolve)
  })
  assert.equal(malformedAck.ok, true)
  assert.equal(malformedAck.requestId, '')
  assert.equal(malformedAck.clientSentAtMs, 0)
})
