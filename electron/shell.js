const musicButton = document.getElementById('music-button')
const socialButton = document.getElementById('social-button')
const socialPanel = document.getElementById('social-panel')
const settingsButton = document.getElementById('settings-button')
const emptySettingsButton = document.getElementById('empty-settings-button')
const connectionStatus = document.getElementById('connection-status')
const socialCount = document.getElementById('social-count')
const socialServiceNote = document.getElementById('social-service-note')
const socialAuthButton = document.getElementById('social-auth-button')
const socialRetryButton = document.getElementById('social-retry-button')
const socialPrivacyToolbar = document.getElementById('social-privacy-toolbar')
const profileVisibility = document.getElementById('profile-visibility')
const listeningVisibility = document.getElementById('listening-visibility')
const onlineCount = document.getElementById('online-count')
const peopleSearchInput = document.getElementById('people-search-input')
const peopleList = document.getElementById('people-list')
const chatEmpty = document.getElementById('chat-empty')
const chatContent = document.getElementById('chat-content')
const chatAvatar = document.getElementById('chat-avatar')
const chatName = document.getElementById('chat-name')
const chatPresence = document.getElementById('chat-presence')
const chatTrack = document.getElementById('chat-track')
const messageList = document.getElementById('message-list')
const messageForm = document.getElementById('message-form')
const messageInput = document.getElementById('message-input')
const listenButton = document.getElementById('listen-button')
const blockButton = document.getElementById('block-button')
const createRoomButton = document.getElementById('create-room-button')
const roomsList = document.getElementById('rooms-list')
const roomStatusNote = document.getElementById('room-status-note')
const roomChat = document.getElementById('room-chat')
const roomChatCount = document.getElementById('room-chat-count')
const roomReactionStream = document.getElementById('room-reaction-stream')
const roomMessageList = document.getElementById('room-message-list')
const roomMessageForm = document.getElementById('room-message-form')
const roomMessageInput = document.getElementById('room-message-input')

let socialState = null
let selectedUserId = ''
let peopleQuery = ''
let appearancePreferences = { theme: 'system', density: 'comfortable', motion: 'system', artwork: 'full' }
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
const appearanceValues = {
  theme: new Set(['system', 'dark', 'black']),
  density: new Set(['comfortable', 'compact']),
  motion: new Set(['system', 'reduced']),
  artwork: new Set(['full', 'reduced', 'hidden']),
}

function applyAppearancePreferences(value = {}) {
  appearancePreferences = {
    theme: appearanceValues.theme.has(value.theme) ? value.theme : 'system',
    density: appearanceValues.density.has(value.density) ? value.density : 'comfortable',
    motion: appearanceValues.motion.has(value.motion) ? value.motion : 'system',
    artwork: appearanceValues.artwork.has(value.artwork) ? value.artwork : 'full',
  }
  const root = document.documentElement
  root.dataset.theme = appearancePreferences.theme
  root.dataset.resolvedTheme = appearancePreferences.theme === 'system'
    ? systemThemeQuery.matches ? 'dark' : 'light'
    : appearancePreferences.theme
  root.dataset.density = appearancePreferences.density
  root.dataset.motion = appearancePreferences.motion
  root.dataset.artwork = appearancePreferences.artwork
}

systemThemeQuery.addEventListener('change', () => {
  if (appearancePreferences.theme === 'system') applyAppearancePreferences(appearancePreferences)
})

function setView(view) {
  const isSocial = view === 'social'
  musicButton.classList.toggle('is-active', !isSocial)
  socialButton.classList.toggle('is-active', isSocial)
  socialPanel.hidden = !isSocial
}

function formatTime(value) {
  return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(value)
}

// Playback positions are seconds into the track, not timestamps; formatting
// them with formatTime() showed the 1970 clock time ("02:00") for every room.
function formatPlaybackPosition(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}

function roomSyncLabel(room) {
  const summary = room.syncSummary
  if (!summary) return ''
  if (summary.status === 'waiting') return 'Senkron bekleniyor'
  if (summary.status === 'unavailable') return 'Senkron kullanılamıyor'
  const status = summary.status === 'corrected' ? 'Düzeltildi' : 'Senkron'
  const roundTrip = Number.isFinite(summary.roundTripMs) ? `${Math.round(summary.roundTripMs)} ms` : ''
  const drift = Number.isFinite(summary.driftMs) ? `sapma ${Math.round(summary.driftMs)} ms` : ''
  return [status, roundTrip, drift].filter(Boolean).join(' • ')
}

