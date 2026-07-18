import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import type { PlayerState, SyncCommand, SyncCommandAck } from '../src/types'

const PORT = Number(process.env.RITIM_PORT || 8787)
const app = express()
app.use(cors())
app.use(express.json())
app.get('/health', (_request, response) => response.json({ ok: true, service: 'ritim-sync', protocol: 2 }))

const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: true, credentials: true } })

type RoomRecord = {
  state: PlayerState
  revision: number
  desktopSocketId: string
}

const rooms = new Map<string, RoomRecord>()
const commandOwners = new Map<string, string>()
let fallbackCommandSequence = 0

function safeRoom(value: unknown) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24)
}

function socketsInRoom(room: string) {
  const socketIds = io.sockets.adapter.rooms.get(room) || new Set<string>()
  return [...socketIds].map((id) => io.sockets.sockets.get(id)).filter(Boolean)
}

function roomStatus(room: string) {
  const sockets = socketsInRoom(room)
  return {
    peerCount: sockets.length,
    desktopOnline: sockets.some((socket) => socket?.data.role === 'desktop'),
    companionCount: sockets.filter((socket) => socket?.data.role === 'companion').length,
    protocol: 2,
  }
}

function emitRoomStatus(room: string) {
  const status = roomStatus(room)
  io.to(room).emit('room:peers', status.peerCount)
  io.to(room).emit('room:status', status)
}

function normalizeCommand(command: Partial<SyncCommand> | undefined): SyncCommand | null {
  if (!command || typeof command.type !== 'string') return null
  return {
    id: String(command.id || `legacy-${Date.now()}-${++fallbackCommandSequence}`),
    type: command.type,
    value: command.value,
    issuedAt: Number(command.issuedAt) || Date.now(),
  }
}

io.on('connection', (socket) => {
  socket.on('room:join', ({ room, role, state }: { room: string; role: string; state: PlayerState }) => {
    const normalizedRoom = safeRoom(room)
    if (!normalizedRoom) return
    const normalizedRole = role === 'companion' ? 'companion' : 'desktop'
    socket.join(normalizedRoom)
    socket.data.room = normalizedRoom
    socket.data.role = normalizedRole

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

  socket.on('room:request-state', ({ room }: { room: string }) => {
    const normalizedRoom = safeRoom(room)
    if (!normalizedRoom || socket.data.room !== normalizedRoom) return
    const record = rooms.get(normalizedRoom)
    if (record) socket.emit('player:state', record.state)
    socket.emit('room:status', roomStatus(normalizedRoom))
  })

  socket.on('player:update', ({ room, state }: { room: string; state: PlayerState }) => {
    const normalizedRoom = safeRoom(room)
    if (!normalizedRoom || socket.data.room !== normalizedRoom || socket.data.role !== 'desktop') return
    const previous = rooms.get(normalizedRoom)
    const revision = (previous?.revision || 0) + 1
    const authoritativeState = { ...state, syncRevision: revision, syncedAt: Date.now() }
    rooms.set(normalizedRoom, { state: authoritativeState, revision, desktopSocketId: socket.id })
    socket.to(normalizedRoom).emit('player:state', authoritativeState)
  })

  socket.on('player:command', ({ room, command }: { room: string; command: Partial<SyncCommand> }) => {
    const normalizedRoom = safeRoom(room)
    if (!normalizedRoom || socket.data.room !== normalizedRoom || socket.data.role !== 'companion') return
    const normalizedCommand = normalizeCommand(command)
    if (!normalizedCommand) return
    const desktopSocketId = rooms.get(normalizedRoom)?.desktopSocketId
    const desktop = desktopSocketId ? io.sockets.sockets.get(desktopSocketId) : undefined
    if (!desktop || desktop.data.role !== 'desktop') {
      const ack: SyncCommandAck = {
        id: normalizedCommand.id,
        type: normalizedCommand.type,
        status: 'failed',
        message: 'Ritim PC çevrimdışı',
        appliedAt: Date.now(),
      }
      socket.emit('player:command:ack', ack)
      return
    }
    commandOwners.set(normalizedCommand.id, socket.id)
    desktop.emit('player:command', normalizedCommand)
    setTimeout(() => commandOwners.delete(normalizedCommand.id), 15000)
  })

  socket.on('player:command:ack', (ack: SyncCommandAck) => {
    if (socket.data.role !== 'desktop' || !ack?.id) return
    const ownerId = commandOwners.get(String(ack.id))
    commandOwners.delete(String(ack.id))
    if (ownerId) io.to(ownerId).emit('player:command:ack', ack)
  })

  socket.on('disconnect', () => {
    const room = socket.data.room as string | undefined
    if (!room) return
    const record = rooms.get(room)
    if (record?.desktopSocketId === socket.id) {
      const replacement = socketsInRoom(room).find((peer) => peer?.data.role === 'desktop')
      record.desktopSocketId = replacement?.id || ''
    }
    emitRoomStatus(room)
    if (roomStatus(room).peerCount === 0) rooms.delete(room)
  })
})

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Ritim Sync V2] http://0.0.0.0:${PORT}`)
})
