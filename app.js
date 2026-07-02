// ============================================================
//  RoBoot — app.js
// ============================================================

const { ipcRenderer } = require('electron')

// ---- WINDOW CONTROLS ---------------------------------------
function wireWindowButton(id, channel) {
  const el = document.getElementById(id)
  if (!el) { console.error('[roboot] window control button not found:', id); return }
  el.addEventListener('click', e => {
    e.preventDefault()
    e.stopPropagation()
    console.log('[roboot] clicked', id, '-> sending', channel)
    ipcRenderer.send(channel)
  })
}
wireWindowButton('winClose',    'roboot:win-close')
wireWindowButton('winMinimize', 'roboot:win-minimize')
wireWindowButton('winMaximize', 'roboot:win-maximize')

// ---- PARTICLE CANVAS ---------------------------------------
const canvas = document.getElementById('bg-canvas')
const ctx = canvas.getContext('2d')

function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
resize()
window.addEventListener('resize', resize)

const particles = []
class Particle {
  constructor() { this.reset(true) }
  reset(randomY = false) {
    this.x = Math.random() * canvas.width
    this.y = randomY ? Math.random() * canvas.height : canvas.height + 10
    this.size = Math.random() * 1.5 + 0.3
    this.speedY = -(Math.random() * 0.3 + 0.1)
    this.speedX = (Math.random() - 0.5) * 0.15
    this.opacity = Math.random() * 0.3 + 0.05
    this.color = `rgba(0,180,255,${this.opacity})`
    this.life = 0; this.maxLife = Math.random() * 400 + 200
  }
  update() { this.x += this.speedX; this.y += this.speedY; this.life++; if (this.y < -10 || this.life > this.maxLife) this.reset() }
  draw() { ctx.beginPath(); ctx.arc(this.x, this.y, this.size, 0, Math.PI*2); ctx.fillStyle = this.color; ctx.fill() }
}
for (let i = 0; i < 40; i++) particles.push(new Particle())
function animateCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  particles.forEach(p => { p.update(); p.draw() })
  requestAnimationFrame(animateCanvas)
}
animateCanvas()

// ---- STATE -------------------------------------------------
let currentUser = null
let isLoggedIn = false

// ---- SPLASH SCREEN -------------------------------------------
// Shown immediately on launch (it's already in the DOM/painted before
// any script runs); we just make sure it stays up for a minimum amount
// of time so it doesn't flash by on fast machines, then fade it out
// once we know whether to show the login screen or the app.
const SPLASH_MIN_MS = 1100
const splashStartedAt = Date.now()

function hideSplash() {
  const splash = document.getElementById('splash-screen')
  if (!splash) return
  const elapsed = Date.now() - splashStartedAt
  const wait = Math.max(0, SPLASH_MIN_MS - elapsed)
  setTimeout(() => {
    splash.classList.add('hide')
    setTimeout(() => splash.remove(), 500) // matches CSS transition duration
  }, wait)
}

// ---- THEME TRANSITION ------------------------------------------
// Plays an iris-wipe transition while `applyFn` (sync or async) actually
// swaps the theme out of view, then reveals the new look underneath.
async function playThemeTransition(applyFn, label) {
  const overlay = document.getElementById('theme-transition')
  if (!overlay) { await applyFn(); return }
  const labelEl = overlay.querySelector('.tt-label')
  if (labelEl) labelEl.textContent = label || 'Applying theme...'

  overlay.classList.remove('reveal')
  overlay.classList.add('show')
  await new Promise(r => setTimeout(r, 320)) // let the iris finish closing in

  try {
    await applyFn()
  } finally {
    await new Promise(r => setTimeout(r, 180)) // brief hold so the label is readable
    overlay.classList.add('reveal')            // iris opens back up, revealing the new theme
    setTimeout(() => overlay.classList.remove('show', 'reveal'), 550)
  }
}

// ---- INIT --------------------------------------------------
async function init() {
  const { loggedIn } = await ipcRenderer.invoke('auth:check')
  if (loggedIn) {
    showApp()
    await loadUserData()
  } else {
    showLogin()
  }
  hideSplash()
}

// ---- LOGIN SCREEN ------------------------------------------
function showLogin() {
  document.getElementById('login-screen').style.display = 'flex'
  document.getElementById('app').style.display = 'none'
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none'
  document.getElementById('app').style.display = 'grid'
  isLoggedIn = true
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const btn = document.getElementById('loginBtn')
  btn.textContent = 'Opening Roblox login...'
  btn.disabled = true

  const result = await ipcRenderer.invoke('auth:login')
  if (result.success) {
    showApp()
    await loadUserData()
  } else {
    btn.textContent = 'Login with Roblox'
    btn.disabled = false
    showToast('Login failed: ' + result.error)
  }
})

document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  await ipcRenderer.invoke('auth:logout')
  isLoggedIn = false
  currentUser = null
  showLogin()
  document.getElementById('loginBtn').textContent = 'Login with Roblox'
  document.getElementById('loginBtn').disabled = false
})

// ---- LOAD USER DATA ----------------------------------------
async function loadUserData() {
  // Load user profile
  const user = await ipcRenderer.invoke('roblox:getUser')
  if (user.error) { showToast('Failed to load profile'); return }
  currentUser = user
  renderUserProfile(user)

  // Load friends
  const friends = await ipcRenderer.invoke('roblox:getFriends')
  console.log('Friends response:', JSON.stringify(friends).slice(0, 300))
  if (Array.isArray(friends)) {
    renderFriends(friends)
  } else {
    console.error('Friends error:', friends?.error)
  }

  // Load some featured games
  await loadFeaturedGames()
}

// ---- RENDER USER -------------------------------------------
function renderUserProfile(user) {
  // Sidebar profile
  document.querySelector('.sp-name').textContent = user.displayName || user.username
  document.querySelector('.sp-handle').textContent = '@' + user.username

  if (user.avatarUrl) {
    const avatarInner = document.querySelector('.sp-avatar-inner')
    avatarInner.style.background = `url(${user.avatarUrl}) center/cover`
    avatarInner.textContent = ''
  }

  // Home page profile row
  document.querySelector('.hp-name').textContent = user.displayName || user.username
  document.querySelector('.hp-handle').textContent = '@' + user.username

  const hpAvatar = document.querySelector('.hp-avatar')
  if (user.avatarUrl) {
    hpAvatar.style.background = `url(${user.avatarUrl}) center/cover`
    hpAvatar.textContent = ''
  } else {
    hpAvatar.textContent = (user.username || 'U').slice(0, 2).toUpperCase()
  }

  // Premium badge
  if (user.isPremium) {
    const badge = document.createElement('span')
    badge.className = 'premium-badge'
    badge.textContent = '⭐ Premium'
    document.querySelector('.hp-info').appendChild(badge)
  }
}

