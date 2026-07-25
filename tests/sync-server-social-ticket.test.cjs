const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { startSyncServer } = require('../electron/sync-server.cjs')

test('telefon sosyal ticket endpointi yalnızca eşleme anahtarıyla çalışır', async (context) => {
  const distPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ritim-sync-ticket-'))
  await fs.writeFile(path.join(distPath, 'index.html'), '<!doctype html><title>Ritim test</title>')
  let ticketRequests = 0
  const server = startSyncServer(distPath, 0, {
    pairingToken: 'pairing-token-12345678901234567890',
    async getSocialCompanionTicket() {
      ticketRequests += 1
      return { ticket: 'ritim_ct1_test-ticket', expiresIn: 120 }
    },
  })
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  context.after(async () => {
    await server.io.close()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(distPath, { recursive: true, force: true })
  })

  const unauthorized = await fetch(`${baseUrl}/social/session-ticket`, { method: 'POST' })
  assert.equal(unauthorized.status, 401)
  assert.equal(ticketRequests, 0)

  const authorized = await fetch(`${baseUrl}/social/session-ticket`, {
    method: 'POST',
    headers: { authorization: 'Bearer pairing-token-12345678901234567890' },
  })
  assert.equal(authorized.status, 200)
  assert.deepEqual(await authorized.json(), {
    ticket: 'ritim_ct1_test-ticket',
    expiresIn: 120,
  })
  assert.equal(ticketRequests, 1)
})
