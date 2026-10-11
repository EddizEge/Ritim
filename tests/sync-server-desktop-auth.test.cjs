const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { io } = require('socket.io-client')
const { createDesktopKey, desktopSyncUrl, startSyncServer } = require('../electron/sync-server.cjs')

const PAIRING_TOKEN = 'desktop_auth_pairing_token_1234567890123'
const NEW_PAIRING_TOKEN = 'desktop_auth_pairing_token_new_123456789'

function waitForEvent(socket, event, timeoutMs = 2_000) {
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

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return ''
}

async function startServer(context, options) {
  const distPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-sync-desktop-auth-'))
  await fs.writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>Ritim test</title>')
  const server = startSyncServer(distPath, 0, options)
  await new Promise((resolve) => server.once('listening', resolve))
  const sockets = []
  context.after(async () => {
    for (const socket of sockets) socket.close()
    await server.io.close()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(distPath, { recursive: true, force: true })
  })
  const port = server.address().port
  const connect = async (url = `http://127.0.0.1:${port}`, socketOptions = {}) => {
    const socket = io(url, { forceNew: true, reconnection: false, ...socketOptions })
    sockets.push(socket)
    if (!socket.connected) await waitForEvent(socket, 'connect')
    return socket
  }
  return { server, port, baseUrl: `http://127.0.0.1:${port}`, connect }
}

async function joinRejected(socket, payload) {
  const error = waitForEvent(socket, 'pairing:error')
  const disconnected = waitForEvent(socket, 'disconnect')
  socket.emit('room:join', payload)
  const message = await error
  await disconnected
  return message
}

test('masaüstü anahtarı her açılışta rastgele üretilir ve yalnız bağlantı adresine eklenir', () => {
  const first = createDesktopKey()
  const second = createDesktopKey()
  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(first, second)
  const url = new URL(desktopSyncUrl('http://127.0.0.1:8787', first))
  assert.equal(url.origin, 'http://127.0.0.1:8787')
  assert.equal(url.pathname, '/')
  assert.equal(url.searchParams.get('desktopKey'), first)
})

test('anahtarsız loopback desktop reddedilir ve komutları devralamaz', async (context) => {
  const desktopKey = createDesktopKey()
  const logged = []
  for (const method of ['log', 'info', 'warn', 'error']) {
    context.mock.method(console, method, (...args) => { logged.push(args.map(String).join(' ')) })
  }
  const { baseUrl, connect } = await startServer(context, { pairingToken: PAIRING_TOKEN, desktopKey })

  const desktop = await connect(desktopSyncUrl(baseUrl, desktopKey))
  const desktopStatus = waitForEvent(desktop, 'room:status')
  desktop.emit('room:join', { room: 'AUTH-ROOM', role: 'desktop', state: { syncRevision: 0, trackId: 'gercek' } })
  assert.equal((await desktopStatus).desktopOnline, true)

  const withoutKey = await connect()
  assert.match(await joinRejected(withoutKey, { room: 'AUTH-ROOM', role: 'desktop', state: { trackId: 'sahte' } }), /doğrulanamadı/)
  // The phone pairing token is not a desktop credential.
  const withPairingToken = await connect()
  await joinRejected(withPairingToken, { room: 'AUTH-ROOM', role: 'desktop', token: PAIRING_TOKEN })
  const wrongKey = await connect(desktopSyncUrl(baseUrl, createDesktopKey()))
  await joinRejected(wrongKey, { room: 'AUTH-ROOM', role: 'desktop' })
  const missingRole = await connect()
  await joinRejected(missingRole, { room: 'AUTH-ROOM' })

  const companion = await connect()
  const companionState = waitForEvent(companion, 'player:state')
  companion.emit('room:join', { room: 'AUTH-ROOM', role: 'companion', token: PAIRING_TOKEN })
  assert.equal((await companionState).trackId, 'gercek')

  const command = { id: 'auth-command-1', type: 'togglePlay', issuedAt: Date.now() }
  const atDesktop = waitForEvent(desktop, 'player:command')
  companion.emit('player:command', { room: 'AUTH-ROOM', command })
  assert.deepEqual(await atDesktop, command)
  const ack = waitForEvent(companion, 'player:command:ack')
  desktop.emit('player:command:ack', { id: command.id, type: command.type, status: 'applied', appliedAt: Date.now() })
  assert.equal((await ack).status, 'applied')

  assert.equal(logged.some((line) => line.includes(desktopKey)), false, 'masaüstü anahtarı loga yazılmamalı')
})

