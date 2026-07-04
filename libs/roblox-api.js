const { session } = require('electron')
const crypto = require('crypto')

const RBX_PARTITION = 'persist:roblox'
const DEFAULT_FETCH_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
}

const GENRE_KEYWORDS = {
  all:       'Popular Games',
  rpg:       'RPG',
  shooter:   'Shooter',
  roleplay:  'Roleplay',
  simulator: 'Simulator',
  obby:      'Obby',
  tycoon:    'Tycoon',
}

const browseCache = new Map() // genre -> { ids: number[], nextPageToken, exhausted }
const gameDetailCache = new Map()
const MIN_RETRY_JITTER = 150

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function parseRetryAfter(headers) {
  if (!headers || typeof headers.get !== 'function') return null
  const value = headers.get('Retry-After')
  if (!value) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

async function fetchWithRetries(fn, retries = 3, baseDelay = 400) {
  let attempt = 0
  let lastError = null

  while (attempt < retries) {
    try {
      const res = await fn()
      const status = res?.status
      if (res && res.ok) return res

      if (res && [429, 500, 502, 503, 504].includes(status)) {
        const serverRetry = parseRetryAfter(res.headers)
        const baseWait = baseDelay * Math.pow(2, attempt)
        const jitter = Math.floor(Math.random() * MIN_RETRY_JITTER)
        const wait = Math.max(baseWait, serverRetry || 0) + jitter
        console.warn(`[roblox-api] fetchWithRetries retry ${attempt + 1}/${retries} status=${status} wait=${wait}`)
        await sleep(wait)
        attempt++
        continue
      }

      lastError = res ? new Error(`HTTP ${status}`) : new Error('No response')
      if (res) console.warn(`[roblox-api] fetchWithRetries non-retriable status=${status}`)
      return res
    } catch (error) {
      lastError = error
      const wait = baseDelay * Math.pow(2, attempt)
      console.warn(`[roblox-api] fetchWithRetries exception ${attempt + 1}/${retries}: ${error.message}, wait=${wait}`)
      await sleep(wait)
      attempt++
    }
  }

  console.error('[roblox-api] fetchWithRetries failed after retries', lastError?.message)
  return null
}

async function getRobloxCookie() {
  try {
    const rblxSession = session.fromPartition(RBX_PARTITION)
    const cookies = await rblxSession.cookies.get({ domain: '.roblox.com', name: '.ROBLOSECURITY' })
    return cookies.length > 0 ? cookies[0].value : null
  } catch (error) {
    console.warn('[roblox-api] getRobloxCookie failed', error.message)
    return null
  }
}

async function fetchOmniSorts(cookie) {
  const now = Date.now()
  const headers = {
    'Content-Type': 'application/json',
    ...(cookie ? { Cookie: `.ROBLOSECURITY=${cookie}` } : {}),
  }

  const res = await fetchWithRetries(() => fetch('https://apis.roblox.com/discovery-api/omni-recommendation', {
    method: 'POST',
    headers,
    body: JSON.stringify({ pageType: 'Home', sessionId: crypto.randomUUID() }),
  }))

  if (!res) throw new Error('omni-recommendation failed after retries')
  if (!res.ok) throw new Error(`omni-recommendation failed: ${res.status}`)

  const data = await res.json()
  const sorts = {}
  for (const sort of data.sorts || []) {
    const ids = (sort.recommendationList || []).map(r => r.contentId).filter(Boolean)
    if (ids.length) sorts[sort.topic] = ids
  }

  return sorts
}

async function fetchOmniSearchIds(query, cookie, pageToken) {
  const params = new URLSearchParams({
    searchQuery: query,
    sessionId:   crypto.randomUUID(),
    pageType:    'all',
  })
  if (pageToken) params.set('pageToken', pageToken)

  const headers = {
    ...DEFAULT_FETCH_HEADERS,
    ...(cookie ? { Cookie: `.ROBLOSECURITY=${cookie}` } : {}),
  }

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

  return {
    ids: [...new Set(ids)].filter(n => !Number.isNaN(n)),
    nextPageToken: data.nextPageToken || null,
  }
}

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
    for (const id of ids) if (!entry.ids.includes(id)) entry.ids.push(id)
    entry.nextPageToken = nextPageToken || undefined
    if (!nextPageToken) entry.exhausted = true
  }

  return entry.ids.slice(page * pageSize, (page + 1) * pageSize)
}

