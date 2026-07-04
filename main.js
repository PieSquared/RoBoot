// ============================================================
//  RoBoot — main.js
// ============================================================

const { app, BrowserWindow, ipcMain, shell, session, dialog } = require('electron')
const fs = require('fs')
const path   = require('path')
const crypto = require('crypto')

const {
  handleProtocolCallback,
  loadTokens, clearTokens, getValidAccessToken,
  saveTokens,
  generateCodeVerifier, generateCodeChallenge, generateState,
} = require('./auth')
const { normalizeFriendIdentity } = require('./libs/friend-utils')

// ---- CONSTANTS ---------------------------------------------
const CLIENT_ID     = '8472608127595747627'
const REDIRECT_URI  = 'rblxlaunch://callback'
const SCOPES        = 'openid profile user.advanced:read'
const AUTH_URL      = 'https://apis.roblox.com/oauth/v1/authorize'
const TOKEN_URL     = 'https://apis.roblox.com/oauth/v1/token'
const RBX_PARTITION = 'persist:roblox'

// ---- CUSTOM THEMES -------------------------------------------
// Themes are plain .css files only — never arbitrary JS/HTML. This renderer
// runs with nodeIntegration:true, so executing unvetted code here would have
// full access to the OAuth token file and the .ROBLOSECURITY cookie.
const THEMES_DIR    = () => path.join(app.getPath('userData'), 'themes')
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'roboot_settings.json')
let activeThemeCssKey = null // key returned by insertCSS, needed to remove it later

function ensureThemesDir() {
  const dir = THEMES_DIR()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8'))
  } catch { return {} }
}

function writeSettings(patch) {
  const current = readSettings()
  const merged = { ...current, ...patch }
  try { fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(merged)) } catch (e) { console.error('writeSettings:', e) }
  return merged
}

function listThemeFiles() {
  ensureThemesDir()
  return fs.readdirSync(THEMES_DIR()).filter(f => f.toLowerCase().endsWith('.css'))
}