test('anahtar Socket.IO handshake auth alanıyla da kabul edilir', async (context) => {
  const desktopKey = createDesktopKey()
  const { connect } = await startServer(context, { pairingToken: PAIRING_TOKEN, desktopKey })
  const desktop = await connect(undefined, { auth: { desktopKey } })
  const status = waitForEvent(desktop, 'room:status')
  desktop.emit('room:join', { room: 'AUTH-ROOM', role: 'desktop', state: {} })
  assert.equal((await status).desktopOnline, true)
})

test('anahtar verilmeyen sunucuda hiçbir bağlantı desktop olamaz', async (context) => {
  const { connect } = await startServer(context, { pairingToken: PAIRING_TOKEN })
  const desktop = await connect()
  await joinRejected(desktop, { room: 'AUTH-ROOM', role: 'desktop', state: {} })
})

test('eşleme anahtarı yenilenince LAN soketleri düşer, PC köprüsü bağlı kalır', async (context) => {
  const address = lanAddress()
  if (!address) {
    context.skip('Bu makinede LAN IPv4 adresi yok')
    return
  }
  const desktopKey = createDesktopKey()
  const { server, baseUrl, port, connect } = await startServer(context, { pairingToken: PAIRING_TOKEN, desktopKey })
  const lanUrl = `http://${address}:${port}`

  const desktop = await connect(desktopSyncUrl(baseUrl, desktopKey))
  const desktopStatus = waitForEvent(desktop, 'room:status')
  desktop.emit('room:join', { room: 'ROTATE-ROOM', role: 'desktop', state: { syncRevision: 0 } })
  await desktopStatus

  const lanDesktop = await connect(desktopSyncUrl(lanUrl, desktopKey))
  const lanDesktopStatus = waitForEvent(lanDesktop, 'room:status')
  lanDesktop.emit('room:join', { room: 'ROTATE-ROOM', role: 'desktop', state: {} })
  await lanDesktopStatus
  const lanCompanion = await connect(lanUrl)
  const lanCompanionStatus = waitForEvent(lanCompanion, 'room:status')
  lanCompanion.emit('room:join', { room: 'ROTATE-ROOM', role: 'companion', token: PAIRING_TOKEN })
  await lanCompanionStatus
  const lanIdle = await connect(lanUrl)
  const loopbackCompanion = await connect(baseUrl)
  const loopbackStatus = waitForEvent(loopbackCompanion, 'room:status')
  loopbackCompanion.emit('room:join', { room: 'ROTATE-ROOM', role: 'companion', token: PAIRING_TOKEN })
  await loopbackStatus

  const dropped = [lanDesktop, lanCompanion, lanIdle, loopbackCompanion]
  const disconnects = dropped.map((socket) => waitForEvent(socket, 'disconnect'))
  server.rotatePairingToken(NEW_PAIRING_TOKEN)
  await Promise.all(disconnects)
  for (const socket of dropped) assert.equal(socket.connected, false)
  assert.equal(desktop.connected, true)

  const status = waitForEvent(desktop, 'room:status')
  desktop.emit('room:request-state', { room: 'ROTATE-ROOM' })
  assert.deepEqual(await status, { peerCount: 1, desktopOnline: true, companionCount: 0, protocol: 2 })

  const oldTokenPhone = await connect(lanUrl)
  await joinRejected(oldTokenPhone, { room: 'ROTATE-ROOM', role: 'companion', token: PAIRING_TOKEN })
  const newTokenPhone = await connect(lanUrl)
  const newTokenStatus = waitForEvent(newTokenPhone, 'room:status')
  newTokenPhone.emit('room:join', { room: 'ROTATE-ROOM', role: 'companion', token: NEW_PAIRING_TOKEN })
  assert.equal((await newTokenStatus).desktopOnline, true)
})