// ---- RENDER FRIENDS ----------------------------------------
function renderFriends(friends) {
  const online = friends.filter(f => f.isOnline)
  const offline = friends.filter(f => !f.isOnline)

  // Update stats
  document.querySelector('.fstat-num.online-count').textContent = online.length
  document.querySelector('.fstat-num.total-count').textContent = friends.length

  // Connections row on home page
  const connRow = document.querySelector('.connections-row')
  const sectionCount = document.querySelector('.section-count')
  if (sectionCount) sectionCount.textContent = `(${friends.length})`

  connRow.innerHTML = ''
  friends.slice(0, 10).forEach(f => {
    const div = document.createElement('div')
    div.className = 'conn-avatar'
    const colors = ['#e53935','#1565c0','#2e7d32','#6a1b9a','#f57f17','#00695c','#ad1457','#283593']
    const colorIdx = String(f.id).split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length
    const color = colors[colorIdx]
    const username = f.username || f.name || '?'
    const displayName = f.displayName || username
    const initials = username.slice(0, 2).toUpperCase()
    const bgStyle = f.avatarUrl
      ? `background:url(${f.avatarUrl}) center/cover no-repeat;`
      : `background:${color};`
    div.innerHTML = `
      <div class="conn-pic" style="${bgStyle}">
        ${f.avatarUrl ? '' : initials}
        ${f.isOnline ? '<span class="conn-online-dot"></span>' : ''}
      </div>
      <span class="conn-name">${displayName}</span>
    `
    connRow.appendChild(div)
    div.addEventListener('click', () => openUserProfile(f.id, f))
  })

  // Friends page - online
  const onlineList = document.querySelector('.friends-online-list')
  const offlineList = document.querySelector('.friends-offline-list')

  onlineList.innerHTML = ''
  online.forEach(f => {
    onlineList.appendChild(createFriendCard(f))
  })
  if (online.length === 0) {
    onlineList.innerHTML = '<p class="no-friends">No friends online right now</p>'
  }

  offlineList.innerHTML = ''
  offline.forEach(f => {
    offlineList.appendChild(createFriendCard(f))
  })
}

function createFriendCard(friend) {
  const card = document.createElement('div')
  card.className = `friend-full-card ${friend.isOnline ? 'online' : 'offline'}`

  const colors = ['#e53935','#1565c0','#2e7d32','#6a1b9a','#f57f17','#00695c']
  const colorIdx = String(friend.id).split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length
  const color = colors[colorIdx]

  const username = friend.username || friend.name || '?'
  const displayName = friend.displayName || username
  const initials = username.slice(0, 2).toUpperCase()

  const presenceLabel = friend.presenceType === 2
    ? `<span class="ffc-game"><span class="live-dot"></span> Playing ${friend.gameName || 'a game'}</span>`
    : friend.presenceType === 1
    ? `<span class="ffc-game" style="color:var(--text2)">Online on Roblox</span>`
    : `<span class="ffc-game offline-txt">Offline</span>`

  card.innerHTML = `
    <div class="ffc-avatar" style="--ac:${color}; ${friend.avatarUrl ? `background:url(${friend.avatarUrl}) center/cover; font-size:0` : ''}">
      ${friend.avatarUrl ? '' : initials}
    </div>
    <div class="ffc-info">
      <span class="ffc-name">${displayName}</span>
      ${presenceLabel}
    </div>
    <div class="ffc-actions">
      <button class="btn-ghost small">Profile</button>
      ${friend.isOnline && friend.gameId ? `<button class="btn-primary small join-btn" data-place-id="${friend.gameId}">Join</button>` : ''}
    </div>
  `

  const profileBtn = card.querySelector('.btn-ghost')
  profileBtn?.addEventListener('click', async (e) => {
    e.stopPropagation()
    openUserProfile(friend.id)
  })

  card.addEventListener('click', e => {
    if (e.target.closest('.join-btn') || e.target.closest('.btn-ghost')) return
    openUserProfile(friend.id)
  })

  // Join game button
  card.querySelector('.join-btn')?.addEventListener('click', async () => {
    showToast(`▶ Joining ${displayName}'s game...`)
    await ipcRenderer.invoke('roblox:launchGame', friend.gameId)
  })

  return card
}

// ---- FEATURED GAMES ----------------------------------------
// Cache of the home rows so "See All" can show the full list
// without refetching.
const HOME_ROWS = { recent: [], favs: [], recommended: [] }

async function loadFeaturedGames() {
  const [recent, favs, recommended] = await Promise.all([
    ipcRenderer.invoke('roblox:getRecentlyPlayed'),
    ipcRenderer.invoke('roblox:getFavoriteGames'),
    ipcRenderer.invoke('roblox:getRecommended'),
  ])
  console.log('[home] recent:', recent?.length, 'favs:', favs?.length, 'recommended:', recommended?.length)
  HOME_ROWS.recent      = Array.isArray(recent)      ? recent      : []
  HOME_ROWS.favs        = Array.isArray(favs)        ? favs        : []
  HOME_ROWS.recommended = Array.isArray(recommended) ? recommended : []
  renderGameRow('.continue-row',    HOME_ROWS.recent.slice(0,6))
  renderGameRow('.favorites-row',   HOME_ROWS.favs.slice(0,6))
  renderGameRow('.recommended-row', HOME_ROWS.recommended.slice(0,6))

  // Initial Games page load (All / Most Popular)
  await loadGamesPage({ reset: true })
}


