const fs = require('node:fs')
const path = require('node:path')

const MAX_DELIVERED_NOTIFICATION_IDS = 100

const defaults = Object.freeze({
  socialNotificationsEnabled: false,
  deliveredSocialNotificationIds: [],
})

function normalizeDevicePreferences(value = {}) {
  return {
    socialNotificationsEnabled: value.socialNotificationsEnabled === true,
    deliveredSocialNotificationIds: Array.isArray(value.deliveredSocialNotificationIds)
      ? [...new Set(value.deliveredSocialNotificationIds.filter((id) => typeof id === 'string' && id.length <= 120))]
        .slice(-MAX_DELIVERED_NOTIFICATION_IDS)
      : [],
  }
}

function createDevicePreferences(userDataPath) {
  const filePath = path.join(userDataPath, 'ritim-device-preferences.json')
  let current

  function read() {
    if (current) return { ...current, deliveredSocialNotificationIds: [...current.deliveredSocialNotificationIds] }
    try {
      current = normalizeDevicePreferences(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    } catch {
      current = normalizeDevicePreferences(defaults)
    }
    return { ...current, deliveredSocialNotificationIds: [...current.deliveredSocialNotificationIds] }
  }

  function update(patch = {}) {
    current = normalizeDevicePreferences({ ...read(), ...patch })
    fs.mkdirSync(userDataPath, { recursive: true })
    const temporaryPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    fs.renameSync(temporaryPath, filePath)
    return read()
  }

  return { filePath, read, update }
}

module.exports = { createDevicePreferences, normalizeDevicePreferences }
