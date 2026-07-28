const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { io } = require('socket.io-client')
const { startSyncServer } = require('../electron/sync-server.cjs')

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
  const socket = io(baseUrl, { forceNew: true, reconnection: false })
  if (!socket.connected) await waitForEvent(socket, 'connect')
  return socket
}

test('geciken PC komut yanıtı telefonun doğru oturumuna geri iletilir', async (context) => {
  const distPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-sync-reliability-'))
  await fs.writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>Ritim test</title>')
  const server = startSyncServer(distPath, 0)
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const desktop = await connectClient(baseUrl)
  const companion = await connectClient(baseUrl)

  context.after(async () => {
    desktop.close()
    companion.close()
    await server.io.close()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(distPath, { recursive: true, force: true })
  })

  assert.equal(server.commandOwnerTimeoutMs, 30000)
  const desktopJoined = waitForEvent(desktop, 'room:status')
  desktop.emit('room:join', { room: 'TEST-ROOM', role: 'desktop', state: { syncRevision: 0 } })
  await desktopJoined
  const joined = waitForEvent(companion, 'room:status')
  companion.emit('room:join', { room: 'TEST-ROOM', role: 'companion', state: {} })
  await joined

  const command = { id: 'delayed-command-1', type: 'loadMoreBrowse', issuedAt: Date.now() }
  const commandAtDesktop = waitForEvent(desktop, 'player:command')
  companion.emit('player:command', { room: 'TEST-ROOM', command })
  assert.deepEqual(await commandAtDesktop, command)

  const ackAtCompanion = waitForEvent(companion, 'player:command:ack')
  await new Promise((resolve) => setTimeout(resolve, 80))
  desktop.emit('player:command:ack', {
    id: command.id,
    type: command.type,
    status: 'applied',
    appliedAt: Date.now(),
  })
  const ack = await ackAtCompanion
  assert.equal(ack.id, command.id)
  assert.equal(ack.status, 'applied')
})

test('PC çevrimdışıyken komut bekletilmeden başarısız sayılır', async (context) => {
  const distPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-sync-offline-'))
  await fs.writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>Ritim test</title>')
  const server = startSyncServer(distPath, 0)
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  const companion = await connectClient(`http://127.0.0.1:${address.port}`)

  context.after(async () => {
    companion.close()
    await server.io.close()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(distPath, { recursive: true, force: true })
  })

  const joined = waitForEvent(companion, 'room:status')
  companion.emit('room:join', { room: 'OFFLINE-ROOM', role: 'companion', state: {} })
  await joined
  const ackPromise = waitForEvent(companion, 'player:command:ack')
  companion.emit('player:command', {
    room: 'OFFLINE-ROOM',
    command: { id: 'offline-command-1', type: 'togglePlay', issuedAt: Date.now() },
  })
  const ack = await ackPromise
  assert.equal(ack.status, 'failed')
  assert.match(ack.message, /çevrimdışı/)
})

test('komut beklerken PC kapanırsa telefon hemen bilgilendirilir', async (context) => {
  const distPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-sync-disconnect-'))
  await fs.writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>Ritim test</title>')
  const server = startSyncServer(distPath, 0)
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const desktop = await connectClient(baseUrl)
  const companion = await connectClient(baseUrl)

  context.after(async () => {
    desktop.close()
    companion.close()
    await server.io.close()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(distPath, { recursive: true, force: true })
  })

  const desktopJoined = waitForEvent(desktop, 'room:status')
  desktop.emit('room:join', { room: 'DISCONNECT-ROOM', role: 'desktop', state: { syncRevision: 0 } })
  await desktopJoined
  const companionJoined = waitForEvent(companion, 'room:status')
  companion.emit('room:join', { room: 'DISCONNECT-ROOM', role: 'companion', state: {} })
  await companionJoined

  const commandAtDesktop = waitForEvent(desktop, 'player:command')
  companion.emit('player:command', {
    room: 'DISCONNECT-ROOM',
    command: { id: 'disconnect-command-1', type: 'requestLyrics', issuedAt: Date.now() },
  })
  await commandAtDesktop

  const ackAtCompanion = waitForEvent(companion, 'player:command:ack')
  desktop.close()
  const ack = await ackAtCompanion
  assert.equal(ack.status, 'failed')
  assert.match(ack.message, /bağlantısı kesildi/)
})