function renderGameRow(selector, games) {
  const row = document.querySelector(selector)
  if (!row) return
  row.innerHTML = ''
  games.forEach(game => {
    const card = document.createElement('div')
    card.className = 'game-card'
    card.dataset.name = game.name
    card.innerHTML = `
      <div class="game-thumb">
        <div class="thumb-art" style="${game.thumbnailUrl ? `background:url(${game.thumbnailUrl}) center/cover` : 'background:#333'}">
          ${game.thumbnailUrl ? '' : `<span class="thumb-label">${game.name.slice(0,2).toUpperCase()}</span>`}
        </div>
        <div class="thumb-overlay">
          <button class="play-icon">
            <svg viewBox="0 0 24 24" fill="#333" width="18"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
        </div>
        <span class="game-players-badge"><span class="live-dot"></span>${formatCount(game.playing)}</span>
      </div>
      <div class="game-meta">
        <span class="game-title">${game.name}</span>
        ${game.rating != null ? `<div class="game-rating"><span class="star">★</span> ${game.rating}%</div>` : ''}
      </div>
    `
    card.querySelector('.play-icon').addEventListener('click', async (e) => {
      e.stopPropagation()
      showToast(`▶ Joining ${game.name}...`)
      await ipcRenderer.invoke('roblox:launchGame', game.rootPlaceId)
    })
    card.addEventListener('click', () => openGameDetail(game.id))
    row.appendChild(card)
  })
}

function renderGamesGrid(games, append = false) {
  const grid = document.querySelector('.games-full-grid')
  if (!grid) return
  if (!append) grid.innerHTML = ''
  games.forEach(game => {
    const card = document.createElement('div')
    card.className = 'full-game-card'
    card.innerHTML = `
      <div class="fgc-thumb">
        <div class="fgc-art" style="${game.thumbnailUrl ? `background:url(${game.thumbnailUrl}) center/cover; font-size:0` : 'background:#333'}">
          ${game.thumbnailUrl ? '' : game.name.slice(0,2).toUpperCase()}
        </div>
      </div>
      <div class="fgc-body">
        <div class="fgc-top">
          <span class="fgc-name">${game.name}</span>
          ${game.rating != null ? `<div class="fgc-rating">★ ${game.rating}%</div>` : ''}
        </div>
        <div class="fgc-footer">
          <span class="fgc-players"><span class="live-dot"></span>${formatCount(game.playing)} playing</span>
          <button class="btn-primary small">Play</button>
        </div>
      </div>
    `
    card.querySelector('.btn-primary').addEventListener('click', async () => {
      showToast(`▶ Joining ${game.name}...`)
      await ipcRenderer.invoke('roblox:launchGame', game.rootPlaceId)
    })
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-primary')) return
      openGameDetail(game.id)
    })
    grid.appendChild(card)
  })
}

function formatCount(n) {
  if (!n) return '0'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

// ---- GAME DETAIL OVERLAY -----------------------------------
const gameDetailOverlay = document.getElementById('gameDetailOverlay')
const gameDetailPanel   = document.getElementById('gameDetailPanel')

document.getElementById('gdBackdrop')?.addEventListener('click', closeGameDetail)
document.getElementById('gdClose')?.addEventListener('click', closeGameDetail)

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeGameDetail()
    closeUserProfile()
  }
})

function closeGameDetail() {
  gameDetailOverlay?.classList.remove('open')
}

const profileOverlay = document.getElementById('profileOverlay')
const profilePanel   = document.getElementById('profilePanel')
let currentViewedProfile = null
let lastVisitedPage = 'home'

const profileFullBtn = document.getElementById('profileFullBtn')
const profileBackBtn = document.getElementById('profileBackBtn')
const profileFriendsSeeAllBtn = document.getElementById('profileFriendsSeeAllBtn')
const profileFriendsAllBackBtn = document.getElementById('profileFriendsAllBackBtn')
const profileFriendsAllTitle = document.getElementById('profileFriendsAllTitle')
const profileFriendsAllHandle = document.getElementById('profileFriendsAllHandle')

const profileFriendsPage = document.getElementById('page-profile-friends')

const profilePage = document.getElementById('page-profile')


document.getElementById('profileBackdrop')?.addEventListener('click', closeUserProfile)
document.getElementById('profileClose')?.addEventListener('click', closeUserProfile)
profileFullBtn?.addEventListener('click', () => { if (currentViewedProfile) openFullProfile(currentViewedProfile.id) })
profileBackBtn?.addEventListener('click', returnToPreviousPage)
profileFriendsSeeAllBtn?.addEventListener('click', () => showProfileFriendsAll(currentViewedProfile))
profileFriendsAllBackBtn?.addEventListener('click', () => setActivePage('profile'))

async function openUserProfile(userId) {
  if (!profileOverlay || !profilePanel) {
    console.error('[profile] overlay element not found')
    return
  }

  profileOverlay.classList.add('open')
  profilePanel.classList.add('loading')

  const user = await ipcRenderer.invoke('roblox:getUserProfile', userId)
  profilePanel.classList.remove('loading')

  if (!user || user.error) {
    showToast('Failed to load profile')
    closeUserProfile()
    return
  }

  const avatar = document.getElementById('profileAvatar')
  const nameEl = document.getElementById('profileName')
  const handleEl = document.getElementById('profileHandle')
  const statusEl = document.getElementById('profileStatus')
  const infoEl = document.getElementById('profileInfo')
  const bioEl = document.getElementById('profileBio')
  const gamesBtn = document.getElementById('profileJoinBtn')

  if (avatar) {
    if (user.avatarUrl) {
      avatar.style.background = `url(${user.avatarUrl}) center/cover`
      avatar.textContent = ''
    } else {
      avatar.style.background = 'var(--bg3)'
      avatar.textContent = (user.username || 'U').slice(0, 2).toUpperCase()
    }
  }

  if (nameEl) nameEl.textContent = user.displayName || user.username || 'Unknown'
  if (handleEl) handleEl.textContent = `@${user.username || 'unknown'}`

  const statusText = user.presenceType === 2
    ? `Playing ${user.gameName || 'a game'}`
    : user.presenceType === 1
    ? 'Online'
    : 'Offline'
  if (statusEl) statusEl.textContent = statusText

  if (infoEl) {
    infoEl.innerHTML = `
      <div class="profile-stat">
        <span class="ps-label">User ID</span>
        <span class="ps-value">${user.id}</span>
      </div>
      <div class="profile-stat">
        <span class="ps-label">Created</span>
        <span class="ps-value">${formatDate(user.created)}</span>
      </div>
      <div class="profile-stat">
        <span class="ps-label">Status</span>
        <span class="ps-value">${statusText}</span>
      </div>
    `
  }

  if (bioEl) {
    bioEl.textContent = user.description || 'No bio available.'
  }

  if (gamesBtn) {
    if (user.presenceType === 2 && user.rootPlaceId) {
      gamesBtn.style.display = ''
      gamesBtn.onclick = async () => {
        showToast(`▶ Joining ${user.displayName || user.username}'s game...`)
        await ipcRenderer.invoke('roblox:launchGame', user.rootPlaceId)
      }
    } else {
      gamesBtn.style.display = 'none'
    }
  }

  currentViewedProfile = user
  if (profileFullBtn) profileFullBtn.disabled = false
}

