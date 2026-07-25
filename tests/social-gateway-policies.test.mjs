import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { io as createClient } from 'socket.io-client'

if (process.env.RITIM_SOCIAL_LIVE_ADMIN_TEST !== 'true') {
  console.log('RITIM_SOCIAL_LIVE_ADMIN_TEST=true verilmedi; canlı politika testi atlandı.')
  process.exit(0)
}

const serverRoot = path.resolve(process.env.RITIM_SOCIAL_SERVER_ROOT || 'dist-social/server')
const authModule = await import(pathToFileURL(path.join(serverRoot, 'social-auth.js')).href)
const config = authModule.readSocialAuthConfig(process.env)
const pool = new Pool({
  host: process.env.RITIM_DB_HOST,
  port: Number(process.env.RITIM_DB_PORT || 5432),
  database: process.env.RITIM_DB_NAME,
  user: process.env.RITIM_DB_USER,
  password: process.env.RITIM_DB_PASSWORD,
  max: 2,
})
const repository = authModule.createPostgresAuthRepository(pool)
const testIssuer = 'https://ritim.test/alpha2-live'
const runId = crypto.randomUUID()
const fakeGoogleProvider = {
  async exchangeAuthorizationCode() {
    throw new Error('Bu test authorization code kullanmaz.')
  },
  async verifyIdToken(idToken, clientId) {
    return {
      issuer: testIssuer,
      subject: `${runId}-${idToken}`,
      audience: clientId,
      displayName: idToken === 'account-a' ? 'Alpha Canlı A' : 'Alpha Canlı B',
    }
  },
}
const authService = authModule.createSocialAuthService(config, repository, fakeGoogleProvider)
const gatewayUrl = process.env.RITIM_SOCIAL_TEST_URL || 'http://127.0.0.1:8790'
const clientId = config.googleClientIds[0]
const states = new Map()
const clients = []

async function createIdentity(name) {
  return authService.loginWithGoogleIdToken({
    idToken: name,
    clientId,
    deviceKey: `alpha2-live-${runId}-${name}`,
    deviceName: `Alpha2 Live ${name}`,
    deviceRole: 'desktop',
  })
}

async function connect(name, token) {
  const socket = createClient(gatewayUrl, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
    auth: { accessToken: token.accessToken },
  })
  clients.push(socket)
  socket.on('social:state', (state) => states.set(name, state))
  socket.connect()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} bağlantı zaman aşımı`)), 5_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('connect_error', reject)
  })
  socket.emit('social:join', {
    accountId: 'spoofed',
    deviceId: 'spoofed',
    deviceRole: 'companion',
    profile: { displayName: 'Sahte', handle: '@sahte', initials: 'S', avatarTone: 0 },
  })
  return socket
}

async function waitFor(name, predicate, label, timeout = 5_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const state = states.get(name)
    if (state && predicate(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${label} doğrulanamadı.`)
}

try {
  const [tokensA, tokensB] = await Promise.all([
    createIdentity('account-a'),
    createIdentity('account-b'),
  ])
  const [clientA, clientB] = await Promise.all([
    connect('a', tokensA),
    connect('b', tokensB),
  ])
  await waitFor('a', (state) => state.users.length === 1, 'İki hesabın görünürlüğü')

  clientA.emit('social:reaction', { targetUserId: tokensB.user.id, reaction: '🔥' })
  const reacted = await waitFor(
    'a',
    (state) => state.users[0]?.reactionCount === 1,
    'Kalıcı tepki',
  )
  assert.equal(reacted.users[0].lastReaction, '🔥')
  const reactionRows = await pool.query(
    `select count(*)::int as count
     from ritim.reactions reaction
     join ritim.users actor on actor.id = reaction.actor_id
     where actor.oidc_issuer = $1 and actor.oidc_subject like $2`,
    [testIssuer, `${runId}-%`],
  )
  assert.equal(reactionRows.rows[0].count, 1)

  clientB.emit('social:privacy', {
    profileVisibility: 'hidden',
    listeningVisibility: 'hidden',
  })
  await waitFor('a', (state) => state.users.length === 0, 'Gizli profil filtresi')
  clientB.emit('social:privacy', {
    profileVisibility: 'everyone',
    listeningVisibility: 'everyone',
  })
  await waitFor('a', (state) => state.users.length === 1, 'Profil görünürlüğü geri dönüşü')

  clientA.emit('social:message', { targetUserId: tokensB.user.id, text: 'Canlı politika testi' })
  await waitFor(
    'b',
    (state) => state.conversations[tokensA.user.id]?.some((message) => message.text === 'Canlı politika testi'),
    'Kalıcı mesaj',
  )

  clientB.emit('social:block', { targetUserId: tokensA.user.id })
  await waitFor('a', (state) => state.users.length === 0, 'Engellemenin karşı tarafa uygulanması')
  await waitFor('b', (state) => state.users.length === 0, 'Engellemenin engelleyene uygulanması')
  const blockRows = await pool.query(
    `select count(*)::int as count
     from ritim.blocks block
     join ritim.users blocker on blocker.id = block.blocker_id
     where blocker.oidc_issuer = $1 and blocker.oidc_subject like $2`,
    [testIssuer, `${runId}-%`],
  )
  assert.equal(blockRows.rows[0].count, 1)

  console.log(JSON.stringify({
    ok: true,
    checks: ['authenticated_accounts', 'persistent_reaction', 'privacy_filter', 'persistent_message', 'bidirectional_block_filter'],
  }))
} finally {
  for (const client of clients) client.disconnect()
  await pool.query(
    `delete from ritim.conversations
     where id in (
       select member.conversation_id
       from ritim.conversation_members member
       join ritim.users test_user on test_user.id = member.user_id
       where test_user.oidc_issuer = $1 and test_user.oidc_subject like $2
     )`,
    [testIssuer, `${runId}-%`],
  ).catch(() => {})
  await pool.query(
    'delete from ritim.users where oidc_issuer = $1 and oidc_subject like $2',
    [testIssuer, `${runId}-%`],
  ).catch(() => {})
  await pool.end()
}