async function applyTheme(filename) {
  if (!mainWindow) return { success: false, error: 'No window' }
  // Clear whatever theme is currently active first
  if (activeThemeCssKey) {
    try { await mainWindow.webContents.removeInsertedCSS(activeThemeCssKey) } catch {}
    activeThemeCssKey = null
  }
  if (!filename) { // "filename" empty/null means reset to default
    writeSettings({ activeTheme: null })
    return { success: true }
  }
  const filePath = path.join(ensureThemesDir(), filename)
  if (!fs.existsSync(filePath)) return { success: false, error: 'Theme file not found' }
  const css = fs.readFileSync(filePath, 'utf8')
  try {
    activeThemeCssKey = await mainWindow.webContents.insertCSS(css)
    writeSettings({ activeTheme: filename })
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

let mainWindow

// ---- CUSTOM PROTOCOL ---------------------------------------
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('rblxlaunch', process.execPath, [path.resolve(process.argv[1])])
} else {
  app.setAsDefaultProtocolClient('rblxlaunch')
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (event, commandLine) => {
    const url = commandLine.find(a => a.startsWith('rblxlaunch://'))
    if (url) handleProtocolCallback(url)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  if (url.startsWith('rblxlaunch://')) handleProtocolCallback(url)
})

// ---- CREATE WINDOW -----------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 780,
    minWidth: 1100, minHeight: 680,
    frame: false,
    backgroundColor: '#0d0d0d',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  })

  mainWindow.loadFile('index.html')

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      .window-bar {
        position: fixed !important;
        top: 12px !important;
        right: 16px !important;
        z-index: 2147483647 !important;
        -webkit-app-region: no-drag !important;
        pointer-events: all !important;
      }
      .win-btn {
        -webkit-app-region: no-drag !important;
        pointer-events: all !important;
        cursor: pointer !important;
      }
    `)

    const { activeTheme } = readSettings()
    if (activeTheme) applyTheme(activeTheme)
  })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ---- IN-APP OAUTH ------------------------------------------
function startInAppOAuth() {
  return new Promise((resolve, reject) => {
    const verifier  = generateCodeVerifier()
    const challenge = generateCodeChallenge(verifier)
    const state     = generateState()

    const params = new URLSearchParams({
      client_id:             CLIENT_ID,
      redirect_uri:          REDIRECT_URI,
      response_type:         'code',
      scope:                 SCOPES,
      state,
      code_challenge:        challenge,
      code_challenge_method: 'S256',
    })

    const loginWin = new BrowserWindow({
      width: 480, height: 700,
      parent: mainWindow,
      modal: true,
      title: 'Sign in to Roblox',
      autoHideMenuBar: true,
      webPreferences: {
        partition: RBX_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
      }
    })

    loginWin.loadURL(`${AUTH_URL}?${params}`)

    let handled = false

    async function handleRedirect(url) {
      if (handled) return
      handled = true
      if (!loginWin.isDestroyed()) loginWin.destroy()

      try {
        const parsed   = new URL(url.replace(/^rblxlaunch:\/\//, 'http://rblxlaunch/'))
        const code     = parsed.searchParams.get('code')
        const retState = parsed.searchParams.get('state')
        const error    = parsed.searchParams.get('error')

        if (error)              throw new Error(error)
        if (!code)              throw new Error('No code in callback')
        if (retState !== state) throw new Error('State mismatch — possible CSRF')

        const tokenRes = await fetch(TOKEN_URL, {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    new URLSearchParams({
            grant_type:    'authorization_code',
            code,
            redirect_uri:  REDIRECT_URI,
            client_id:     CLIENT_ID,
            code_verifier: verifier,
          })
        })

        if (!tokenRes.ok) {
          const txt = await tokenRes.text()
          throw new Error(`Token exchange failed (${tokenRes.status}): ${txt}`)
        }

        const tokens = await tokenRes.json()
        tokens.expires_at = Date.now() + tokens.expires_in * 1000
        saveTokens(tokens)
        omniSortsCache = null

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
        }

        resolve(tokens)
      } catch (e) {
        reject(e)
      }
    }

    loginWin.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('rblxlaunch://')) {
        event.preventDefault()
        handleRedirect(url)
      }
    })

    loginWin.webContents.on('did-fail-load', (_e, _code, _desc, url) => {
      if (url && url.startsWith('rblxlaunch://')) handleRedirect(url)
    })

    loginWin.on('closed', () => {
      if (!handled) reject(new Error('Login cancelled'))
    })
  })
}

// ---- GET .ROBLOSECURITY COOKIE -----------------------------
async function getRobloxCookie() {
  try {
    const rblxSession = session.fromPartition(RBX_PARTITION)
    const cookies = await rblxSession.cookies.get({
      domain: '.roblox.com',
      name:   '.ROBLOSECURITY',
    })
    return cookies.length > 0 ? cookies[0].value : null
  } catch {
    return null
  }
}

// ---- OMNI-RECOMMENDATION -----------------------------------
// Roblox's own home page discovery endpoint. Returns personalised
// sorts: Continue, Recommended For You, Favorites, etc.
// Cached for 5 minutes; busted on login/logout.

let omniSortsCache = null
const OMNI_TTL_MS  = 5 * 60 * 1000

async function fetchOmniSorts(cookie) {
  const now = Date.now()
  if (omniSortsCache && (now - omniSortsCache.ts) < OMNI_TTL_MS) {
    return omniSortsCache.sorts
  }

  const res = await fetch('https://apis.roblox.com/discovery-api/omni-recommendation', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie':        `.ROBLOSECURITY=${cookie}`,
    },
    body: JSON.stringify({ pageType: 'Home', sessionId: crypto.randomUUID() }),
  })

  if (!res.ok) throw new Error(`omni-recommendation failed: ${res.status}`)
  const data = await res.json()

  const sorts = {}
  for (const sort of data.sorts || []) {
    const ids = (sort.recommendationList || []).map(r => r.contentId).filter(Boolean)
    if (ids.length) sorts[sort.topic] = ids
  }

  omniSortsCache = { sorts, ts: now }
  console.log('[omni] available sort topics:', Object.keys(sorts))
  return sorts
}

// ---- AUTH IPC ----------------------------------------------
ipcMain.handle('auth:check', async () => {
  const tokens = loadTokens()
  if (!tokens) return { loggedIn: false }
  try {
    const token = await getValidAccessToken()
    return { loggedIn: !!token }
  } catch {
    return { loggedIn: false }
  }
})

ipcMain.handle('auth:login', async () => {
  try {
    await startInAppOAuth()
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('auth:logout', async () => {
  clearTokens()
  try {
    const rblxSession = session.fromPartition(RBX_PARTITION)
    await rblxSession.clearStorageData() // wipes .ROBLOSECURITY cookie + any other site data for the partition
  } catch (e) {
    console.error('logout: failed to clear roblox session data:', e)
  }
  omniSortsCache = null
  return { success: true }
})

ipcMain.handle('auth:getToken', async () => {
  try { return await getValidAccessToken() } catch { return null }
})

// ---- ROBLOX USER -------------------------------------------
ipcMain.handle('roblox:getUser', async () => {
  try {
    const token = await getValidAccessToken()
    if (!token) throw new Error('Not authenticated')

    const userinfoRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!userinfoRes.ok) throw new Error('Failed to fetch userinfo')
    const userinfo = await userinfoRes.json()
    const userId   = userinfo.sub

    const [profileRes, avatarRes] = await Promise.all([
      fetch(`https://users.roblox.com/v1/users/${userId}`),
      fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`)
    ])

    const profile = await profileRes.json()
    const avatar  = await avatarRes.json()

    return {
      id:          userId,
      username:    profile.name,
      displayName: profile.displayName,
      avatarUrl:   avatar.data?.[0]?.imageUrl || null,
      isPremium:   userinfo.premium_features?.isPremium || false,
    }
  } catch (e) {
    return { error: e.message }
  }
})

// ---- ROBLOX FRIENDS ----------------------------------------
ipcMain.handle('roblox:getFriends', async () => {
  try {
    const token = await getValidAccessToken()
    if (!token) throw new Error('Not authenticated')

    const userinfoRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!userinfoRes.ok) throw new Error('userinfo failed')
    const { sub: userId } = await userinfoRes.json()

    const friendsRes = await fetch(
      `https://friends.roblox.com/v1/users/${userId}/friends?userSort=Alphabetical`
    )
    if (!friendsRes.ok) throw new Error('Friends fetch failed')
    const { data: friends = [] } = await friendsRes.json()
    if (friends.length === 0) return []

    const friendIds = friends.map(f => f.id)

    const usersRes = await fetch('https://users.roblox.com/v1/users', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userIds: friendIds, excludeBannedUsers: false })
    })
    const { data: usersData = [] } = await usersRes.json()
    const userMap = Object.fromEntries(usersData.map(u => [u.id, u]))

    const cookie = await getRobloxCookie()
    const cookieHeader = cookie ? { Cookie: `.ROBLOSECURITY=${cookie}` } : {}

    const [presenceResult, avatarResult] = await Promise.allSettled([
      fetch('https://presence.roblox.com/v1/presence/users', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...cookieHeader },
        body:    JSON.stringify({ userIds: friendIds })
      }).then(r => r.json()),
      fetch(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${friendIds.join(',')}&size=48x48&format=Png`
      ).then(r => r.json())
    ])

    const presenceMap = {}
    if (presenceResult.status === 'fulfilled') {
      for (const p of presenceResult.value?.userPresences || []) {
        presenceMap[p.userId] = p
      }
    }

    const avatarMap = {}
    if (avatarResult.status === 'fulfilled') {
      for (const a of avatarResult.value?.data || []) {
        avatarMap[a.targetId] = a.imageUrl
      }
    }

    return friends.map(f => {
      const p    = presenceMap[f.id] || {}
      const u    = userMap[f.id]     || {}
      const type = p.userPresenceType ?? 0
      const { username, displayName } = normalizeFriendIdentity(f, u)
      return {
        id:           f.id,
        username,
        displayName,
        avatarUrl:    avatarMap[f.id] || null,
        isOnline:     type !== 0,
        presenceType: type,
        gameName:     p.lastLocation || null,
        gameId:       p.rootPlaceId  || null,
      }
    })
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('roblox:getUserProfile', async (_, userId, fallbackProfile = null) => {
  try {
    const resolvedUserId = userId ?? fallbackProfile?.id
    if (!resolvedUserId) return { error: 'Missing userId' }

    const cookie = await getRobloxCookie()
    const cookieHeader = cookie ? { Cookie: `.ROBLOSECURITY=${cookie}` } : {}
    const token = await getValidAccessToken().catch(() => null)
    const authHeader = token ? { Authorization: `Bearer ${token}` } : {}
    const commonHeaders = { ...cookieHeader, ...authHeader }

    let profile = null
    let profileRes = null

    try {
      profileRes = await fetch(`https://users.roblox.com/v1/users/${resolvedUserId}`, { headers: commonHeaders })
      if (profileRes.ok) {
        profile = await profileRes.json()
      }
    } catch {}

    if (!profile) {
      try {
        const fallbackRes = await fetch('https://users.roblox.com/v1/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...commonHeaders },
          body: JSON.stringify({ userIds: [resolvedUserId] }),
        })
        if (fallbackRes.ok) {
          const fallbackData = await fallbackRes.json()
          profile = Array.isArray(fallbackData?.data) ? fallbackData.data.find(u => String(u.id) === String(resolvedUserId)) || fallbackData.data[0] : null
        }
      } catch {}
    }

    const avatarRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${resolvedUserId}&size=150x150&format=Png`, { headers: commonHeaders }).catch(() => null)
    const friendsRes = await fetch(`https://friends.roblox.com/v1/users/${resolvedUserId}/friends/count`, { headers: commonHeaders }).catch(() => null)
    const presenceRes = await fetch('https://presence.roblox.com/v1/presence/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookieHeader },
      body: JSON.stringify({ userIds: [resolvedUserId] }),
    }).catch(() => null)

    const avatar  = avatarRes?.ok ? await avatarRes.json().catch(() => ({ data: [] })) : { data: [] }
    const friends = friendsRes?.ok ? await friendsRes.json().catch(() => null) : null
    const presenceData = presenceRes?.ok ? await presenceRes.json().catch(() => null) : null
    const presence = presenceData?.userPresences?.[0] || {}

    const fallbackName = fallbackProfile?.displayName || fallbackProfile?.username || fallbackProfile?.name || null
    const fallbackUsername = fallbackProfile?.username || fallbackProfile?.name || null

    return {
      id:           resolvedUserId,
      username:     profile?.name || fallbackUsername || fallbackProfile?.userName || null,
      displayName:  profile?.displayName || fallbackName || profile?.name || fallbackUsername || null,
      avatarUrl:    avatar.data?.[0]?.imageUrl || fallbackProfile?.avatarUrl || `https://www.roblox.com/headshot-thumbnail/image?userId=${resolvedUserId}&width=150&height=150&format=png`,
      description:  profile?.description || profile?.bio || fallbackProfile?.description || '',
      created:      profile?.created || fallbackProfile?.created || null,
      isOnline:     (presence.userPresenceType ?? 0) !== 0,
      presenceType: presence.userPresenceType ?? 0,
      gameName:     presence.lastLocation || null,
      rootPlaceId:  presence.rootPlaceId || null,
      friendsCount: friends?.count ?? fallbackProfile?.friendsCount ?? null,
    }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('roblox:getFullUserProfile', async (_, userId) => {
  try {
    if (!userId) throw new Error('Missing userId')

    const cookie = await getRobloxCookie()
    const cookieHeader = cookie ? { Cookie: `.ROBLOSECURITY=${cookie}` } : {}
    const token = await getValidAccessToken().catch(() => null)
    const authHeader = token ? { Authorization: `Bearer ${token}` } : {}
    const commonHeaders = { ...cookieHeader, ...authHeader }

    const [profileRes, avatarRes, favsRes, friendsRes, followersRes, presenceRes] = await Promise.allSettled([
      fetch(`https://users.roblox.com/v1/users/${userId}`),
      fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`, { headers: commonHeaders }),
      fetch(`https://games.roblox.com/v2/users/${userId}/favorite/games?accessFilter=2&limit=10&sortOrder=Desc`, { headers: commonHeaders }),
      fetch(`https://friends.roblox.com/v1/users/${userId}/friends?userSort=Alphabetical&limit=12`, { headers: commonHeaders }),
      fetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`, { headers: commonHeaders }),
      fetch('https://presence.roblox.com/v1/presence/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...commonHeaders },
        body: JSON.stringify({ userIds: [userId] }),
      }),
    ])

    const ok = res => res?.status === 'fulfilled' && res.value?.ok
    console.log('[roblox:getFullUserProfile] userId=%s profileOk=%s avatarOk=%s favsOk=%s friendsOk=%s followersOk=%s presenceOk=%s',
      userId,
      ok(profileRes),
      ok(avatarRes),
      ok(favsRes),
      ok(friendsRes),
      ok(followersRes),
      ok(presenceRes)
    )

    if (!ok(profileRes)) {
      throw new Error('Failed to load profile')
    }

    const profile = await profileRes.value.json()
    const avatar = ok(avatarRes) ? await avatarRes.value.json() : { data: [] }
    const favoritesData = ok(favsRes) ? await favsRes.value.json() : null
    const friendsData = ok(friendsRes) ? await friendsRes.value.json() : null
    const followersData = ok(followersRes) ? await followersRes.value.json() : null
    const presenceData = ok(presenceRes) ? await presenceRes.value.json() : null

    console.log('[roblox:getFullUserProfile] favoritesData=%o', favoritesData)
    console.log('[roblox:getFullUserProfile] friendsData=%o', friendsData)
    console.log('[roblox:getFullUserProfile] followersData=%o', followersData)

    let favoritesIds = Array.isArray(favoritesData?.data)
      ? favoritesData.data.map(g => g.universeId || g.id || g.gameId || g.rootPlaceId || g.rootPlace || g.placeId || null).filter(Boolean)
      : []

    if (!favoritesIds.length) {
      const fallbackUrls = [
        `https://games.roblox.com/v2/users/${userId}/favorite/games?accessFilter=2&sortOrder=Desc&limit=10`,
        `https://games.roblox.com/v2/users/${userId}/favorite/games?accessFilter=1&sortOrder=Desc&limit=10`,
        `https://games.roblox.com/v2/users/${userId}/favorite/games?accessFilter=0&sortOrder=Desc&limit=10`,
      ]
      for (const url of fallbackUrls) {
        try {
          const fallbackFavs = await fetch(url, { headers: commonHeaders })
          console.log('[roblox:getFullUserProfile] fallback favorites url=%s status=%s', url, fallbackFavs.status)
          if (!fallbackFavs.ok) continue
          const fallbackData = await fallbackFavs.json()
          favoritesIds = Array.isArray(fallbackData?.data)
            ? fallbackData.data.map(g => g.universeId || g.id || g.gameId || g.rootPlaceId || g.rootPlace || g.placeId || null).filter(Boolean)
            : []
          if (favoritesIds.length) break
        } catch (e) {
          console.warn('[roblox:getFullUserProfile] favorite fallback failed', url, e.message)
        }
      }
    }

    const favorites = await fetchGameDetails(favoritesIds)

    const friends = Array.isArray(friendsData?.data)
      ? friendsData.data.map(f => {
          const { username, displayName } = normalizeFriendIdentity(f)
          return {
            id: f.id,
            username,
            displayName,
            avatarUrl: null,
            isOnline: false,
            presenceType: 0,
            gameName: null,
            gameId: null,
          }
        })
      : []

    let friendsWithAvatars = friends
    if (friends.length) {
      try {
        const allIds = friends.map(f => f.id)
        const chunkSize = 100
        const thumbMap = {}
        const userMap = {}

        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const fetchWithRetries = async (fn, retries = 3) => {
          let attempt = 0
          while (attempt < retries) {
            try {
              const res = await fn()
              if (res && res.ok) return res
              // if rate limited, wait and retry
              if (res && res.status === 429) {
                const wait = 500 * Math.pow(2, attempt)
                await sleep(wait)
                attempt++
                continue
              }
              return res
            } catch (e) {
              const wait = 500 * Math.pow(2, attempt)
              await sleep(wait)
              attempt++
            }
          }
          return null
        }

        for (let i = 0; i < allIds.length; i += chunkSize) {
          const batch = allIds.slice(i, i + chunkSize)

          const thumbUrl = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${batch.join(',')}&size=150x150&format=Png`
          const userPostUrl = `https://users.roblox.com/v1/users`

          const [thumbRes, userRes] = await Promise.all([
            fetchWithRetries(() => fetch(thumbUrl, { headers: commonHeaders })),
            fetchWithRetries(() => fetch(userPostUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...commonHeaders }, body: JSON.stringify({ userIds: batch }) })),
          ])

          console.log('[roblox:getFullUserProfile] batch thumb ok=%s user ok=%s thumbStatus=%s userStatus=%s batchSize=%s',
            !!thumbRes?.ok, !!userRes?.ok, thumbRes?.status, userRes?.status, batch.length)

          if (thumbRes && thumbRes.ok) {
            const thumbData = await thumbRes.json()
            for (const item of thumbData.data || []) {
              if (item.targetId) thumbMap[String(item.targetId)] = item.imageUrl
            }
          }

          let userData = null
          if (userRes && userRes.ok) {
            userData = await userRes.json()
          } else {
            // Try GET fallback for this batch
            try {
              const getRes = await fetch(`https://users.roblox.com/v1/users?userIds=${batch.join(',')}`, { headers: commonHeaders })
              console.log('[roblox:getFullUserProfile] users GET fallback status=%s batchSize=%s', getRes.status, batch.length)
              if (getRes.ok) userData = await getRes.json()
            } catch (e) {
              console.warn('[roblox:getFullUserProfile] users GET fallback failed:', e.message)
            }
          }

          if (userData && userData.data) {
            for (const u of userData.data) userMap[u.id] = u
          }
        }

        friendsWithAvatars = friends.map(f => {
          const u = userMap[f.id] || {}
          const { username, displayName } = normalizeFriendIdentity(f, u)
          return {
            ...f,
            username,
            displayName,
            avatarUrl: thumbMap[String(f.id)] || `https://www.roblox.com/headshot-thumbnail/image?userId=${f.id}&width=150&height=150&format=png`,
          }
        })
      } catch (e) {
        console.warn('[roblox:getFullUserProfile] friend detail fetch failed:', e.message)
        friendsWithAvatars = friends.map(f => ({
          ...f,
          avatarUrl: `https://www.roblox.com/headshot-thumbnail/image?userId=${f.id}&width=150&height=150&format=png`,
        }))
      }
    }

    const presence = presenceData?.userPresences?.[0] || {}
    let followerCountValue = null
    if (typeof followersData?.count === 'number') {
      followerCountValue = followersData.count
    } else if (typeof followersData?.followers === 'number') {
      followerCountValue = followersData.followers
    } else if (Array.isArray(followersData?.data)) {
      followerCountValue = followersData.data.length
    }

    if (followerCountValue == null) {
      const fallbackFollowerUrls = [
        `https://friends.roblox.com/v1/users/${userId}/followers/count`,
        `https://friends.roblox.com/v1/users/${userId}/followers?limit=1`,
      ]
      for (const url of fallbackFollowerUrls) {
        try {
          const fallbackFollowers = await fetch(url, { headers: commonHeaders })
          console.log('[roblox:getFullUserProfile] fallback followers url=%s status=%s', url, fallbackFollowers.status)
          if (!fallbackFollowers.ok) continue
          const fallbackData = await fallbackFollowers.json()
          followerCountValue = typeof fallbackData.count === 'number'
            ? fallbackData.count
            : typeof fallbackData.followers === 'number'
            ? fallbackData.followers
            : Array.isArray(fallbackData.data)
            ? fallbackData.data.length
            : followerCountValue
          if (followerCountValue != null) break
        } catch (e) {
          console.warn('[roblox:getFullUserProfile] follower fallback failed:', url, e.message)
        }
      }
    }

    console.log('[roblox:getFullUserProfile] profile=%s favorites=%d friends=%d followers=%s',
      profile.name,
      favorites.length,
      friendsWithAvatars.length,
      followerCountValue
    )

    return {
      id:             userId,
      username:       profile.name,
      displayName:    profile.displayName,
      avatarUrl:      avatar.data?.[0]?.imageUrl || `https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=150&height=150&format=png`,
      description:    profile.description || profile.bio || '',
      created:        profile.created,
      friendsCount:   friendsData?.count ?? friendsWithAvatars.length,
      followersCount: followerCountValue,
      favoritesCount: favoritesData?.count ?? favorites.length,
      favorites,
      friends:        friendsWithAvatars,
      isOnline:       (presence.userPresenceType ?? 0) !== 0,
      presenceType:   presence.userPresenceType ?? 0,
      gameName:       presence.lastLocation || null,
      rootPlaceId:    presence.rootPlaceId || null,
    }
  } catch (e) {
    console.error('[roblox:getFullUserProfile] error:', e.message)
    return { error: e.message }
  }
})