function setActivePage(pageId) {
  pages.forEach(p => p.classList.remove('active'))
  document.getElementById('page-' + pageId)?.classList.add('active')
  if (pageTitle) pageTitle.textContent = PAGE_TITLES[pageId] || (pageId === 'profile' ? 'Profile' : pageId)
}

async function openFullProfile(userId) {
  lastVisitedPage = document.querySelector('.page.active')?.id?.replace('page-', '') || 'home'
  closeUserProfile()
  setActivePage('profile')
  prepareProfilePageSkeleton()
  const loaded = await loadProfilePage(userId)
  if (!loaded) {
    returnToPreviousPage()
  }
}

function prepareProfilePageSkeleton() {
  const titleHeading = document.getElementById('profilePageTitle')
  const handleTop = document.getElementById('profilePageHandleTop')
  const handleMain = document.getElementById('profilePageHandle')
  const statusEl = document.getElementById('profilePageStatus')
  const statsEl = document.getElementById('profilePageStats')
  const bioEl = document.getElementById('profilePageBio')
  const favoritesGrid = document.querySelector('.profile-favorites-grid')
  const followersCount = document.getElementById('profileFollowersCount')
  const avatar = document.getElementById('profilePageAvatar')

  if (titleHeading) titleHeading.textContent = 'Loading profile...'
  if (handleTop) handleTop.textContent = ''
  if (handleMain) handleMain.textContent = ''
  if (statusEl) statusEl.textContent = 'Loading...'
  if (statsEl) statsEl.innerHTML = '<div class="profile-stat loading">Loading...</div>'
  if (bioEl) bioEl.textContent = 'Loading profile details...'
  if (followersCount) followersCount.textContent = 'Loading followers...'
  if (avatar) {
    avatar.style.background = 'var(--bg3)'
    avatar.textContent = '--'
  }
  if (favoritesGrid) favoritesGrid.innerHTML = '<p class="no-friends">Loading favorites...</p>'
}

async function loadProfilePage(userId) {
  const profile = await ipcRenderer.invoke('roblox:getFullUserProfile', userId)
  console.log('[profilePage] loadProfilePage', userId, profile)
  if (!profile || profile.error) {
    showToast('Failed to load full profile')
    return false
  }

  console.log('[profilePage] profile summary', {
    friendsCount: profile.friendsCount,
    followersCount: profile.followersCount,
    favoritesCount: profile.favoritesCount,
    favoritesType: Array.isArray(profile.favorites) ? 'array' : typeof profile.favorites,
    favoritesLength: Array.isArray(profile.favorites) ? profile.favorites.length : null,
    friendsLength: Array.isArray(profile.friends) ? profile.friends.length : null,
    friendAvatars: Array.isArray(profile.friends) ? profile.friends.map(f => ({ id: f.id, hasAvatar: !!f.avatarUrl })) : null,
  })

  const avatar = document.getElementById('profilePageAvatar')
  const nameEl = document.getElementById('profilePageName')
  const handleTop = document.getElementById('profilePageHandleTop')
  const handleMain = document.getElementById('profilePageHandle')
  const statusEl = document.getElementById('profilePageStatus')
  const statsEl = document.getElementById('profilePageStats')
  const bioEl = document.getElementById('profilePageBio')
  const favoritesGrid = document.querySelector('.profile-favorites-grid')
  const followersCount = document.getElementById('profileFollowersCount')

  currentViewedProfile = profile

  const pageTitleText = profile.displayName || profile.username || 'Profile'

  if (avatar) {
    if (profile.avatarUrl) {
      avatar.style.background = `url(${profile.avatarUrl}) center/cover`
      avatar.textContent = ''
    } else {
      avatar.style.background = 'var(--bg3)'
      avatar.textContent = (profile.username || 'U').slice(0, 2).toUpperCase()
    }
  }
  if (nameEl) nameEl.textContent = pageTitleText
  if (handleTop) handleTop.textContent = `@${profile.username || 'unknown'}`
  if (handleMain) handleMain.textContent = `@${profile.username || 'unknown'}`
  const titleHeading = document.getElementById('profilePageTitle')
  if (titleHeading) titleHeading.textContent = pageTitleText

  const statusText = profile.presenceType === 2
    ? `Playing ${profile.gameName || 'a game'}`
    : profile.presenceType === 1
    ? 'Online'
    : 'Offline'
  if (statusEl) statusEl.textContent = statusText

  if (statsEl) {
    statsEl.innerHTML = `
      <div class="profile-stat">
        <span class="ps-label">Friends</span>
        <span class="ps-value">${profile.friendsCount != null ? profile.friendsCount : (Array.isArray(profile.friends) ? profile.friends.length : '0')}</span>
      </div>
      <div class="profile-stat">
        <span class="ps-label">Followers</span>
        <span class="ps-value">${profile.followersCount != null ? profile.followersCount : 'Unavailable'}</span>
      </div>
    `
  }

  if (bioEl) bioEl.textContent = profile.description || 'No bio available.'

  if (followersCount) followersCount.textContent = profile.followersCount != null
    ? `${profile.followersCount} followers`
    : 'Followers unavailable'

  if (favoritesGrid) {
    console.log('[profilePage] favorites payload=%o', profile.favorites)
    if (Array.isArray(profile.favorites) && profile.favorites.length) {
      renderGameRow('.profile-favorites-grid', profile.favorites)
    } else {
      favoritesGrid.innerHTML = '<p class="no-friends">No favorites to show.</p>'
    }
  }

  renderProfileFriendPreview(profile)
  renderProfileFriendsAll(profile)
  return true
}

