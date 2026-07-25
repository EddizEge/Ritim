import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPostgresAuthRepository,
  createSocialAuthService,
  readSocialAuthConfig,
} from '../server/social-auth.js'
import type {
  AuthIdentity,
  CompanionTicketStore,
  GoogleIdentityProvider,
  SocialAuthConfig,
  SocialAuthRepository,
} from '../server/social-auth.js'

const authConfig: SocialAuthConfig = {
  configured: true,
  required: true,
  jwtSecret: 'alpha2-test-secret-that-is-at-least-32-bytes',
  issuer: 'ritim-social-test',
  audience: 'ritim-social-test-clients',
  googleClientIds: ['test-client.apps.googleusercontent.com'],
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 86_400,
}

function createFakeAuthDependencies() {
  let sequence = 1
  let deviceRevoked = false
  const families = new Map<string, {
    revoked: boolean
    records: Map<string, { rotated: boolean; identity: AuthIdentity }>
  }>()
  const sessions = new Map<string, {
    family: ReturnType<typeof families.get> extends infer T ? Exclude<T, undefined> : never
    identity: AuthIdentity
  }>()

  function nextSessionId() {
    const suffix = String(sequence++).padStart(12, '0')
    return `00000000-0000-4000-8000-${suffix}`
  }

  const baseIdentity: AuthIdentity = {
    accountId: '10000000-0000-4000-8000-000000000001',
    deviceId: '20000000-0000-4000-8000-000000000001',
    sessionId: '',
    deviceRole: 'desktop',
    displayName: 'Ediz Ege Mercan',
    handle: '@edizegemercan_test',
    initials: 'EE',
    avatarTone: 2,
  }

  const repository: SocialAuthRepository = {
    async createIdentitySession(_input, tokenHash) {
      const identity = { ...baseIdentity, sessionId: nextSessionId() }
      const family = {
        revoked: false,
        records: new Map([[tokenHash.toString('hex'), { rotated: false, identity }]]),
      }
      families.set(identity.sessionId, family)
      sessions.set(identity.sessionId, { family, identity })
      return identity
    },
    async createCompanionSession(accountId, _input, tokenHash) {
      const identity = {
        ...baseIdentity,
        accountId,
        deviceId: '20000000-0000-4000-8000-000000000002',
        sessionId: nextSessionId(),
        deviceRole: 'companion' as const,
      }
      const family = {
        revoked: false,
        records: new Map([[tokenHash.toString('hex'), { rotated: false, identity }]]),
      }
      families.set(identity.sessionId, family)
      sessions.set(identity.sessionId, { family, identity })
      return identity
    },
    async rotateRefreshSession(tokenHash, nextTokenHash) {
      const key = tokenHash.toString('hex')
      for (const family of families.values()) {
        const record = family.records.get(key)
        if (!record || family.revoked) continue
        if (record.rotated) {
          family.revoked = true
          return { status: 'reused' }
        }
        record.rotated = true
        const identity = { ...record.identity, sessionId: nextSessionId() }
        family.records.set(nextTokenHash.toString('hex'), { rotated: false, identity })
        sessions.set(identity.sessionId, { family, identity })
        return { status: 'ok', identity }
      }
      return { status: 'invalid' }
    },
    async resolveAccessSession(accountId, deviceId, sessionId) {
      const record = sessions.get(sessionId)
      if (
        !record
        || record.family.revoked
        || deviceRevoked
        || record.identity.accountId !== accountId
        || record.identity.deviceId !== deviceId
      ) return null
      const active = [...record.family.records.values()].find(
        (candidate) => candidate.identity.sessionId === sessionId,
      )
      return active && !active.rotated ? record.identity : null
    },
    async revokeSessionFamily(_accountId, sessionId) {
      const record = sessions.get(sessionId)
      if (!record) return false
      record.family.revoked = true
      return true
    },
    async revokeDevice() {
      deviceRevoked = true
      return true
    },
  }

  const google: GoogleIdentityProvider = {
    async exchangeAuthorizationCode() {
      return 'verified-google-id-token'
    },
    async verifyIdToken(_idToken, clientId) {
      return {
        issuer: 'https://accounts.google.com',
        subject: 'google-subject-123',
        audience: clientId,
        displayName: 'Ediz Ege Mercan',
      }
    },
  }

  return { repository, google }
}

function createFakeCompanionTickets(): CompanionTicketStore {
  const tickets = new Map<string, string>()
  let sequence = 0
  return {
    async issue(accountId) {
      const ticket = `ritim_ct1_${String(++sequence).padStart(43, 'a')}`
      tickets.set(ticket, accountId)
      return { ticket, expiresIn: 120 }
    },
    async consume(ticket) {
      const accountId = tickets.get(ticket) || null
      tickets.delete(ticket)
      return accountId
    },
  }
}

const loginInput = {
  clientId: 'test-client.apps.googleusercontent.com',
  idToken: 'google-id-token',
  deviceKey: 'desktop-device-key-1234567890',
  deviceName: 'Ediz PC',
  deviceRole: 'desktop',
}

