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

function safeRoom(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24)
}

function startSyncServer(distPath, port = 8787, { pairingToken = '' } = {}) {
  const app = express()
  app.use(express.static(distPath))
  app.get('/health', (_request, response) => response.json({ ok: true, service: 'ritim-sync', protocol: 2 }))
  app.get('/pairing', (request, response) => {
    if (!isLoopback(request.socket.remoteAddress)) return response.status(404).end()
    return response.json({ token: pairingToken })
  })
  app.use((_request, response) => response.sendFile(path.join(distPath, 'index.html')))

  const server = createServer(app)
  const io = new Server(server, { cors: { origin: true, credentials: true } })
  const rooms = new Map()
  const commandOwners = new Map()
  let fallbackCommandSequence = 0

  const socketsInRoom = (room) => {
    const socketIds = io.sockets.adapter.rooms.get(room) || new Set()
    return [...socketIds].map((id) => io.sockets.sockets.get(id)).filter(Boolean)
  }
  const roomStatus = (room) => {
    const sockets = socketsInRoom(room)
    return {
      peerCount: sockets.length,
      desktopOnline: sockets.some((socket) => socket.data.role === 'desktop'),
      companionCount: sockets.filter((socket) => socket.data.role === 'companion').length,
      protocol: 2,
    }
  }
  const emitRoomStatus = (room) => {
    const status = roomStatus(room)
    io.to(room).emit('room:peers', status.peerCount)
    io.to(room).emit('room:status', status)
  }
  const normalizeCommand = (command) => {
    if (!command || typeof command.type !== 'string') return null
    return {
      id: String(command.id || `legacy-${Date.now()}-${++fallbackCommandSequence}`),
      type: command.type,
      value: command.value,
      issuedAt: Number(command.issuedAt) || Date.now(),
    }
  }

  io.on('connection', (socket) => {
    socket.on('room:join', ({ room, role, state, token }) => {
      const normalizedRoom = safeRoom(room)
      if (!normalizedRoom) return
      const remoteAddress = socket.handshake.address
      if (pairingToken && !isLoopback(remoteAddress) && !safeEqual(token, pairingToken)) {
        socket.emit('pairing:error', 'Bu QR kodun süresi dolmuş. PC’den yeni QR kodu tara.')
        return
      }
      const normalizedRole = role === 'companion' ? 'companion' : 'desktop'
      socket.join(normalizedRoom)
      socket.data.room = normalizedRoom
      socket.data.role = normalizedRole
      socket.data.authenticated = true

      const existing = rooms.get(normalizedRoom)
      if (!existing && normalizedRole === 'desktop') {
        const revision = Math.max(0, Number(state?.syncRevision) || 0)
        rooms.set(normalizedRoom, {
          state: { ...state, syncRevision: revision, syncedAt: Date.now() },
          revision,
          desktopSocketId: socket.id,
        })
      } else if (existing && normalizedRole === 'desktop') {
        existing.desktopSocketId = socket.id
      }

      const record = rooms.get(normalizedRoom)
      if (record) socket.emit('player:state', record.state)
      emitRoomStatus(normalizedRoom)
    })

    socket.on('room:request-state', ({ room }) => {
      const normalizedRoom = safeRoom(room)
      if (!normalizedRoom || socket.data.room !== normalizedRoom) return
      const record = rooms.get(normalizedRoom)
      if (record) socket.emit('player:state', record.state)
      socket.emit('room:status', roomStatus(normalizedRoom))
    })

    socket.on('player:update', ({ room, state }) => {
      const normalizedRoom = safeRoom(room)
      if (!normalizedRoom || socket.data.room !== normalizedRoom || socket.data.role !== 'desktop') return
      const previous = rooms.get(normalizedRoom)
      const revision = (previous?.revision || 0) + 1
      const authoritativeState = { ...state, syncRevision: revision, syncedAt: Date.now() }
      rooms.set(normalizedRoom, { state: authoritativeState, revision, desktopSocketId: socket.id })
      socket.to(normalizedRoom).emit('player:state', authoritativeState)
    })

    socket.on('player:command', ({ room, command }) => {
      const normalizedRoom = safeRoom(room)
      if (!normalizedRoom || socket.data.room !== normalizedRoom || socket.data.role !== 'companion') return
      const normalizedCommand = normalizeCommand(command)
      if (!normalizedCommand) return
      const desktopSocketId = rooms.get(normalizedRoom)?.desktopSocketId
      const desktop = desktopSocketId ? io.sockets.sockets.get(desktopSocketId) : undefined
      if (!desktop || desktop.data.role !== 'desktop') {
        socket.emit('player:command:ack', {
          id: normalizedCommand.id,
          type: normalizedCommand.type,
          status: 'failed',
          message: 'Ritim PC çevrimdışı',
          appliedAt: Date.now(),
        })
        return
      }
      commandOwners.set(normalizedCommand.id, socket.id)
      desktop.emit('player:command', normalizedCommand)
      setTimeout(() => commandOwners.delete(normalizedCommand.id), 15000)
    })

    socket.on('player:command:ack', (ack) => {
      if (socket.data.role !== 'desktop' || !ack?.id) return
      const ownerId = commandOwners.get(String(ack.id))
      commandOwners.delete(String(ack.id))
      if (ownerId) io.to(ownerId).emit('player:command:ack', ack)
    })

    socket.on('disconnect', () => {
      const room = socket.data.room
      if (!room) return
      const record = rooms.get(room)
      if (record?.desktopSocketId === socket.id) {
        const replacement = socketsInRoom(room).find((peer) => peer.data.role === 'desktop')
        record.desktopSocketId = replacement?.id || ''
      }
      emitRoomStatus(room)
      if (roomStatus(room).peerCount === 0) rooms.delete(room)
    })
  })

  server.listen(port, '0.0.0.0', () => console.log(`[Ritim Sync V2] Telefon arayuzu: http://0.0.0.0:${port}/?companion=1`))
  server.io = io
  server.pairingToken = pairingToken
  return server
}

module.exports = { startSyncServer }
