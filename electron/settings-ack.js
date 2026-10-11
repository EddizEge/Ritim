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

  const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  const itemId = (item) => (isPlainObject(item) ? item.id : item)

  // What to show after a refused change. A newer settings:social-state may
  // have arrived while the ack was pending, so only what this change touched
  // goes back to `previous`; everything else stays as in `latest`.
  // Objects: changed keys revert (unless a newer state already put another
  // value there). Lists (by `id`): removed items come back, added ones go.
  // Anything else: `previous`.
  function rollbackValue(previous, next, latest) {
    if (isPlainObject(previous) && isPlainObject(next) && isPlainObject(latest)) {
      const result = { ...latest }
      for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        if (Object.is(previous[key], next[key]) || !Object.is(result[key], next[key])) continue
        if (Object.hasOwn(previous, key)) result[key] = previous[key]
        else delete result[key]
      }
      return result
    }
    if (Array.isArray(previous) && Array.isArray(next) && Array.isArray(latest)) {
      const nextIds = new Set(next.map(itemId))
      const previousIds = new Set(previous.map(itemId))
      const result = latest.filter((item) => previousIds.has(itemId(item)) || !nextIds.has(itemId(item)))
      const resultIds = new Set(result.map(itemId))
      previous.forEach((item, index) => {
        const id = itemId(item)
        if (nextIds.has(id) || resultIds.has(id)) return
        result.splice(Math.min(index, result.length), 0, item)
        resultIds.add(id)
      })
      return result
    }
    return previous
  }

  // Shows `next` at once, sends it and keeps it only when the gateway
  // confirms; otherwise what it changed is rolled back (on top of `latest()`
  // when given) and `onError` gets the message.
  async function runAcknowledgedChange({ previous, next, latest, apply, send, onSuccess, onError }) {
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
    apply(typeof latest === 'function' ? rollbackValue(previous, next, latest()) : previous)
    onError?.(socialActionErrorMessage(code), code)
    return { ok: false, code }
  }

  const api = { rollbackValue, runAcknowledgedChange, socialActionErrorMessage }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.RitimSettingsAck = Object.freeze(api)
})(globalThis)
