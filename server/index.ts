import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import type { PlayerState } from '../src/types'

const PORT = Number(process.env.RITIM_PORT || 8787)
const app = express()
app.use(cors())
app.use(express.json())
app.get('/health', (_request, response) => response.json({ ok: true, service: 'ritim-sync' }))

const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: true, credentials: true } })
const rooms = new Map<string, PlayerState>()

function peerCount(room: string) {
  return io.sockets.adapter.rooms.get(room)?.size || 0
}

io.on('connection', (socket) => {
  socket.on('room:join', ({ room, state }: { room: string; role: string; state: PlayerState }) => {
    const safeRoom = String(room).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24)
    if (!safeRoom) return
    socket.join(safeRoom)
    socket.data.room = safeRoom
    if (!rooms.has(safeRoom)) rooms.set(safeRoom, state)
    socket.emit('player:state', rooms.get(safeRoom))
    io.to(safeRoom).emit('room:peers', peerCount(safeRoom))
  })

  socket.on('player:update', ({ room, state }: { room: string; state: PlayerState }) => {
    const safeRoom = String(room).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24)
    if (!safeRoom || socket.data.room !== safeRoom) return
    rooms.set(safeRoom, state)
    socket.to(safeRoom).emit('player:state', state)
  })

  socket.on('player:command', ({ room, command }: { room: string; command: { type: string; value?: number | string } }) => {
    const safeRoom = String(room).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24)
    if (!safeRoom || socket.data.room !== safeRoom) return
    socket.to(safeRoom).emit('player:command', command)
  })

  socket.on('disconnect', () => {
    const room = socket.data.room as string | undefined
    if (!room) return
    io.to(room).emit('room:peers', peerCount(room))
    if (peerCount(room) === 0) rooms.delete(room)
  })
})

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Ritim Sync] http://0.0.0.0:${PORT}`)
})