function renderProfileFriendPreview(profile) {
  const previewRow = document.querySelector('.profile-friend-preview-row')
  if (!previewRow) return
  previewRow.innerHTML = ''

  const friends = Array.isArray(profile.friends) ? profile.friends.slice(0, 10) : []
  if (!friends.length) {
    previewRow.innerHTML = '<p class="no-friends">No friends to show.</p>'
    return
  }

  friends.forEach(friend => {
    const initials = (friend.displayName || friend.username || 'U').slice(0, 2).toUpperCase()
    const avatarStyle = friend.avatarUrl
      ? `background:url(${friend.avatarUrl}) center/cover no-repeat;`
      : 'background:var(--bg3);'
    const card = document.createElement('div')
    card.className = 'conn-avatar'
    card.innerHTML = `
      <div class="conn-pic" style="${avatarStyle}">${friend.avatarUrl ? '' : initials}</div>
    `
    card.addEventListener('click', () => openFullProfile(friend.id))
    previewRow.appendChild(card)
  })
}

function renderProfileFriendsAll(profile) {
  const list = document.querySelector('.profile-friends-full-list')
  if (!list) return
  list.innerHTML = ''

  const friends = Array.isArray(profile.friends) ? profile.friends : []
  if (!friends.length) {
    list.innerHTML = '<p class="no-friends">No friends to show.</p>'
    return
  }

  friends.forEach(friend => {
    list.appendChild(createFriendCard(friend))
  })
}

function showProfileFriendsAll(profile) {
  if (!profile) return
  if (profileFriendsAllTitle) profileFriendsAllTitle.textContent = `${profile.displayName || profile.username || 'User'}'s Friends`
  if (profileFriendsAllHandle) profileFriendsAllHandle.textContent = `@${profile.username || 'unknown'}`
  renderProfileFriendsAll(profile)
  setActivePage('profile-friends')
}

function returnToPreviousPage() {
  setActivePage(lastVisitedPage || 'friends')
}

function closeUserProfile() {
  profileOverlay?.classList.remove('open')
}

async function openGameDetail(universeId) {
  if (!gameDetailOverlay) {
    console.error('[gameDetail] overlay element not found — check index.html has the overlay HTML before app.js')
    return
  }

  gameDetailOverlay.classList.add('open')
  gameDetailPanel.classList.add('gd-loading')

  // Reset fields
  document.getElementById('gdHeroArt').style.backgroundImage    = ''
  document.getElementById('gdThumbnail').style.backgroundImage  = ''
  document.getElementById('gdTitle').textContent                = 'Loading...'
  document.getElementById('gdCreator').innerHTML                = ''
  document.getElementById('gdBadges').innerHTML                 = ''
  document.getElementById('gdStatsRow').innerHTML               = ''
  document.getElementById('gdDescription').textContent          = ''
  document.getElementById('gdDescription').className            = 'gd-description'
  document.getElementById('gdDetailsGrid').innerHTML            = ''
  document.getElementById('gdScreenshots').innerHTML            = ''
  document.getElementById('gdScreenshotsWrap').style.display   = 'none'
  document.getElementById('gdExpandBtn')?.remove()

  console.log('[gameDetail] fetching universeId:', universeId)
  const game = await ipcRenderer.invoke('roblox:getGameDetail', universeId)
  console.log('[gameDetail] response:', game)

  gameDetailPanel.classList.remove('gd-loading')

  if (!game || game.error) {
    showToast('Failed to load game details')
    closeGameDetail()
    return
  }

  // Hero art + thumbnail
  if (game.thumbnailUrl) {
    document.getElementById('gdHeroArt').style.backgroundImage   = `url(${game.thumbnailUrl})`
    document.getElementById('gdThumbnail').style.backgroundImage = `url(${game.thumbnailUrl})`
  }

  // Title + creator
  document.getElementById('gdTitle').textContent = game.name
  document.getElementById('gdCreator').innerHTML = `By <span>${escapeHtml(game.creator)}</span>`

  // Badges
  const badges = document.getElementById('gdBadges')
  if (game.rating != null) {
    const b = document.createElement('span')
    b.className = 'gd-badge rating'
    b.textContent = `★ ${game.rating}%`
    badges.appendChild(b)
  }
  if (game.playing) {
    const b = document.createElement('span')
    b.className = 'gd-badge players'
    b.textContent = `${formatCount(game.playing)} playing`
    badges.appendChild(b)
  }

  // Play button
  document.getElementById('gdPlayBtn').onclick = async () => {
    showToast(`▶ Joining ${game.name}...`)
    await ipcRenderer.invoke('roblox:launchGame', game.rootPlaceId)
  }

  // Stats row
  const statsRow = document.getElementById('gdStatsRow')
  const stats = [
    { val: formatCount(game.visits),  lbl: 'Visits'      },
    { val: formatCount(game.playing), lbl: 'Playing'     },
    { val: game.maxPlayers || '--',   lbl: 'Max Players' },
  ]
  stats.forEach(s => {
    const el = document.createElement('div')
    el.className = 'gd-stat'
    el.innerHTML = `<span class="gd-stat-val">${s.val}</span><span class="gd-stat-lbl">${s.lbl}</span>`
    statsRow.appendChild(el)
  })

  // Screenshots
  if (game.screenshots?.length) {
    document.getElementById('gdScreenshotsWrap').style.display = 'block'
    const cont = document.getElementById('gdScreenshots')
    game.screenshots.forEach(url => {
      const div = document.createElement('div')
      div.className = 'gd-screenshot'
      div.style.backgroundImage = `url(${url})`
      cont.appendChild(div)
    })
  }

  // Description
  const descEl = document.getElementById('gdDescription')
  descEl.textContent = game.description
  if (game.description && game.description.length > 200) {
    descEl.classList.add('collapsed')
    const btn = document.createElement('button')
    btn.className = 'gd-expand-btn'
    btn.id = 'gdExpandBtn'
    btn.textContent = 'Show more'
    btn.addEventListener('click', () => {
      descEl.classList.toggle('collapsed')
      btn.textContent = descEl.classList.contains('collapsed') ? 'Show more' : 'Show less'
    })
    descEl.after(btn)
  }

  // Details grid
  const grid = document.getElementById('gdDetailsGrid')
  const details = [
    { label: 'Created',    value: formatDate(game.created)       },
    { label: 'Updated',   value: formatDate(game.updated)        },
    { label: 'Up Votes',  value: formatCount(game.upVotes)       },
    { label: 'Down Votes',value: formatCount(game.downVotes)     },
  ]
  if (game.serverCount != null) details.push({ label: 'Active Servers', value: String(game.serverCount) })
  details.forEach(d => {
    const cell = document.createElement('div')
    cell.className = 'gd-detail-cell'
    cell.innerHTML = `<div class="gd-detail-label">${d.label}</div><div class="gd-detail-value">${d.value}</div>`
    grid.appendChild(cell)
  })

  gameDetailPanel.scrollTop = 0
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function formatDate(iso) {
  if (!iso) return '--'
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// ---- NAVIGATION --------------------------------------------
const navItems = document.querySelectorAll('.nav-item')
const pages = document.querySelectorAll('.page')
const pageTitle = document.getElementById('pageTitle')
const titleUnderline = document.querySelector('.title-underline')

const PAGE_TITLES = { home: 'Home', games: 'Games', friends: 'Friends', profile: 'Profile', settings: 'Settings' }

navItems.forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault()
    const target = item.dataset.page
    if (!target) return

    navItems.forEach(i => i.classList.remove('active'))
    item.classList.add('active')

    pageTitle.style.opacity = '0'
    pageTitle.style.transform = 'translateY(-6px)'
    setTimeout(() => {
      pageTitle.textContent = PAGE_TITLES[target] || target
      pageTitle.style.transition = 'all 0.25s ease'
      pageTitle.style.opacity = '1'
      pageTitle.style.transform = 'translateY(0)'
    }, 100)

    titleUnderline.style.width = '0'
    setTimeout(() => { titleUnderline.style.transition = 'width 0.4s ease'; titleUnderline.style.width = '30px' }, 160)

    pages.forEach(p => p.classList.remove('active'))
    setTimeout(() => document.getElementById('page-' + target)?.classList.add('active'), 40)
  })
})

