// Oynatıcı kataloğunu sınırlı tutan saf yardımcılar. Köprü (CJS, require(esm)) ve
// telefon (React/Vite) birlikte kullanır. Katalog her player:update'te telefona gider
// ve telefon önbelleğine yazılır; uzun dinleme gününde sınırsız büyümemeli.

// Zorunlu kayıtların (çalan parça, sıra, beğenilenler) dışında tutulacak en yeni parça sayısı.
export const CATALOG_RECENT_LIMIT = 150

// Parçaları kataloğa ekler / günceller; eklenen ya da güncellenen kayıt en sona taşınır,
// böylece nesnenin anahtar sırası "en son görülen" sırası olur.
export function mergeCatalogTracks(catalog, tracks) {
  const incoming = new Map()
  for (const track of tracks || []) {
    if (track && typeof track.id === 'string' && track.id) incoming.set(track.id, track)
  }
  const merged = {}
  for (const [id, track] of Object.entries(catalog || {})) {
    if (!incoming.has(id)) merged[id] = track
  }
  for (const [id, track] of incoming) merged[id] = track
  return merged
}

// Çalan parça, sıra ve beğenilenler her zaman kalır; geri kalanlardan yalnız en yeni
// `limit` kayıt tutulur. Kalan kayıtların sırası korunur.
export function pruneCatalog(catalog, { trackId = '', queue = [], liked = [] } = {}, limit = CATALOG_RECENT_LIMIT) {
  const required = new Set([trackId, ...(queue || []), ...(liked || [])].filter(Boolean))
  const entries = Object.entries(catalog || {})
  const optional = entries.filter(([id]) => !required.has(id))
  const keepOptional = new Set(optional.slice(Math.max(0, optional.length - Math.max(0, limit))).map(([id]) => id))
  if (keepOptional.size === optional.length) return catalog || {}
  const pruned = {}
  for (const [id, track] of entries) {
    if (required.has(id) || keepOptional.has(id)) pruned[id] = track
  }
  return pruned
}
