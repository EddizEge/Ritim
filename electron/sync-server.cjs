const express = require('express')
const { createServer } = require('node:http')
const crypto = require('node:crypto')
const path = require('node:path')
const { Server } = require('socket.io')

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function startSyncServer(distPath, port = 8787, { pairingToken = '' } = {}) {
  const app = express()
  app.use(express.static(distPath))
  app.get('/health', (_request, response) => response.json({ ok: true, service: 'ritim-sync' }))
  app.get('/pairing', (request, response) => {
    if (!isLoopback(request.socket.remoteAddress)) return response.status(404).end()
    return response.json({ token: pairingToken })
  })
  app.use((_request, response) => response.sendFile(path.join(distPath, 'index.html')))

  const server = createServer(app)
  const io = new Server(server, { cors: { origin: true, credentials: true } })
  const rooms = new Map()
  const count = (room) => io.sockets.adapter.rooms.get(room)?.size || 0

  io.on('connection', (socket) => {
    socket.on('room:join', ({ room, role, state, token }) => {
      const safeRoom = String(room).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24)
      if (!safeRoom) return
      const remoteAddress = socket.handshake.address
      if (pairingToken && !isLoopback(remoteAddress) && !safeEqual(token, pairingToken)) {
        socket.emit('pairing:error', 'Bu QR kodun süresi dolmuş. PC’den yeni QR kodu tara.')
        return
      }
      socket.join(safeRoom)
      socket.data.room = safeRoom
      socket.data.role = role === 'companion' ? 'companion' : 'desktop'
      socket.data.authenticated = true
      if (!rooms.has(safeRoom)) rooms.set(safeRoom, state)
      socket.emit('player:state', rooms.get(safeRoom))
      io.to(safeRoom).emit('room:peers', count(safeRoom))
    })
    socket.on('player:update', ({ room, state }) => {
      if (socket.data.room !== room) return
      rooms.set(room, state)
      socket.to(room).emit('player:state', state)
    })
    socket.on('player:command', ({ room, command }) => {
      if (socket.data.room !== room) return
      socket.to(room).emit('player:command', command)
    })
    socket.on('disconnect', () => {
      const room = socket.data.room
      if (!room) return
      io.to(room).emit('room:peers', count(room))
      if (count(room) === 0) rooms.delete(room)
    })
  })

  server.listen(port, '0.0.0.0', () => console.log(`[Ritim] Telefon arayuzu: http://0.0.0.0:${port}/?companion=1`))
  server.io = io
  server.pairingToken = pairingToken
  return server
}

module.exports = { startSyncServer }