// ---- SETTINGS TABS -----------------------------------------
document.querySelectorAll('.sn-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.sn-item').forEach(i => i.classList.remove('active'))
    item.classList.add('active')
    const target = item.dataset.stab
    document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'))
    document.getElementById('stab-' + target)?.classList.add('active')
  })
})

// ---- GAMES PAGE: BROWSE / DISCOVER --------------------------
const GAMES_PAGE_SIZE = 24
const gamesPageState = { genre: 'all', sort: 'popular', page: 0, loading: false }

function sortFromSelect() {
  const val = document.querySelector('.sort-select')?.value || 'Most Popular'
  return val === 'Highest Rated' ? 'rated' : 'popular'
}

function setLoadMoreVisible(visible) {
  const btn = document.getElementById('loadMoreGamesBtn')
  if (btn) btn.style.display = visible ? '' : 'none'
}

async function loadGamesPage({ reset = false } = {}) {
  if (gamesPageState.loading) return
  gamesPageState.loading = true
  const grid = document.querySelector('.games-full-grid')
  const loadMoreBtn = document.getElementById('loadMoreGamesBtn')

  if (reset) {
    gamesPageState.page = 0
    grid.innerHTML = Array(6).fill('<div class="game-skeleton tall"></div>').join('')
    setLoadMoreVisible(false)
  } else if (loadMoreBtn) {
    loadMoreBtn.textContent = 'Loading...'
    loadMoreBtn.disabled = true
  }

  const games = await ipcRenderer.invoke('roblox:browseGames', {
    genre:   gamesPageState.genre,
    sort:    gamesPageState.sort,
    page:    gamesPageState.page,
    maxRows: GAMES_PAGE_SIZE,
  })

  gamesPageState.loading = false
  if (loadMoreBtn) { loadMoreBtn.textContent = 'Load More'; loadMoreBtn.disabled = false }

  if (!games || games.error) {
    if (reset) grid.innerHTML = '<p class="no-friends">Failed to load games.</p>'
    setLoadMoreVisible(false)
    return
  }

  renderGamesGrid(games, !reset)
  gamesPageState.page++
  setLoadMoreVisible(games.length === GAMES_PAGE_SIZE)
}

document.getElementById('loadMoreGamesBtn')?.addEventListener('click', () => loadGamesPage({ reset: false }))

document.querySelector('.sort-select')?.addEventListener('change', () => {
  gamesPageState.sort = sortFromSelect()
  loadGamesPage({ reset: true })
})

// ---- GENRE FILTER ------------------------------------------
document.querySelectorAll('.genre-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.genre-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    gamesPageState.genre = btn.dataset.genre
    loadGamesPage({ reset: true })
  })
})

// ---- SEE ALL (home rows) ------------------------------------
document.querySelectorAll('.see-all').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault()
    const section = link.closest('.section')
    const title = section?.querySelector('.section-title')?.textContent.trim() || ''

    // Connections row -> Friends page
    if (title.startsWith('Connections')) {
      document.querySelector('[data-page="friends"]')?.click()
      return
    }

    let games = []
    if (title.startsWith('Continue'))         games = HOME_ROWS.recent
    else if (title.startsWith('Favorites'))   games = HOME_ROWS.favs
    else if (title.startsWith('Recommended')) games = HOME_ROWS.recommended

    // Switch to the Games page and show this row's full list
    document.querySelector('[data-page="games"]')?.click()
    document.querySelectorAll('.genre-btn').forEach(b => b.classList.remove('active'))
    setLoadMoreVisible(false)

    const grid = document.querySelector('.games-full-grid')
    if (games.length) {
      renderGamesGrid(games)
    } else {
      grid.innerHTML = '<p class="no-friends">Nothing here yet.</p>'
    }
  })
})


// ---- SEARCH ------------------------------------------------
const searchInput = document.querySelector('.search-bar input')
searchInput.addEventListener('keydown', async e => {
  if (e.key === 'Enter' && searchInput.value.trim()) {
    const query = searchInput.value.trim()
    showToast(`🔍 Searching "${query}"...`)

    // Switch to games page and search
    document.querySelector('[data-page="games"]').click()
    document.querySelectorAll('.genre-btn').forEach(b => b.classList.remove('active'))
    setLoadMoreVisible(false)
    const games = await ipcRenderer.invoke('roblox:searchGames', query)
    if (games && !games.error) renderGamesGrid(games)

    searchInput.value = ''
    searchInput.blur()
  }
})

