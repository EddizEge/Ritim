// Same rule as the gateway's handleFromDisplayName (electron/social-hub.cjs)
// and src/social/handle.ts: Turkish lower case, dotless ı → i, NFKD. An empty
// result stays empty so the gateway derives the handle from the display name.
function handleFromDisplayName(displayName) {
  const slug = String(displayName || '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 30)
  return slug ? `@${slug}` : ''
}

module.exports = { handleFromDisplayName }
