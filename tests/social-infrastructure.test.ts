import assert from 'node:assert/strict'
import test from 'node:test'
import { createSocialInfrastructure, readSocialInfrastructureConfig } from '../server/social-infrastructure.js'

test('altyapi ayarlanmadiysa Alpha.1 bellek ici modu hazir kalir', async () => {
  const config = readSocialInfrastructureConfig({})
  const infrastructure = createSocialInfrastructure(config)

  assert.equal(config.required, false)
  assert.equal(config.databasePoolSize, 10)
  assert.deepEqual(infrastructure.health(), {
    configured: false,
    required: false,
    postgres: 'disabled',
    redis: 'disabled',
    durableSocialEvents: false,
  })
  assert.equal(await infrastructure.probe(), true)
  await infrastructure.close()
})

test('PostgreSQL ve Redis adresleri birlikte verilmelidir', () => {
  assert.throws(
    () => readSocialInfrastructureConfig({ RITIM_DATABASE_URL: 'postgresql://example' }),
    /birlikte ayarlanmalıdır/,
  )
  assert.throws(
    () => readSocialInfrastructureConfig({ RITIM_INFRA_REQUIRED: 'true' }),
    /zorunludur/,
  )
  assert.throws(
    () => readSocialInfrastructureConfig({ RITIM_DB_HOST: 'postgres' }),
    /HOST, NAME, USER ve PASSWORD birlikte/,
  )
  assert.throws(
    () => readSocialInfrastructureConfig({ RITIM_REDIS_HOST: 'redis' }),
    /REDIS_HOST ve PASSWORD birlikte/,
  )
})

test('veritabani havuzu Pi icin guvenli aralikta tutulur', () => {
  assert.equal(readSocialInfrastructureConfig({ RITIM_DB_POOL_SIZE: '1' }).databasePoolSize, 2)
  assert.equal(readSocialInfrastructureConfig({ RITIM_DB_POOL_SIZE: '500' }).databasePoolSize, 40)
})