// ---- GAME DETAILS HELPER -----------------------------------
async function fetchGameDetails(universeIds) {
  if (!universeIds || !universeIds.length) return []
  const chunkSize = 20
  const results = []
  const seen = new Set()

  for (let i = 0; i < universeIds.length; i += chunkSize) {
    const ids = universeIds.slice(i, i + chunkSize).join(',')
    const [gamesRes, thumbsRes] = await Promise.all([
      fetchWithRetries(() => fetch(`https://games.roblox.com/v1/games?universeIds=${ids}`, { headers: DEFAULT_FETCH_HEADERS })),
      fetchWithRetries(() => fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids}&size=150x150&format=Png`, { headers: DEFAULT_FETCH_HEADERS }))
    ])

    if (!gamesRes) {
      console.warn('[main] fetchGameDetails skipped chunk; no gamesRes', ids)
      continue
    }
    if (!gamesRes.ok) {
      console.warn('[main] fetchGameDetails skipped chunk; bad gamesRes status', gamesRes.status, ids)
      continue
    }

    let gamesData = null
    try {
      gamesData = await gamesRes.json()
    } catch (e) {
      console.warn('[main] fetchGameDetails gamesRes json failed', e.message, ids)
      continue
    }
    if (!gamesData || !Array.isArray(gamesData.data)) {
      console.warn('[main] fetchGameDetails missing games data', ids)
      continue
    }

    const thumbsData = thumbsRes && thumbsRes.ok ? await thumbsRes.json().catch(() => ({ data: [] })) : { data: [] }
    const thumbMap   = {}
    for (const t of thumbsData.data || []) thumbMap[t.targetId] = t.imageUrl

    for (const g of gamesData.data) {
      if (!g || !g.id || seen.has(g.id)) continue
      seen.add(g.id)
      results.push({
        id:           g.id,
        rootPlaceId:  g.rootPlaceId,
        name:         g.name,
        playing:      g.playing || 0,
        visits:       g.visits  || 0,
        rating:       (g.totalUpVotes + g.totalDownVotes) > 0
                        ? Math.round(g.totalUpVotes / (g.totalUpVotes + g.totalDownVotes) * 100)
                        : null,
        thumbnailUrl: thumbMap[g.id] || null,
      })
    }
  }

  return results
}

ipcMain.handle('roblox:getGames', async (_, universeIds) => {
  try { return await fetchGameDetails(universeIds) }
  catch (e) { return { error: e.message } }
})

// ---- CONTINUE PLAYING --------------------------------------
ipcMain.handle('roblox:getRecentlyPlayed', async () => {
  const FALLBACK = [2753915549, 301549643, 155615604, 189707, 223316882, 1537690962, 286090429, 606849621]
  try {
    const cookie = await getRobloxCookie()
    if (!cookie) return fetchGameDetails(FALLBACK)

    const sorts = await fetchOmniSorts(cookie)
    const ids   = sorts['Continue'] || sorts['ContinuePlaying'] || sorts['MyRecent'] || []

    if (ids.length) {
      console.log(`[getRecentlyPlayed] found ${ids.length} games via omni-recommendation`)
      return fetchGameDetails(ids)
    }
    return fetchGameDetails(FALLBACK)
  } catch (e) {
    console.error('[getRecentlyPlayed]', e.message)
    return fetchGameDetails(FALLBACK)
  }
})

// ---- FAVORITE GAMES ----------------------------------------
ipcMain.handle('roblox:getFavoriteGames', async () => {
  const FALLBACK = [1537690962, 606849621, 2788229376, 3926305882, 4465864456, 286090429, 2753915549, 301549643]
  try {
    const token = await getValidAccessToken()
    if (!token) return fetchGameDetails(FALLBACK)

    const uiRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!uiRes.ok) return fetchGameDetails(FALLBACK)
    const { sub: userId } = await uiRes.json()

    const cookie  = await getRobloxCookie()
    const headers = cookie ? { Cookie: `.ROBLOSECURITY=${cookie}` } : {}

    const res = await fetch(
      `https://games.roblox.com/v2/users/${userId}/favorite/games?accessFilter=2&limit=10&sortOrder=Desc`,
      { headers }
    )
    if (!res.ok) return fetchGameDetails(FALLBACK)

    const data = await res.json()
    const ids  = (data.data || []).map(g => g.id).filter(Boolean)
    return ids.length ? fetchGameDetails(ids) : fetchGameDetails(FALLBACK)
  } catch (e) {
    console.error('[getFavoriteGames]', e.message)
    return fetchGameDetails(FALLBACK)
  }
})

