const musicButton = document.getElementById('music-button')
const socialButton = document.getElementById('social-button')
const socialPanel = document.getElementById('social-panel')
const settingsButton = document.getElementById('settings-button')
const emptySettingsButton = document.getElementById('empty-settings-button')
const connectionStatus = document.getElementById('connection-status')
const socialCount = document.getElementById('social-count')
const onlineCount = document.getElementById('online-count')
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
const createRoomButton = document.getElementById('create-room-button')
const roomsList = document.getElementById('rooms-list')

let socialState = null
let selectedUserId = ''

function setView(view) {
  const isSocial = view === 'social'
  musicButton.classList.toggle('is-active', !isSocial)
  socialButton.classList.toggle('is-active', isSocial)
  socialPanel.hidden = !isSocial
}

function formatTime(value) {
  return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(value)
}

function selectedUser() {
  return socialState?.users?.find((user) => user.id === selectedUserId)
}

function renderPeople() {
  const users = socialState?.users || []
  peopleList.replaceChildren()
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
    avatar.textContent = user.initials
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

  chatAvatar.textContent = user.initials
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
    card.className = 'room-card'
    const header = document.createElement('header')
    const live = document.createElement('span')
    live.textContent = '● CANLI'
    const members = document.createElement('small')
    members.textContent = `${room.memberCount} kişi`
    header.append(live, members)
    const title = document.createElement('b')
    title.textContent = room.title
    card.append(header, title)
    roomsList.append(card)
  }
}

function render() {
  const users = socialState?.users || []
  if (!users.some((user) => user.id === selectedUserId)) selectedUserId = users[0]?.id || ''
  const online = users.filter((user) => user.presence === 'online').length
  connectionStatus.classList.toggle('is-online', online > 0)
  connectionStatus.querySelector('span').textContent = online > 0 ? `${online} telefon bağlı` : 'Telefon bekleniyor'
  onlineCount.textContent = `${online} çevrimiçi`
  socialCount.hidden = online === 0
  socialCount.textContent = String(online)
  createRoomButton.classList.toggle('is-active', Boolean(socialState?.activeRoomId))
  createRoomButton.lastChild.textContent = socialState?.activeRoomId ? ' Odan hazır' : ' Dinleme odası oluştur'
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
messageForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const user = selectedUser()
  const text = messageInput.value.trim()
  if (!user || !text) return
  window.ritimShell?.sendSocialAction('message', { targetUserId: user.id, text })
  messageInput.value = ''
})

window.ritimShell?.onViewChanged(setView)
window.ritimShell?.onSocialState((state) => {
  socialState = state
  render()
})
window.ritimShell?.getSocialState().then((state) => {
  socialState = state
  render()
})
window.ritimShell?.setView('music').then(setView)
render()