async function fetchGameDetails(universeIds, maxResults = Infinity) {
  if (!Array.isArray(universeIds) || !universeIds.length) return []

  const uniqueIds = [...new Set(universeIds.map(id => Number(id)).filter(id => Number.isFinite(id)))]
  if (!uniqueIds.length) return []
  const limitedIds = uniqueIds.slice(0, maxResults)

  const cachedResults = limitedIds
    .filter(id => gameDetailCache.has(id))
    .map(id => gameDetailCache.get(id))

  const missingIds = limitedIds.filter(id => !gameDetailCache.has(id))
  if (!missingIds.length) return cachedResults

  const chunkSize = 6
  for (let i = 0; i < missingIds.length; i += chunkSize) {
    const batch = missingIds.slice(i, i + chunkSize)
    const ids = batch.join(',')
    const [gamesRes, thumbsRes] = await Promise.all([
      fetchWithRetries(() => fetch(`https://games.roblox.com/v1/games?universeIds=${ids}`, { headers: DEFAULT_FETCH_HEADERS })),
      fetchWithRetries(() => fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids}&size=150x150&format=Png`, { headers: DEFAULT_FETCH_HEADERS })),
    ])

    if (!gamesRes || !gamesRes.ok) {
      console.warn('[roblox-api] fetchGameDetails skipped failed games chunk', ids, gamesRes?.status)
      await sleep(250)
      continue
    }

    let gamesData
    try {
      gamesData = await gamesRes.json()
    } catch (error) {
      console.warn('[roblox-api] fetchGameDetails failed to parse games chunk', ids, error.message)
      continue
    }

    const thumbsData = thumbsRes && thumbsRes.ok ? await thumbsRes.json().catch(() => ({ data: [] })) : { data: [] }
    const thumbMap = {}
    for (const t of thumbsData.data || []) {
      if (t.targetId) thumbMap[t.targetId] = t.imageUrl
    }

    for (const g of gamesData.data || []) {
      if (!g || !g.id) continue
      const item = {
        id:           g.id,
        rootPlaceId:  g.rootPlaceId,
        name:         g.name,
        playing:      g.playing || 0,
        visits:       g.visits || 0,
        rating:       (g.totalUpVotes + g.totalDownVotes) > 0
                        ? Math.round(g.totalUpVotes / (g.totalUpVotes + g.totalDownVotes) * 100)
                        : null,
        thumbnailUrl: thumbMap[g.id] || null,
      }
      gameDetailCache.set(g.id, item)
    }

    await sleep(100)
  }

  return limitedIds.map(id => gameDetailCache.get(id)).filter(Boolean)
}

async function browseGames(genre = 'all', sort = 'popular', page = 0, maxRows = 24) {
  const ids = await getBrowsePage(genre, page, maxRows)
  if (!ids.length && genre !== 'all') {
    const keyword = GENRE_KEYWORDS[genre] || GENRE_KEYWORDS.all
    const fallback = await fetchOmniSearchIds(keyword, await getRobloxCookie())
    return fallback.ids.slice(0, maxRows)
  }
  return ids
}

async function searchGames(keyword) {
  const cookie = await getRobloxCookie()
  const { ids } = await fetchOmniSearchIds(keyword, cookie)
  if (!ids.length) return []
  return fetchGameDetails(ids.slice(0, 24))
}

function clearBrowseCache(genre) {
  if (!genre) browseCache.clear()
  else browseCache.delete(genre)
}

module.exports = {
  getRobloxCookie,
  fetchOmniSorts,
  fetchOmniSearchIds,
  fetchGameDetails,
  browseGames,
  searchGames,
  clearBrowseCache,
}