// ---- LAUNCH BUTTON -----------------------------------------
document.getElementById('launchBtn').addEventListener('click', async () => {
  const btn = document.getElementById('launchBtn')
  btn.innerHTML = `<span class="launch-pulse"></span> Launching...`
  showToast('🚀 Launching Roblox...')
  await ipcRenderer.invoke('roblox:launch')
  setTimeout(() => {
    btn.innerHTML = `
      <span class="launch-pulse"></span>
      <svg viewBox="0 0 20 20" fill="currentColor" width="14"><path d="M6.3 4.5L16.7 10 6.3 15.5V4.5z"/></svg>
      Launch Roblox
    `
  }, 2000)
})

// ---- SLIDERS -----------------------------------------------
document.querySelectorAll('.settings-slider').forEach(slider => {
  const valEl = slider.nextElementSibling
  slider.addEventListener('input', () => {
    valEl.textContent = slider.value + '%'
    const pct = (slider.value - slider.min) / (slider.max - slider.min) * 100
    slider.style.background = `linear-gradient(90deg, var(--accent) ${pct}%, var(--bg5) ${pct}%)`
  })
  const pct = (slider.value - slider.min) / (slider.max - slider.min) * 100
  slider.style.background = `linear-gradient(90deg, var(--accent) ${pct}%, var(--bg5) ${pct}%)`
})

// ---- THEME SELECTOR ----------------------------------------
document.querySelectorAll('.theme-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    if (opt.classList.contains('active')) return
    const theme = opt.dataset.theme
    const themeLabel = opt.querySelector('span').textContent
    const themes = {
      cyber:    { '--accent': '#00b4ff', '--bg': '#1a1a1a', '--bg2': '#252525' },
      volcanic: { '--accent': '#ff4444', '--bg': '#1a1212', '--bg2': '#221818' },
      aurora:   { '--accent': '#00c97a', '--bg': '#121a14', '--bg2': '#182218' },
      midnight: { '--accent': '#a855f7', '--bg': '#13121a', '--bg2': '#1a1825' },
    }
    const vars = themes[theme] || themes.cyber

    playThemeTransition(() => {
      document.querySelectorAll('.theme-opt').forEach(o => o.classList.remove('active'))
      opt.classList.add('active')
      Object.entries(vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v))
    }, `Applying ${themeLabel} theme...`).then(() => {
      showToast(`Theme: ${themeLabel}`)
    })
  })
})

// ---- CUSTOM THEMES (uploaded .css files) --------------------
async function refreshCustomThemeList() {
  const list = document.getElementById('customThemeList')
  if (!list) return
  const { themes, active } = await ipcRenderer.invoke('theme:list')

  if (!themes.length) {
    list.innerHTML = '<p class="no-friends">No custom themes uploaded yet.</p>'
    return
  }

  list.innerHTML = themes.map(name => `
    <div class="ct-row${name === active ? ' active' : ''}" data-theme-file="${escapeHtml(name)}">
      <span class="ct-name">${escapeHtml(name)}</span>
      <div class="ct-row-actions">
        <button class="ct-apply-btn" data-action="apply">${name === active ? 'Active' : 'Apply'}</button>
        <button class="ct-delete-btn" data-action="delete">Delete</button>
      </div>
    </div>
  `).join('')

  list.querySelectorAll('.ct-row').forEach(row => {
    const filename = row.dataset.themeFile
    row.querySelector('[data-action="apply"]').addEventListener('click', async () => {
      let result
      await playThemeTransition(
        async () => { result = await ipcRenderer.invoke('theme:apply', filename) },
        `Applying ${filename}...`
      )
      if (result.success) {
        showToast(`Theme applied: ${filename}`)
        refreshCustomThemeList()
      } else {
        showToast('Failed to apply theme: ' + (result.error || 'unknown error'))
      }
    })
    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      const wasActive = row.classList.contains('active')
      const result = await ipcRenderer.invoke('theme:delete', filename)
      if (result.success) {
        if (wasActive) await ipcRenderer.invoke('theme:apply', null) // reset live view too
        showToast(`Theme deleted: ${filename}`)
        refreshCustomThemeList()
      } else {
        showToast('Failed to delete theme: ' + (result.error || 'unknown error'))
      }
    })
  })
}

document.getElementById('ctUploadBtn')?.addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('theme:upload')
  if (result.canceled) return
  if (!result.success) {
    showToast('Upload failed: ' + (result.error || 'unknown error'))
    return
  }
  showToast(`Theme uploaded: ${result.name}`)
  refreshCustomThemeList()
})

document.getElementById('ctResetBtn')?.addEventListener('click', async () => {
  await playThemeTransition(
    () => ipcRenderer.invoke('theme:apply', null),
    'Resetting to default...'
  )
  showToast('Reset to default theme')
  refreshCustomThemeList()
})

refreshCustomThemeList()

// (window controls are wired once, near the top of this file)

// ---- KEYBOARD SHORTCUTS ------------------------------------
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey) {
    if (e.key === 'k') { e.preventDefault(); searchInput.focus() }
    if (e.key === 'l') { e.preventDefault(); document.getElementById('launchBtn').click() }
    if (e.key === '1') document.querySelectorAll('.nav-item')[0]?.click()
    if (e.key === '2') document.querySelectorAll('.nav-item')[1]?.click()
    if (e.key === '3') document.querySelectorAll('.nav-item')[2]?.click()
    if (e.key === '4') document.querySelectorAll('.nav-item')[3]?.click()
  }
})

// ---- TOAST -------------------------------------------------
let toastTimer = null
function showToast(msg) {
  const toast = document.getElementById('toast')
  toast.textContent = msg
  toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800)
}

// ---- TITLE UNDERLINE INIT ----------------------------------
setTimeout(() => {
  document.querySelector('.title-underline').style.width = '30px'
}, 500)

// ---- START -------------------------------------------------
init()
// ============================================================
//  GAME DETAIL MODAL
// ============================================================