// ---- RECOMMENDED FOR YOU -----------------------------------
ipcMain.handle('roblox:getRecommended', async () => {
  const FALLBACK = [4465864456, 2788229376, 3926305882, 1537690962, 606849621, 286090429, 189707, 223316882]
  try {
    const cookie = await getRobloxCookie()
    if (!cookie) return fetchGameDetails(FALLBACK)

    const sorts = await fetchOmniSorts(cookie)
    const ids   =
      sorts['Recommended For You'] ||
      sorts['RecommendedForYou']   ||
      sorts['Recommended']         ||
      sorts['PersonalizedRecs']    ||
      sorts['ForYou']              ||
      []

    if (ids.length) {
      console.log(`[getRecommended] found ${ids.length} games via omni-recommendation`)
      return fetchGameDetails(ids)
    }
    return fetchGameDetails(FALLBACK)
  } catch (e) {
    console.error('[getRecommended]', e.message)
    return fetchGameDetails(FALLBACK)
  }
})

// ---- GAME DETAIL ---------------------------------------------
// Fetches everything needed for both the game detail overlay and
// the game modal: game info, icon/thumbnail, screenshots, server
// count, favorites count, and resolved creator name.
ipcMain.handle('roblox:getGameDetail', async (_, universeId) => {
  try {
    const cookie = await getRobloxCookie()
    const cookieHeader = cookie ? { Cookie: `.ROBLOSECURITY=${cookie}` } : {}

    const [gameRes, iconRes, screenshotRes, serverRes] = await Promise.allSettled([
      fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
      fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=512x512&format=Png`),
      fetch(`https://thumbnails.roblox.com/v1/games/screenshots?universeId=${universeId}&size=768x432&format=Png&limit=10`),
      fetch(`https://games.roblox.com/v1/games/${universeId}/servers/Public?limit=10`, { headers: cookieHeader }),
    ])

    const game = gameRes.status === 'fulfilled'
      ? (await gameRes.value.json()).data?.[0]
      : null
    if (!game) throw new Error('Game not found')

    const iconUrl = iconRes.status === 'fulfilled'
      ? (await iconRes.value.json()).data?.[0]?.imageUrl || null
      : null
    // thumbnailUrl is used interchangeably with iconUrl by the renderer
    const thumbnailUrl = iconUrl

    const screenshotData = screenshotRes.status === 'fulfilled'
      ? await screenshotRes.value.json()
      : null
    const screenshots = (screenshotData?.data || []).map(s => s.imageUrl).filter(Boolean)

    const serverData = serverRes.status === 'fulfilled' && serverRes.value.ok
      ? await serverRes.value.json()
      : null
    const serverCount = serverData?.data?.length ?? null

    // Resolve group creator name
    let creatorName = game.creator?.name || null
    if (game.creator?.type === 'Group' && game.creator?.id) {
      try {
        const grpRes  = await fetch(`https://groups.roblox.com/v1/groups/${game.creator.id}`)
        const grpData = await grpRes.json()
        creatorName   = grpData.name || creatorName
      } catch {}
    }

    // Favorites count (separate endpoint)
    let favoritesCount = null
    try {
      const favRes  = await fetch(`https://games.roblox.com/v1/games/${universeId}/favorites/count`)
      const favData = await favRes.json()
      favoritesCount = favData.favoritesCount ?? null
    } catch {}

    const upVotes   = game.totalUpVotes   || 0
    const downVotes = game.totalDownVotes || 0
    const rating    = (upVotes + downVotes) > 0
      ? Math.round(upVotes / (upVotes + downVotes) * 100)
      : null

    return {
      id:            game.id,
      rootPlaceId:   game.rootPlaceId,
      name:          game.name,
      description:   game.description || 'No description provided.',
      creator:       game.creator?.name || 'Unknown',
      creatorName,
      creatorType:   game.creator?.type || 'User',
      playing:       game.playing    || 0,
      visits:        game.visits     || 0,
      maxPlayers:    game.maxPlayers || 0,
      genre:         game.genre      || null,
      isActive:      game.isActive   ?? true,
      created:       game.created,
      updated:       game.updated,
      favoritesCount,
      rating,
      upVotes,
      downVotes,
      iconUrl,
      thumbnailUrl,
      screenshots,
      serverCount,
    }
  } catch (e) {
    return { error: e.message }
  }
})