function selectedUser() {
  return socialState?.users?.find((user) => user.id === selectedUserId)
}

function renderAvatar(element, user) {
  element.replaceChildren()
  if (user.avatarUrl) {
    const image = document.createElement('img')
    image.src = user.avatarUrl
    image.alt = ''
    image.referrerPolicy = 'no-referrer'
    element.append(image)
  } else {
    element.textContent = user.initials
  }
}

function renderPeople() {
  const query = peopleQuery.trim().toLocaleLowerCase('tr')
  const users = (socialState?.users || []).filter((user) => {
    if (!query) return true
    return [user.displayName, user.handle, user.currentTrack?.title, user.currentTrack?.artist]
      .filter(Boolean)
      .some((value) => value.toLocaleLowerCase('tr').includes(query))
  })
  peopleList.replaceChildren()
  if (!users.length) {
    const empty = document.createElement('span')
    empty.className = 'message-placeholder'
    empty.textContent = query ? 'Aramana uygun kullanıcı bulunamadı.' : 'Henüz başka kullanıcı yok.'
    peopleList.append(empty)
  }
  for (const user of users) {
    const card = document.createElement('article')
    card.className = `person-card${selectedUserId === user.id ? ' is-active' : ''}`
    const select = document.createElement('button')
    select.type = 'button'
    select.className = 'person-select'
    select.addEventListener('click', () => {
      selectedUserId = user.id
      render()
    })

    const avatar = document.createElement('span')
    avatar.className = 'avatar'
    renderAvatar(avatar, user)
    const copy = document.createElement('span')
    copy.className = 'person-copy'
    const name = document.createElement('b')
    name.textContent = user.displayName
    const detail = document.createElement('small')
    detail.textContent = user.currentTrack?.title || user.handle || 'Çevrimiçi'
    copy.append(name, detail)
    const reaction = document.createElement('button')
    reaction.type = 'button'
    reaction.className = 'reaction-button'
    reaction.title = 'Tepki gönder'
    reaction.textContent = user.reactionCount ? `♥ ${user.reactionCount}` : '♥'
    reaction.addEventListener('click', (event) => {
      event.stopPropagation()
      window.ritimShell?.sendSocialAction('reaction', { targetUserId: user.id, reaction: '♥' })
    })
    select.append(avatar, copy)
    card.append(select, reaction)
    peopleList.append(card)
  }
}

function renderChat() {
  const user = selectedUser()
  chatEmpty.hidden = Boolean(user)
  chatContent.hidden = !user
  if (!user) return

  renderAvatar(chatAvatar, user)
  chatName.textContent = user.displayName
  chatPresence.textContent = socialState.listeningWithUserId === user.id ? 'Birlikte dinliyorsunuz' : 'Çevrimiçi'
  listenButton.textContent = socialState.listeningWithUserId === user.id ? 'Birliktesiniz' : 'Birlikte dinle'
  listenButton.classList.toggle('is-active', socialState.listeningWithUserId === user.id)

  chatTrack.replaceChildren()
  chatTrack.hidden = !user.currentTrack
  if (user.currentTrack) {
    const cover = document.createElement(user.currentTrack.thumbnailUrl ? 'img' : 'span')
    cover.className = 'track-cover'
    if (user.currentTrack.thumbnailUrl) cover.src = user.currentTrack.thumbnailUrl
    const copy = document.createElement('span')
    copy.className = 'track-copy'
    const title = document.createElement('b')
    title.textContent = user.currentTrack.title
    const artist = document.createElement('small')
    artist.textContent = `${user.currentTrack.artist} • ${user.currentTrack.isPlaying ? 'Şu an çalıyor' : 'Duraklatıldı'}`
    copy.append(title, artist)
    chatTrack.append(cover, copy)
  }

  messageList.replaceChildren()
  const messages = socialState.conversations?.[user.id] || []
  if (!messages.length) {
    const placeholder = document.createElement('span')
    placeholder.className = 'message-placeholder'
    placeholder.textContent = 'İlk mesajı sen gönder.'
    messageList.append(placeholder)
  } else {
    for (const message of messages) {
      const bubble = document.createElement('div')
      bubble.className = `message-bubble${message.senderId === socialState.currentUser.id ? ' is-own' : ''}`
      const text = document.createElement('p')
      text.textContent = message.text
      const time = document.createElement('time')
      time.textContent = formatTime(message.sentAt)
      bubble.append(text, time)
      messageList.append(bubble)
    }
    messageList.scrollTop = messageList.scrollHeight
  }
}

