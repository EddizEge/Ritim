import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import type { PlayerState, SyncCommand, SyncCommandAck } from '../src/types'

const PORT = Number(process.env.RITIM_PORT || 8787)
const COMMAND_OWNER_TIMEOUT_MS = 30000
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
const commandOwners = new Map<string, {
  commandId: string
  socketId: string
  room: string
  type: string
  timer: NodeJS.Timeout
}>()
let fallbackCommandSequence = 0

function safeRoom(value: unknown) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// Socket.IO hands handlers any JSON value a peer sends. Destructuring null or a
// primitive would throw an uncaught exception and stop the server.
function objectPayload(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
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
  socket.on('room:join', (payload: unknown) => {
    const { room, role, state } = objectPayload(payload)
    const normalizedRoom = safeRoom(room)
    if (!normalizedRoom) return
    const normalizedRole = role === 'companion' ? 'companion' : 'desktop'
    socket.join(normalizedRoom)
    socket.data.room = normalizedRoom
    socket.data.role = normalizedRole

    const existing = rooms.get(normalizedRoom)
    if (!existing && normalizedRole === 'desktop') {
      const initialState = objectPayload(state) as Partial<PlayerState>
      const revision = Math.max(0, Number(initialState.syncRevision) || 0)
      rooms.set(normalizedRoom, {
        state: { ...initialState, syncRevision: revision, syncedAt: Date.now() } as PlayerState,
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

  socket.on('room:request-state', (payload: unknown) => {
    const { room } = objectPayload(payload)
    const normalizedRoom = safeRoom(room)
    if (!normalizedRoom || socket.data.room !== normalizedRoom) return
    const record = rooms.get(normalizedRoom)
    if (record) socket.emit('player:state', record.state)
    socket.emit('room:status', roomStatus(normalizedRoom))
  })

  socket.on('player:update', (payload: unknown) => {
    const { room, state } = objectPayload(payload)
    const normalizedRoom = safeRoom(room)
    if (!normalizedRoom || socket.data.room !== normalizedRoom || socket.data.role !== 'desktop') return
    if (!isPlainObject(state)) return
    const previous = rooms.get(normalizedRoom)
    const revision = (previous?.revision || 0) + 1
    const authoritativeState = { ...(state as Partial<PlayerState>), syncRevision: revision, syncedAt: Date.now() } as PlayerState
    rooms.set(normalizedRoom, { state: authoritativeState, revision, desktopSocketId: socket.id })
    socket.to(normalizedRoom).emit('player:state', authoritativeState)
  })

  socket.on('player:command', (payload: unknown) => {
    const { room, command } = objectPayload(payload)
    const normalizedRoom = safeRoom(room)
    if (!normalizedRoom || socket.data.room !== normalizedRoom || socket.data.role !== 'companion') return
    const normalizedCommand = normalizeCommand(isPlainObject(command) ? command as Partial<SyncCommand> : undefined)
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
    const commandOwnerKey = `${normalizedRoom}\u0000${normalizedCommand.id}`
    const existingOwner = commandOwners.get(commandOwnerKey)
    if (existingOwner) clearTimeout(existingOwner.timer)
    const timer = setTimeout(() => commandOwners.delete(commandOwnerKey), COMMAND_OWNER_TIMEOUT_MS)
    commandOwners.set(commandOwnerKey, {
      commandId: normalizedCommand.id,
      socketId: socket.id,
      room: normalizedRoom,
      type: normalizedCommand.type,
      timer,
    })
    desktop.emit('player:command', normalizedCommand)
  })

  socket.on('player:command:ack', (ack: SyncCommandAck) => {
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
        const ack: SyncCommandAck = {
          id: owner.commandId,
          type: owner.type,
          status: 'failed',
          message: 'Ritim PC bağlantısı kesildi',
          appliedAt: Date.now(),
        }
        io.to(owner.socketId).emit('player:command:ack', ack)
      }
    }
    const room = socket.data.room as string | undefined
    if (!room) return
    const record = rooms.get(room)
    if (record?.desktopSocketId === socket.id) {
      const replacement = socketsInRoom(room).find((peer) => peer?.data.role === 'desktop')
      record.desktopSocketId = replacement?.id || ''
    }
    emitRoomStatus(room)
    if (socketsInRoom(room).length === 0) rooms.delete(room)
  })
})

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Ritim Sync V2] http://0.0.0.0:${PORT}`)
})