// ---- SEARCH / BROWSE HELPER ---------------------------------
const DEFAULT_FETCH_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
}

// games.roblox.com/v1/games/list (the old "model.keyword=" endpoint)
// has been deprecated and no longer returns useful results. Roblox's
// site search now runs through the omni-search endpoint, which returns
// a list of universeIds we can then feed into fetchGameDetails().
async function fetchWithRetries(fn, retries = 5, baseDelay = 500) {
  let attempt = 0
  let lastError = null
  while (attempt < retries) {
    try {
      const res = await fn()
      const status = res?.status
      if (res && res.ok) return res
      if (res && [429, 500, 502, 503, 504].includes(status)) {
        const wait = baseDelay * Math.pow(2, attempt)
        console.warn(`[main] fetchWithRetries retry ${attempt + 1}/${retries} status=${status}, waiting ${wait}ms`)
        await new Promise(r => setTimeout(r, wait))
        attempt++
        continue
      }
      lastError = res ? new Error(`HTTP ${status}`) : new Error('No response')
      if (res) {
        console.warn(`[main] fetchWithRetries non-retriable status=${status}`)
      }
      return res
    } catch (e) {
      lastError = e
      const wait = baseDelay * Math.pow(2, attempt)
      console.warn(`[main] fetchWithRetries exception ${attempt + 1}/${retries}: ${e.message}, waiting ${wait}ms`)
      await new Promise(r => setTimeout(r, wait))
      attempt++
    }
  }
  console.error('[main] fetchWithRetries failed after retries', lastError?.message)
  return null
}