test('kimlik yapılandırması eksik veya zayıf secret ile açılmaz', () => {
  assert.throws(
    () => readSocialAuthConfig({ RITIM_AUTH_REQUIRED: 'true' }),
    /yapılandırması zorunludur/,
  )
  assert.throws(
    () => readSocialAuthConfig({
      RITIM_AUTH_JWT_SECRET: 'short',
      RITIM_GOOGLE_CLIENT_IDS: 'test.apps.googleusercontent.com',
    }),
    /en az 32 bayt/,
  )
  assert.equal(readSocialAuthConfig({}).configured, false)
})

test('Google kimliği Ritim access ve refresh tokenına çevrilir', async () => {
  const { repository, google } = createFakeAuthDependencies()
  const service = createSocialAuthService(authConfig, repository, google)
  const tokens = await service.loginWithGoogleIdToken(loginInput)

  assert.equal(tokens.tokenType, 'Bearer')
  assert.match(tokens.refreshToken, /^ritim_r1_[A-Za-z0-9_-]{64}$/)
  assert.equal(tokens.user.displayName, 'Ediz Ege Mercan')
  const identity = await service.verifyAccessToken(tokens.accessToken)
  assert.equal(identity.accountId, tokens.user.id)
  assert.equal(identity.deviceId, tokens.device.id)
})

test('refresh token tek kullanımlık döner ve tekrar kullanım aileyi iptal eder', async () => {
  const { repository, google } = createFakeAuthDependencies()
  const service = createSocialAuthService(authConfig, repository, google)
  const first = await service.loginWithGoogleIdToken(loginInput)
  const second = await service.rotateRefreshToken(first.refreshToken)

  assert.notEqual(second.refreshToken, first.refreshToken)
  await assert.rejects(
    service.verifyAccessToken(first.accessToken),
    /iptal edilmiş/,
  )
  await assert.rejects(
    service.rotateRefreshToken(first.refreshToken),
    /tekrar kullanıldı/,
  )
  await assert.rejects(
    service.verifyAccessToken(second.accessToken),
    /iptal edilmiş/,
  )
})

test('cihaz iptali mevcut access tokenını hemen geçersiz kılar', async () => {
  const { repository, google } = createFakeAuthDependencies()
  const service = createSocialAuthService(authConfig, repository, google)
  const tokens = await service.loginWithGoogleIdToken(loginInput)
  const identity = await service.verifyAccessToken(tokens.accessToken)

  assert.equal(await service.revokeCurrentDevice(identity), true)
  await assert.rejects(
    service.verifyAccessToken(tokens.accessToken),
    /iptal edilmiş/,
  )
})

test('PC tek kullanımlık ticket ile telefonu aynı hesaba ekler', async () => {
  const { repository, google } = createFakeAuthDependencies()
  const tickets = createFakeCompanionTickets()
  const service = createSocialAuthService(authConfig, repository, google, tickets)
  const desktopTokens = await service.loginWithGoogleIdToken(loginInput)
  const desktopIdentity = await service.verifyAccessToken(desktopTokens.accessToken)
  const ticket = await service.createCompanionTicket(desktopIdentity)
  const companionTokens = await service.exchangeCompanionTicket({
    ticket: ticket.ticket,
    deviceKey: 'companion-device-key-1234567890',
    deviceName: 'Ediz Telefon',
  })

  assert.equal(companionTokens.user.id, desktopTokens.user.id)
  assert.equal(companionTokens.device.role, 'companion')
  await assert.rejects(
    service.exchangeCompanionTicket({
      ticket: ticket.ticket,
      deviceKey: 'second-companion-key-123456789',
      deviceName: 'İkinci Telefon',
    }),
    /geçersiz veya süresi dolmuş/,
  )
})

test('yeni cihaz oturumu aynı cihazdaki eski oturumları önce iptal eder', async () => {
  const queries: string[] = []
  const client = {
    async query(sql: string) {
      queries.push(sql)
      if (/insert into ritim\.users/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            id: 1,
            account_public_id: '10000000-0000-4000-8000-000000000001',
            display_name: 'Ediz Ege Mercan',
            handle: '@edizegemercan_test',
            initials: 'EE',
            avatar_url: null,
            avatar_tone: 2,
          }],
        }
      }
      if (/insert into ritim\.devices/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            id: 2,
            device_public_id: '20000000-0000-4000-8000-000000000001',
            device_type: 'desktop',
          }],
        }
      }
      if (/insert into ritim\.sessions/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ session_public_id: '30000000-0000-4000-8000-000000000001' }],
        }
      }
      return { rowCount: 0, rows: [] }
    },
    release() {},
  }
  const repository = createPostgresAuthRepository({
    async connect() {
      return client
    },
  } as never)

  await repository.createIdentitySession({
    issuer: 'https://accounts.google.com',
    subject: 'google-subject-123',
    audience: 'test-client.apps.googleusercontent.com',
    displayName: 'Ediz Ege Mercan',
    deviceKey: 'desktop-device-key-1234567890',
    deviceRole: 'desktop',
    deviceName: 'Ritim PC',
  }, Buffer.alloc(32, 1), new Date(Date.now() + 86_400_000))

  const revokeIndex = queries.findIndex((sql) => /update ritim\.sessions[\s\S]*where device_id/i.test(sql))
  const createIndex = queries.findIndex((sql) => /insert into ritim\.sessions/i.test(sql))
  assert.ok(revokeIndex >= 0)
  assert.ok(createIndex > revokeIndex)
})