const gameModalBackdrop = document.getElementById('gameModalBackdrop')
const gameModalClose    = document.getElementById('gameModalClose')
let   currentGamePlaceId = null

// Open modal
async function openGameModal(game) {
  // Populate what we already know immediately
  document.getElementById('gmTitle').textContent       = game.name
  document.getElementById('gmPlaying').textContent     = formatCount(game.playing)
  document.getElementById('gmVisits').textContent      = formatCount(game.visits || 0)
  document.getElementById('gmFavorites').textContent   = '—'
  document.getElementById('gmCreator').innerHTML       = ''
  document.getElementById('gmDescription').textContent = ''
  document.getElementById('gmGenre').textContent       = ''
  document.getElementById('gmBadges').innerHTML        = ''
  document.getElementById('gmRatingStat').style.display = 'none'
  document.getElementById('gmThumbsSection').style.display = 'none'
  document.getElementById('gmThumbsRow').innerHTML     = ''

  // Icon — use card thumbnail as placeholder while loading
  const gmIcon = document.getElementById('gmIcon')
  gmIcon.style.background = game.thumbnailUrl
    ? `url(${game.thumbnailUrl}) center/cover`
    : 'var(--bg3)'

  // Hero — blur-up from card thumbnail
  const gmHeroArt = document.getElementById('gmHeroArt')
  gmHeroArt.style.background = game.thumbnailUrl
    ? `url(${game.thumbnailUrl}) center/cover`
    : 'var(--bg3)'

  // Play button
  currentGamePlaceId = game.rootPlaceId
  document.getElementById('gmPlayBtn').onclick = async () => {
    showToast(`▶ Joining ${game.name}...`)
    await ipcRenderer.invoke('roblox:launchGame', currentGamePlaceId)
  }

  // Show modal with loading spinner
  document.getElementById('gmLoading').classList.remove('hidden')
  gameModalBackdrop.classList.add('open')
  document.body.style.overflow = 'hidden'

  // Fetch full detail
  const detail = await ipcRenderer.invoke('roblox:getGameDetail', game.id)
  if (detail.error) {
    document.getElementById('gmLoading').classList.add('hidden')
    return
  }

  // Update play button with correct placeId from detail
  currentGamePlaceId = detail.rootPlaceId
  document.getElementById('gmPlayBtn').onclick = async () => {
    showToast(`▶ Joining ${detail.name}...`)
    await ipcRenderer.invoke('roblox:launchGame', detail.rootPlaceId)
  }

  // Hero — high-res screenshot as banner if available
  if (detail.screenshots.length > 0) {
    gmHeroArt.style.background = `url(${detail.screenshots[0]}) center/cover`
  } else if (detail.iconUrl) {
    gmHeroArt.style.background = `url(${detail.iconUrl}) center/cover`
  }

  // Icon — high-res
  if (detail.iconUrl) {
    gmIcon.style.background = `url(${detail.iconUrl}) center/cover`
  }

  // Title
  document.getElementById('gmTitle').textContent = detail.name

  // Creator
  if (detail.creatorName) {
    document.getElementById('gmCreator').innerHTML =
      `by <strong>${detail.creatorName}</strong>`
  }

  // Stats
  document.getElementById('gmPlaying').textContent   = formatCount(detail.playing)
  document.getElementById('gmVisits').textContent     = formatCount(detail.visits)
  document.getElementById('gmFavorites').textContent  =
    detail.favoritesCount != null ? formatCount(detail.favoritesCount) : '—'

  // Rating badge + stat
  if (detail.rating != null) {
    document.getElementById('gmRatingStat').style.display = ''
    document.getElementById('gmRating').textContent = detail.rating + '%'

    const badge = document.createElement('div')
    badge.className = 'gm-badge rating'
    badge.textContent = '★ ' + detail.rating + '%'
    document.getElementById('gmBadges').appendChild(badge)
  }

  // Active badge
  if (detail.isActive) {
    const badge = document.createElement('div')
    badge.className = 'gm-badge active'
    badge.textContent = 'Active'
    document.getElementById('gmBadges').prepend(badge)
  }

  // Description
  document.getElementById('gmDescription').textContent = detail.description || 'No description provided.'

  // Genre
  if (detail.genre && detail.genre !== 'All') {
    document.getElementById('gmGenre').textContent = detail.genre
  }

  // Screenshots row
  const thumbsRow = document.getElementById('gmThumbsRow')
  // Skip first screenshot — already used as hero
  const shots = detail.screenshots.length > 1 ? detail.screenshots.slice(1) : detail.screenshots
  if (shots.length > 0) {
    document.getElementById('gmThumbsSection').style.display = ''
    shots.forEach(url => {
      const div = document.createElement('div')
      div.className = 'gm-thumb'
      div.style.backgroundImage = `url(${url})`
      div.title = 'Screenshot'
      thumbsRow.appendChild(div)
    })
  }

  // Hide spinner
  document.getElementById('gmLoading').classList.add('hidden')
}

// Close modal
function closeGameModal() {
  gameModalBackdrop.classList.remove('open')
  document.body.style.overflow = ''
}

gameModalClose.addEventListener('click', closeGameModal)
gameModalBackdrop.addEventListener('click', e => {
  if (e.target === gameModalBackdrop) closeGameModal()
})
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && gameModalBackdrop.classList.contains('open')) closeGameModal()
})

// ---- Wire up game cards ------------------------------------
// Patches renderGameRow and renderGamesGrid to attach click → modal

const _origRenderGameRow = renderGameRow
renderGameRow = function(selector, games) {
  _origRenderGameRow(selector, games)
  const row = document.querySelector(selector)
  if (!row) return
  row.querySelectorAll('.game-card').forEach((card, i) => {
    card.addEventListener('click', e => {
      // Don't trigger if they clicked the play button inside
      if (e.target.closest('.play-icon')) return
      openGameModal(games[i])
    })
  })
}

const _origRenderGamesGrid = renderGamesGrid
renderGamesGrid = function(games) {
  _origRenderGamesGrid(games)
  const grid = document.querySelector('.games-full-grid')
  if (!grid) return
  grid.querySelectorAll('.full-game-card').forEach((card, i) => {
    card.addEventListener('click', e => {
      if (e.target.closest('.btn-primary')) return
      openGameModal(games[i])
    })
  })
}