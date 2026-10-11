// Settings window helper for social changes the gateway must acknowledge.
// Loaded by settings.html before settings.js; tests require it directly.
(function exposeSettingsAck(root) {
  const ERROR_MESSAGES = {
    rate_limited: 'Çok sık değişiklik yaptın; biraz sonra tekrar dene.',
    timeout: 'Ritim Sosyal zamanında yanıt vermedi; değişiklik geri alındı. Tekrar dene.',
    offline: 'Ritim Sosyal bağlantısı yok; değişiklik kaydedilmedi. Bağlanınca tekrar dene.',
    invalid_request: 'Bu değişiklik şu an yapılamıyor. Ayarları yenileyip tekrar dene.',
    invalid_payload: 'Bu değişiklik şu an yapılamıyor. Ayarları yenileyip tekrar dene.',
    user_not_found: 'Bu kullanıcı bulunamadı ya da şu an erişilemiyor.',
    conversation_not_found: 'Yalnız kabul edilmiş bir sohbeti sessize alabilirsin.',
    server_error: 'Ritim Sosyal sunucusunda bir sorun oluştu. Biraz sonra tekrar dene.',
  }
  const DEFAULT_ERROR = 'Değişiklik Ritim Sosyal tarafından onaylanmadı; eski ayar geri yüklendi.'

  function socialActionErrorMessage(code) {
    return Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : DEFAULT_ERROR
  }

  // Shows `next` at once, sends it and keeps it only when the gateway
  // confirms; otherwise `previous` comes back and `onError` gets the message.
  async function runAcknowledgedChange({ previous, next, apply, send, onSuccess, onError }) {
    apply(next)
    let result
    try {
      result = await send(next)
    } catch {
      result = { ok: false, code: 'failed' }
    }
    if (result?.ok === true) {
      onSuccess?.(result)
      return result
    }
    const code = typeof result?.code === 'string' ? result.code : 'rejected'
    apply(previous)
    onError?.(socialActionErrorMessage(code), code)
    return { ok: false, code }
  }

  const api = { runAcknowledgedChange, socialActionErrorMessage }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.RitimSettingsAck = Object.freeze(api)
})(globalThis)