async function fetchOmniSearchIds(query, cookie, pageToken) {
  const params = new URLSearchParams({
    searchQuery: query,
    sessionId:   crypto.randomUUID(),
    pageType:    'all',
  })
  if (pageToken) params.set('pageToken', pageToken)

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  }
  if (cookie) headers['Cookie'] = `.ROBLOSECURITY=${cookie}`

  const res = await fetchWithRetries(() => fetch(`https://apis.roblox.com/search-api/omni-search?${params}`, { headers }))
  if (!res) throw new Error('omni-search failed after retries')
  if (!res.ok) throw new Error(`omni-search failed: ${res.status}`)
  const data = await res.json()

  const ids = []
  for (const result of data.searchResults || []) {
    const items = Array.isArray(result.contents) ? result.contents : [result]
    for (const item of items) {
      const type = (item.contentType || result.contentType || '').toLowerCase()
      if (type && type !== 'game' && type !== 'place') continue
      const id = item.contentId ?? item.universeId ?? item.rootPlaceId ?? item.id
      if (id) ids.push(Number(id))
    }
  }
  return { ids: [...new Set(ids)].filter(n => !Number.isNaN(n)), nextPageToken: data.nextPageToken || null }
}

ipcMain.handle('roblox:searchGames', async (_, keyword) => {
  try {
    const cookie = await getRobloxCookie()
    const { ids } = await fetchOmniSearchIds(keyword, cookie)
    if (!ids.length) return []
    return await fetchGameDetails(ids.slice(0, 24))
  } catch (e) {
    return { error: e.message }
  }
})

