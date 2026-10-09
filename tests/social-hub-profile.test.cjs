const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const test = require('node:test')
const { Server } = require('socket.io')
const { io: createClient } = require('socket.io-client')
const {
  createSocialHub,
  handleFromDisplayName,
  initialsFromDisplayName,
} = require('../electron/social-hub.cjs')

test('baş harfler ilk iki kelimeden Türkçe büyük harfle türetilir', () => {
  assert.equal(initialsFromDisplayName('Ediz Ege Mercan'), 'EE')
  assert.equal(initialsFromDisplayName('ışık'), 'I')
  assert.equal(initialsFromDisplayName('  ilknur   çelik '), 'İÇ')
  assert.equal(initialsFromDisplayName('🎵 Müzik Sever'), 'MS')
  assert.equal(initialsFromDisplayName('Ali 2'), 'A2')
  assert.equal(initialsFromDisplayName(''), '')
})

test('kullanıcı adı Türkçe harfler sadeleştirilmiş küçük harf ve rakamdan oluşur', () => {
  assert.equal(handleFromDisplayName('Ediz Ege Mercan'), '@edizegemercan')
  assert.equal(handleFromDisplayName('Şükrü Işık'), '@sukruisik')
  assert.equal(handleFromDisplayName('İsmail Çağrı Öztürk 34'), '@ismailcagriozturk34')
  assert.equal(handleFromDisplayName('ĞÜŞİÖÇ'), '@gusioc')
  assert.equal(handleFromDisplayName('Ольга'), '', 'ASCII karşılığı yoksa boş döner')
  assert.equal(handleFromDisplayName('a'.repeat(80)).length, 31)
})

async function joinAndReadState(context, { identity, profile }) {
  const httpServer = createServer()
  const io = new Server(httpServer, { cors: { origin: true } })
  const hub = createSocialHub(io)
  io.on('connection', (socket) => {
    if (identity) socket.data.socialIdentity = identity
    hub.attach(socket)
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const client = createClient(`http://127.0.0.1:${httpServer.address().port}`, {
    transports: ['websocket'],
    reconnection: false,
  })
  context.after(async () => {
    client.disconnect()
    hub.close()
    await io.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })
  await new Promise((resolve) => client.once('connect', resolve))
  const state = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sosyal durum gelmedi')), 2_000)
    client.once('social:state', (value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
  client.emit('social:join', {
    accountId: 'profile-derivation-account',
    deviceId: 'profile-derivation-device',
    deviceRole: 'desktop',
    profile,
  })
  return state
}

test('boş handle ve baş harf görünen addan türetilir, sabit "@ritim"/"R" kalmaz', async (context) => {
  const state = await joinAndReadState(context, {
    profile: { displayName: 'Şükrü Işık', handle: '', initials: '', avatarTone: 3 },
  })
  assert.equal(state.currentUser.handle, '@sukruisik')
  assert.equal(state.currentUser.initials, 'ŞI')
})

test('türetilemeyen ad yedek "@ritim" ve "R" değerlerine düşer', async (context) => {
  const fallback = await joinAndReadState(context, { profile: { displayName: '🎵🎵' } })
  assert.equal(fallback.currentUser.handle, '@ritim')
  assert.equal(fallback.currentUser.initials, 'R')
})

test('istemcinin kendi handle ve baş harfleri korunur', async (context) => {
  const state = await joinAndReadState(context, {
    profile: { displayName: 'Ediz Ege', handle: '@ediz', initials: 'ed' },
  })
  assert.equal(state.currentUser.handle, '@ediz')
  assert.equal(state.currentUser.initials, 'ED')
})

test('doğrulanmış kimlikte sunucunun handle ve baş harfleri önceliklidir', async (context) => {
  const state = await joinAndReadState(context, {
    identity: {
      accountId: '10000000-0000-4000-8000-0000000000aa',
      deviceId: '20000000-0000-4000-8000-0000000000aa',
      sessionId: '30000000-0000-4000-8000-0000000000aa',
      deviceRole: 'desktop',
      displayName: 'Sunucu Adı',
      handle: '@sunucu_handle_1a2b',
      initials: 'SA',
      avatarTone: 5,
    },
    profile: { displayName: 'İstemci Adı', handle: '@istemci', initials: 'İA' },
  })
  assert.equal(state.currentUser.displayName, 'Sunucu Adı')
  assert.equal(state.currentUser.handle, '@sunucu_handle_1a2b')
  assert.equal(state.currentUser.initials, 'SA')
})
