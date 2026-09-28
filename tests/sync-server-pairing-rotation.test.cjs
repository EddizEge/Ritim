const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { io } = require('socket.io-client')
const { startSyncServer } = require('../electron/sync-server.cjs')

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

async function connectClient(baseUrl) {
  const socket = io(baseUrl, { forceNew: true, reconnection: false })
  if (!socket.connected) await waitForEvent(socket, 'connect')
  return socket
}

test('eşleme anahtarı yenilenince eski telefon düşer, eski anahtar reddedilir ve yenisi çalışır', async (context) => {
  const distPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-pairing-rotation-'))
  await fs.writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>Ritim test</title>')
  const oldToken = 'old_pairing_token_12345678901234567890'
  const newToken = 'new_pairing_token_12345678901234567890'
  const server = startSyncServer(distPath, 0, {
    pairingToken: oldToken,
    async getSocialCompanionTicket() {
      return { ticket: 'ritim_ct1_test-ticket', expiresIn: 120 }
    },
  })
  await new Promise((resolve) => server.once('listening', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const retiredPairingEndpoint = await fetch(`${baseUrl}/pairing`, {
    headers: { origin: 'https://attacker.example' },
  })
  assert.equal(retiredPairingEndpoint.status, 404)
  assert.equal((await retiredPairingEndpoint.text()).includes(oldToken), false)

  const desktop = await connectClient(baseUrl)
  const companion = await connectClient(baseUrl)
  const sockets = [desktop, companion]

  context.after(async () => {
    for (const socket of sockets) socket.close()
    await server.io.close()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(distPath, { recursive: true, force: true })
  })

  const desktopJoined = waitForEvent(desktop, 'room:status')
  desktop.emit('room:join', { room: 'ROTATE-ROOM', role: 'desktop', state: { syncRevision: 0 } })
  await desktopJoined
  const companionJoined = waitForEvent(companion, 'room:status')
  companion.emit('room:join', { room: 'ROTATE-ROOM', role: 'companion', token: oldToken })
  await companionJoined

  const pairingError = waitForEvent(companion, 'pairing:error')
  const disconnected = waitForEvent(companion, 'disconnect')
  assert.equal(server.rotatePairingToken(newToken), newToken)
  assert.match(await pairingError, /yeniledi/i)
  await disconnected
  assert.equal(companion.connected, false)
  assert.equal(desktop.connected, true)

  const oldTicket = await fetch(`${baseUrl}/social/session-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${oldToken}` },
  })
  assert.equal(oldTicket.status, 401)
  const newTicket = await fetch(`${baseUrl}/social/session-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${newToken}` },
  })
  assert.equal(newTicket.status, 200)

  const staleCompanion = await connectClient(baseUrl)
  sockets.push(staleCompanion)
  const staleRejected = waitForEvent(staleCompanion, 'pairing:error')
  const staleDisconnected = waitForEvent(staleCompanion, 'disconnect')
  staleCompanion.emit('room:join', { room: 'ROTATE-ROOM', role: 'companion', token: oldToken })
  assert.match(await staleRejected, /süresi dolmuş/i)
  await staleDisconnected

  const freshCompanion = await connectClient(baseUrl)
  sockets.push(freshCompanion)
  const freshJoined = waitForEvent(freshCompanion, 'room:status')
  freshCompanion.emit('room:join', { room: 'ROTATE-ROOM', role: 'companion', token: newToken })
  const status = await freshJoined
  assert.equal(status.desktopOnline, true)
  assert.equal(status.companionCount, 1)
})
