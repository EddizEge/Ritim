// Mirrors handleFromDisplayName in electron/social-hub.cjs (and
// electron/social-handle.cjs): Turkish lower case, dotless ı → i, then NFKD so
// the remaining diacritics split off and are dropped. An empty result stays
// empty so the gateway can derive the handle itself.
export function handleFromDisplayName(displayName: string | undefined) {
  const slug = String(displayName || '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 30)
  return slug ? `@${slug}` : ''
}

export function initialsFromDisplayName(displayName: string | undefined, fallback = 'R') {
  const initials = String(displayName || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase('tr'))
    .join('')
  return initials || fallback
}
