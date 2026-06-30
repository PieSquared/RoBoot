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
      return {
        id:           f.id,
        username:     u.name        || f.name        || `User${f.id}`,
        displayName:  u.displayName || f.displayName || u.name || f.name || `User${f.id}`,
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

// ---- GAME DETAILS HELPER -----------------------------------
async function fetchGameDetails(universeIds) {
  if (!universeIds || !universeIds.length) return []
  const ids = universeIds.slice(0, 50).join(',')
  const [gamesRes, thumbsRes] = await Promise.all([
    fetch(`https://games.roblox.com/v1/games?universeIds=${ids}`),
    fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids}&size=150x150&format=Png`)
  ])
  const gamesData  = await gamesRes.json()
  const thumbsData = await thumbsRes.json()
  const thumbMap   = {}
  for (const t of thumbsData.data || []) thumbMap[t.targetId] = t.imageUrl
  return (gamesData.data || []).map(g => ({
    id:           g.id,
    rootPlaceId:  g.rootPlaceId,
    name:         g.name,
    playing:      g.playing || 0,
    visits:       g.visits  || 0,
    rating:       (g.totalUpVotes + g.totalDownVotes) > 0
                    ? Math.round(g.totalUpVotes / (g.totalUpVotes + g.totalDownVotes) * 100)
                    : null,
    thumbnailUrl: thumbMap[g.id] || null,
  }))
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
      return fetchGameDetails(ids.slice(0, 8))
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
      return fetchGameDetails(ids.slice(0, 8))
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
// games.roblox.com/v1/games/list (the old "model.keyword=" endpoint)
// has been deprecated and no longer returns useful results. Roblox's
// site search now runs through the omni-search endpoint, which returns
// a list of universeIds we can then feed into fetchGameDetails().
async function fetchOmniSearchIds(query, cookie, pageToken) {
  const params = new URLSearchParams({
    searchQuery: query,
    sessionId:   crypto.randomUUID(),
    pageType:    'all',
  })
  if (pageToken) params.set('pageToken', pageToken)

  const headers = {}
  if (cookie) headers['Cookie'] = `.ROBLOSECURITY=${cookie}`

  const res = await fetch(`https://apis.roblox.com/search-api/omni-search?${params}`, { headers })
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
    if (!ids.length) { entry.exhausted = true; break }
    for (const id of ids) if (!entry.ids.includes(id)) entry.ids.push(id)
    entry.nextPageToken = nextPageToken || undefined
    if (!nextPageToken) entry.exhausted = true
  }

  return entry.ids.slice(page * pageSize, (page + 1) * pageSize)
}

ipcMain.handle('roblox:browseGames', async (_, opts = {}) => {
  const { genre = 'all', sort = 'popular', page = 0, maxRows = 24 } = opts || {}
  try {
    const ids = await getBrowsePage(genre, page, maxRows)
    if (!ids.length) return []
    let games = await fetchGameDetails(ids)
    if (sort === 'rated') {
      games = games.slice().sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))
    } else {
      games = games.slice().sort((a, b) => (b.playing ?? 0) - (a.playing ?? 0))
    }
    return games
  } catch (e) {
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