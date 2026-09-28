const express = require('express')
const cors = require('cors')
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

function startSyncServer(distPath, port = 8787, {
  pairingToken = '',
  getSocialCompanionTicket,
  commandOwnerTimeoutMs = 30000,
} = {}) {
  let currentPairingToken = String(pairingToken || '')
  const app = express()
  app.use(cors({
    origin: true,
    allowedHeaders: ['content-type', 'authorization', 'x-ritim-pairing-token'],
  }))
  app.use(express.json({ limit: '8kb' }))
  app.use(express.static(distPath))
  app.get('/health', (_request, response) => response.json({ ok: true, service: 'ritim-sync', protocol: 2 }))
  // This retired endpoint used to expose the pairing secret to any web page
  // able to reach localhost. Pairing data is now revealed only through the
  // consent-gated Electron settings IPC flow.
  app.get('/pairing', (_request, response) => response.status(404).end())
  app.post('/social/session-ticket', async (request, response) => {
    const authorization = String(request.headers.authorization || '')
    const suppliedToken = authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : request.headers['x-ritim-pairing-token']
    if (!currentPairingToken || !safeEqual(suppliedToken, currentPairingToken)) {
      return response.status(401).json({ ok: false, message: 'Telefon eşleme anahtarı geçersiz.' })
    }
    if (typeof getSocialCompanionTicket !== 'function') {
      return response.status(503).json({ ok: false, message: 'PC sosyal hesabı henüz hazır değil.' })
    }
    try {
      return response.json(await getSocialCompanionTicket())
    } catch (error) {
      return response.status(503).json({
        ok: false,
        message: error?.message || 'Telefon sosyal oturumu hazırlanamadı.',
      })
    }
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
      const normalizedRole = role === 'companion' ? 'companion' : 'desktop'
      const tokenRequired = currentPairingToken && (normalizedRole === 'companion' || !isLoopback(remoteAddress))
      if (tokenRequired && !safeEqual(token, currentPairingToken)) {
        socket.emit('pairing:error', 'Bu QR kodun süresi dolmuş. PC’den yeni QR kodu tara.')
        socket.disconnect(true)
        return
      }
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
      const commandOwnerKey = `${normalizedRoom}\u0000${normalizedCommand.id}`
      const existingOwner = commandOwners.get(commandOwnerKey)
      if (existingOwner) clearTimeout(existingOwner.timer)
      const timer = setTimeout(() => commandOwners.delete(commandOwnerKey), commandOwnerTimeoutMs)
      commandOwners.set(commandOwnerKey, {
        commandId: normalizedCommand.id,
        socketId: socket.id,
        room: normalizedRoom,
        type: normalizedCommand.type,
        timer,
      })
      desktop.emit('player:command', normalizedCommand)
    })

    socket.on('player:command:ack', (ack) => {
      if (socket.data.role !== 'desktop' || !ack?.id) return
      const commandOwnerKey = `${socket.data.room || ''}\u0000${String(ack.id)}`
      const owner = commandOwners.get(commandOwnerKey)
      commandOwners.delete(commandOwnerKey)
      if (owner) {
        clearTimeout(owner.timer)
        io.to(owner.socketId).emit('player:command:ack', ack)
      }
    })

    socket.on('disconnect', () => {
      for (const [commandOwnerKey, owner] of commandOwners) {
        const companionDisconnected = owner.socketId === socket.id
        const desktopDisconnected = socket.data.role === 'desktop' && owner.room === socket.data.room
        if (!companionDisconnected && !desktopDisconnected) continue
        clearTimeout(owner.timer)
        commandOwners.delete(commandOwnerKey)
        if (desktopDisconnected) {
          io.to(owner.socketId).emit('player:command:ack', {
            id: owner.commandId,
            type: owner.type,
            status: 'failed',
            message: 'Ritim PC bağlantısı kesildi',
            appliedAt: Date.now(),
          })
        }
      }
      const room = socket.data.room
      if (!room) return
      const record = rooms.get(room)
      if (record?.desktopSocketId === socket.id) {
        const replacement = socketsInRoom(room).find((peer) => peer.data.role === 'desktop')
        record.desktopSocketId = replacement?.id || ''
      }
      emitRoomStatus(room)
      if (socketsInRoom(room).length === 0) rooms.delete(room)
    })
  })

  server.listen(port, '0.0.0.0', () => console.log(`[Ritim Sync V2] Telefon arayuzu: http://0.0.0.0:${port}/?companion=1`))
  server.io = io
  server.pairingToken = currentPairingToken
  server.rotatePairingToken = (nextToken) => {
    const normalizedToken = String(nextToken || '').trim()
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(normalizedToken)) {
      throw new Error('Geçerli bir telefon eşleme anahtarı gerekli.')
    }
    currentPairingToken = normalizedToken
    server.pairingToken = currentPairingToken
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.role !== 'companion') continue
      socket.emit('pairing:error', 'PC eşleme anahtarını yeniledi. Yeni QR kodu tara.')
      socket.disconnect(true)
    }
    return currentPairingToken
  }
  server.commandOwnerTimeoutMs = commandOwnerTimeoutMs
  return server
}

module.exports = { startSyncServer }
