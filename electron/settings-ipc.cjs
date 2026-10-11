// Social preference and moderation changes from the Settings window. They take
// the same acknowledged path as the Social view (social-bridge.cjs): the
// renderer gets the gateway's `{ ok }` / `{ ok: false, code }` answer, or
// `timeout` / `offline`, and only then keeps or reverts its controls.
const SETTINGS_SOCIAL_ACTIONS = new Set(['privacy', 'notification-preferences', 'mute', 'block'])

function createSettingsSocialActionHandler({ isTrustedSender, handleSocialAction }) {
  return async (event, request) => {
    if (!isTrustedSender(event)) return { ok: false, code: 'forbidden' }
    const selected = request && typeof request === 'object' && !Array.isArray(request) ? request : {}
    if (!SETTINGS_SOCIAL_ACTIONS.has(selected.type)) return { ok: false, code: 'unknown_action' }
    try {
      const result = await handleSocialAction(selected.type, selected.payload)
      return result && typeof result === 'object' ? result : { ok: false, code: 'rejected' }
    } catch {
      return { ok: false, code: 'failed' }
    }
  }
}

module.exports = { SETTINGS_SOCIAL_ACTIONS, createSettingsSocialActionHandler }