// ---- BROWSE / DISCOVER GAMES --------------------------------
// Used by the Games page genre filters + sort + "See All" + Load More.
const GENRE_KEYWORDS = {
  all:       'Popular Games',
  rpg:       'RPG',
  shooter:   'Shooter',
  roleplay:  'Roleplay',
  simulator: 'Simulator',
  obby:      'Obby',
  tycoon:    'Tycoon',
}

// omni-search is cursor-paginated (pageToken), not offset-based, so we
// cache the accumulated id list + cursor per genre and slice from it.
const browseCache = new Map() // genre -> { ids: number[], nextPageToken, exhausted }

async function getBrowsePage(genre, page, pageSize) {
  const keyword = GENRE_KEYWORDS[genre] || GENRE_KEYWORDS.all
  let entry = browseCache.get(genre)
  if (!entry) {
    entry = { ids: [], nextPageToken: undefined, exhausted: false }
    browseCache.set(genre, entry)
  }

  const cookie = await getRobloxCookie()
  while (entry.ids.length < (page + 1) * pageSize && !entry.exhausted) {
    const { ids, nextPageToken } = await fetchOmniSearchIds(keyword, cookie, entry.nextPageToken)
    if (!ids.length) {
      if (nextPageToken) {
        entry.nextPageToken = nextPageToken
        continue
      }
      entry.exhausted = true
      break
    }
    for (const id of ids) {
      if (!entry.ids.includes(id)) entry.ids.push(id)
    }
    entry.nextPageToken = nextPageToken || undefined
    if (!nextPageToken) entry.exhausted = true
  }

  return entry.ids.slice(page * pageSize, (page + 1) * pageSize)
}

