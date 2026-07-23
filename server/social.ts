import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { Server } from 'socket.io'

const require = createRequire(import.meta.url)
const { createSocialHub } = require('../electron/social-hub.cjs')
const PORT = Number(process.env.RITIM_SOCIAL_PORT || 8790)

const app = express()
app.use(cors())
app.use(express.json())
app.get('/health', (_request, response) => response.json({
  ok: true,
  service: 'ritim-social',
  protocol: 1,
  persistence: false,
}))

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 100_000,
})
const socialHub = createSocialHub(io)

io.on('connection', (socket) => socialHub.attach(socket))

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[Ritim Social Alpha] http://0.0.0.0:${PORT}`)
})