function renderRooms() {
  const rooms = socialState?.rooms || []
  roomsList.replaceChildren()
  if (!rooms.length) {
    const empty = document.createElement('div')
    empty.className = 'room-empty'
    empty.textContent = 'Henüz canlı oda yok. İlk odayı oluşturabilirsin.'
    roomsList.append(empty)
  }
  for (const room of rooms) {
    const card = document.createElement('article')
    const unavailable = room.viewerPlaybackStatus === 'unavailable'
    const ownerOffline = room.lifecycle === 'owner_offline'
    card.className = `room-card${ownerOffline ? ' is-owner-offline' : ''}${unavailable ? ' is-unavailable' : ''}`
    const header = document.createElement('header')
    const live = document.createElement('span')
    live.textContent = unavailable
      ? '● PARÇA AÇILAMADI'
      : ownerOffline
        ? '● PC ÇEVRİMDIŞI'
        : room.lifecycle === 'waiting' ? '● HAZIRLANIYOR' : '● CANLI'
    const members = document.createElement('small')
    members.textContent = `${room.memberCount} kişi`
    header.append(live, members)
    const title = document.createElement('b')
    title.textContent = room.title
    const playback = document.createElement('small')
    playback.textContent = unavailable
      ? 'Bu parça bu bilgisayarda açılamadı.'
      : room.playback
      ? `${room.playback.playbackState === 'playing' ? 'Çalıyor' : 'Duraklatıldı'} • ${formatPlaybackPosition(room.playback.playbackPositionMs / 1000)}`
      : ownerOffline ? 'Oda sahibi yeniden bağlanıyor' : 'Oynatma bekleniyor'
    const syncLabel = roomSyncLabel(room)
    if (syncLabel) playback.textContent += ` • ${syncLabel}`
    card.append(header, title, playback)
    roomsList.append(card)
  }
  const activeRoom = rooms.find((room) => room.id === socialState?.activeRoomId)
  roomChat.hidden = !activeRoom
  if (!activeRoom) return
  roomChatCount.textContent = `${activeRoom.memberCount} kişi burada`
  roomReactionStream.replaceChildren()
  for (const item of (socialState.roomReactions?.[activeRoom.id] || []).filter((reaction) => reaction.expiresAt > Date.now()).slice(-8)) {
    const reaction = document.createElement('span')
    reaction.textContent = item.reaction
    roomReactionStream.append(reaction)
  }
  roomMessageList.replaceChildren()
  const messages = socialState.roomMessages?.[activeRoom.id] || []
  if (!messages.length) {
    const empty = document.createElement('p')
    empty.className = 'room-chat-empty'
    empty.textContent = 'İlk oda mesajını sen gönder.'
    roomMessageList.append(empty)
  } else {
    for (const item of messages.slice(-20)) {
      const message = document.createElement('article')
      message.className = item.senderId === socialState.currentUser.id ? 'is-own' : ''
      const sender = document.createElement('b')
      sender.textContent = item.senderId === socialState.currentUser.id
        ? 'Sen'
        : socialState.users.find((user) => user.id === item.senderId)?.displayName || 'Oda üyesi'
      const text = document.createElement('p')
      text.textContent = item.text
      message.append(sender, text)
      roomMessageList.append(message)
    }
    roomMessageList.scrollTop = roomMessageList.scrollHeight
  }
}