ipcMain.handle('roboot:clearBrowseCache', (_, genre) => {
  if (!genre) {
    browseCache.clear()
  } else {
    browseCache.delete(genre)
  }
  return { success: true }
})

ipcMain.handle('roblox:browseGames', async (_, opts = {}) => {
  const { genre = 'all', sort = 'popular', page = 0, maxRows = 24 } = opts || {}
  console.log('[main] roblox:browseGames', { genre, sort, page, maxRows })
  try {
    let ids = await getBrowsePage(genre, page, maxRows)
    console.log('[main] browse ids count', ids.length)
    if (!ids.length && genre !== 'all') {
      const keyword = GENRE_KEYWORDS[genre] || GENRE_KEYWORDS.all
      const fallback = await fetchOmniSearchIds(keyword, await getRobloxCookie())
      ids = fallback.ids.slice(0, maxRows)
      console.log('[main] browse fallback ids count', ids.length)
    }
    if (!ids.length) return []
    let games = await fetchGameDetails(ids)
    console.log('[main] fetchGameDetails returned', games.length)
    if (sort === 'rated') {
      games = games.slice().sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))
    } else {
      games = games.slice().sort((a, b) => (b.playing ?? 0) - (a.playing ?? 0))
    }
    return games
  } catch (e) {
    console.error('[main] roblox:browseGames error', e.message)
    return { error: e.message }
  }
})

// ---- LAUNCH ------------------------------------------------
ipcMain.handle('roblox:launchGame', async (_, placeId) => {
  try {
    await shell.openExternal(`roblox://experiences/start?placeId=${placeId}`)
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('roblox:launch', async () => {
  try {
    await shell.openExternal('roblox://navigation/home')
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ---- CUSTOM THEMES -------------------------------------------
ipcMain.handle('theme:list', () => {
  const { activeTheme } = readSettings()
  return { themes: listThemeFiles(), active: activeTheme || null }
})

ipcMain.handle('theme:upload', async () => {
  if (!mainWindow) return { success: false, error: 'No window' }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a theme (.css file only)',
    properties: ['openFile'],
    filters: [{ name: 'CSS Theme', extensions: ['css'] }],
  })
  if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true }

  const srcPath = result.filePaths[0]
  if (!srcPath.toLowerCase().endsWith('.css')) {
    return { success: false, error: 'Only .css files are allowed' }
  }

  ensureThemesDir()
  let name = path.basename(srcPath)
  let destPath = path.join(THEMES_DIR(), name)
  // avoid clobbering an existing theme with the same filename
  let i = 1
  while (fs.existsSync(destPath)) {
    name = `${path.basename(srcPath, '.css')}-${i}.css`
    destPath = path.join(THEMES_DIR(), name)
    i++
  }

  try {
    fs.copyFileSync(srcPath, destPath)
    return { success: true, name }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('theme:apply', (_e, filename) => applyTheme(filename))

ipcMain.handle('theme:delete', (_e, filename) => {
  try {
    const filePath = path.join(ensureThemesDir(), filename)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    const { activeTheme } = readSettings()
    if (activeTheme === filename) {
      writeSettings({ activeTheme: null })
      // visual reset happens on next launch, or renderer can call theme:apply(null) itself
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ---- WINDOW CONTROLS ---------------------------------------
ipcMain.on('roboot:win-close', () => {
  console.log('[roboot] win-close received')
  mainWindow?.close()
})
ipcMain.on('roboot:win-minimize', () => {
  console.log('[roboot] win-minimize received')
  mainWindow?.minimize()
})
ipcMain.on('roboot:win-maximize', () => {
  console.log('[roboot] win-maximize received, isMaximized =', mainWindow?.isMaximized())
  if (!mainWindow) return
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})