function render() {
  const users = socialState?.users || []
  if (!users.some((user) => user.id === selectedUserId)) selectedUserId = users[0]?.id || ''
  const online = users.filter((user) => user.presence === 'online').length
  connectionStatus.classList.toggle('is-online', Boolean(socialState?.companionConnected))
  connectionStatus.querySelector('span').textContent = socialState?.companionConnected ? 'Telefon senkron' : 'Telefon bağlı değil'
  onlineCount.textContent = `${online} çevrimiçi`
  socialCount.hidden = online === 0
  socialCount.textContent = String(online)
  createRoomButton.classList.toggle('is-active', Boolean(socialState?.activeRoomId))
  roomStatusNote.hidden = !socialState?.roomNotice
  roomStatusNote.textContent = socialState?.roomNotice || ''
  const socialOnline = socialState?.connectionStatus === 'online'
  createRoomButton.disabled = !socialOnline
  listenButton.disabled = !socialOnline
  messageInput.disabled = !socialOnline
  roomMessageInput.disabled = !socialOnline || !socialState?.activeRoomId
  const authentication = socialState?.authentication || {}
  const needsAuthentication = authentication.required && !authentication.authenticated
  createRoomButton.lastChild.textContent = socialState?.activeRoomId ? ' Odan hazır' : ' Dinleme odası oluştur'
  socialServiceNote.className = `social-service-note is-${socialState?.connectionStatus || 'connecting'}`
  socialServiceNote.querySelector('span').textContent = needsAuthentication
    ? 'Sosyal özellikler için Google hesabını Ritim Social’a bağla.'
    : socialOnline
      ? `Ritim Social bağlantısı kuruldu${authentication.user?.displayName ? ` • ${authentication.user.displayName}` : ''}.`
      : socialState?.connectionStatus === 'offline'
        ? 'Sosyal servis çevrimdışı; müzik ve telefon kumandası çalışmaya devam eder.'
        : 'Ritim Social’a bağlanıyor…'
  socialAuthButton.hidden = !authentication.configured
  socialAuthButton.textContent = authentication.authenticated ? 'Hesaptan çık' : 'Google ile bağlan'
  socialAuthButton.dataset.action = authentication.authenticated ? 'sign-out' : 'sign-in'
  socialRetryButton.hidden = socialState?.connectionStatus !== 'offline' || needsAuthentication
  socialPrivacyToolbar.hidden = !socialOnline
  profileVisibility.value = socialState?.privacy?.profileVisibility || 'everyone'
  listeningVisibility.value = socialState?.privacy?.listeningVisibility || 'everyone'
  renderPeople()
  renderChat()
  renderRooms()
}

musicButton.addEventListener('click', () => window.ritimShell?.setView('music'))
socialButton.addEventListener('click', () => window.ritimShell?.setView('social'))
settingsButton.addEventListener('click', () => window.ritimShell?.openSettings())
emptySettingsButton.addEventListener('click', () => window.ritimShell?.openSettings())
listenButton.addEventListener('click', () => {
  const user = selectedUser()
  if (user) window.ritimShell?.sendSocialAction('listening', { targetUserId: user.id })
})
createRoomButton.addEventListener('click', () => window.ritimShell?.sendSocialAction('create-room', {}))
socialRetryButton.addEventListener('click', () => window.ritimShell?.sendSocialAction('reconnect', {}))
socialAuthButton.addEventListener('click', () => {
  window.ritimShell?.sendSocialAction(socialAuthButton.dataset.action || 'sign-in', {})
})
function sendPrivacy() {
  window.ritimShell?.sendSocialAction('privacy', {
    profileVisibility: profileVisibility.value,
    listeningVisibility: listeningVisibility.value,
  })
}
profileVisibility.addEventListener('change', sendPrivacy)
listeningVisibility.addEventListener('change', sendPrivacy)
blockButton.addEventListener('click', () => {
  const user = selectedUser()
  if (!user || !window.confirm(`${user.displayName} kullanıcısını engellemek istiyor musun?`)) return
  window.ritimShell?.sendSocialAction('block', { targetUserId: user.id })
})
peopleSearchInput.addEventListener('input', () => {
  peopleQuery = peopleSearchInput.value
  renderPeople()
})
messageForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const user = selectedUser()
  const text = messageInput.value.trim()
  if (!user || !text) return
  window.ritimShell?.sendSocialAction('message', { targetUserId: user.id, text })
  messageInput.value = ''
})
roomMessageForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const roomId = socialState?.activeRoomId
  const text = roomMessageInput.value.trim()
  if (!roomId || !text) return
  window.ritimShell?.sendSocialAction('room-message', {
    roomId,
    text,
    clientMessageId: crypto.randomUUID(),
  })
  roomMessageInput.value = ''
})
for (const button of document.querySelectorAll('.room-reaction-actions button')) {
  button.addEventListener('click', () => {
    const roomId = socialState?.activeRoomId
    if (roomId) window.ritimShell?.sendSocialAction('room-reaction', { roomId, reaction: button.dataset.reaction })
  })
}

window.ritimShell?.onViewChanged(setView)
window.ritimShell?.onAppearance(applyAppearancePreferences)
window.ritimShell?.onSocialState((state) => {
  socialState = state
  render()
})
window.ritimShell?.getSocialState().then((state) => {
  socialState = state
  render()
})
window.ritimShell?.getAppearance().then(applyAppearancePreferences).catch(() => {})
window.ritimShell?.setView('music').then(setView)
applyAppearancePreferences(appearancePreferences)
render()
