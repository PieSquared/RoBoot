// ============================================================
//  RoBoot — auth.js
//  Token storage + PKCE helpers
//  OAuth window is handled in main.js (needs BrowserWindow)
// ============================================================

const crypto = require('crypto')
const { safeStorage, app } = require('electron')
const fs   = require('fs')
const path = require('path')

const CLIENT_ID   = '8472608127595747627'
const TOKEN_URL   = 'https://apis.roblox.com/oauth/v1/token'
const STORAGE_KEY = 'roboot_tokens'

// ---- PKCE helpers (exported so main.js can use them) -------
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
}

function generateCodeVerifier()          { return base64url(crypto.randomBytes(32)) }
function generateCodeChallenge(verifier) { return base64url(crypto.createHash('sha256').update(verifier).digest()) }
function generateState()                 { return base64url(crypto.randomBytes(16)) }

// ---- Token storage -----------------------------------------
function getTokenPath() {
  return path.join(app.getPath('userData'), STORAGE_KEY)
}

function saveTokens(tokens) {
  try {
    const data = JSON.stringify(tokens)
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(getTokenPath(), safeStorage.encryptString(data).toString('base64'))
    } else {
      fs.writeFileSync(getTokenPath(), Buffer.from(data).toString('base64'))
    }
  } catch (e) { console.error('saveTokens:', e) }
}

function loadTokens() {
  try {
    const p = getTokenPath()
    if (!fs.existsSync(p)) return null
    const buf = Buffer.from(fs.readFileSync(p, 'utf8'), 'base64')
    const raw = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8')
    return JSON.parse(raw)
  } catch (e) { console.error('loadTokens:', e); return null }
}

function clearTokens() {
  try { const p = getTokenPath(); if (fs.existsSync(p)) fs.unlinkSync(p) } catch {}
}

function isTokenExpired(tokens) {
  if (!tokens?.expires_at) return true
  return Date.now() >= tokens.expires_at - 60_000
}

async function refreshAccessToken(tokens) {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id:     CLIENT_ID,
    })
  })
  if (!res.ok) throw new Error('Failed to refresh token')
  const data = await res.json()
  const fresh = { ...data, expires_at: Date.now() + data.expires_in * 1000 }
  saveTokens(fresh)
  return fresh
}

async function getValidAccessToken() {
  let tokens = loadTokens()
  if (!tokens) return null
  if (isTokenExpired(tokens)) {
    try { tokens = await refreshAccessToken(tokens) }
    catch { clearTokens(); return null }
  }
  return tokens.access_token
}

// ---- Protocol callback (kept for macOS / second-instance) --
// The actual OAuth window is in main.js.
// This is only called if the system browser somehow fires the callback.
let pendingAuth = null

function startOAuthFlow() {
  // No-op — in-app flow is handled by startInAppOAuth() in main.js
  return Promise.reject(new Error('Use startInAppOAuth in main.js'))
}

function handleProtocolCallback(url) {
  if (!pendingAuth) return
  const { resolve, reject, state, verifier } = pendingAuth
  pendingAuth = null
  try {
    const parsed   = new URL(url.replace(/^rblxlaunch:\/\//, 'http://rblxlaunch/'))
    const code     = parsed.searchParams.get('code')
    const retState = parsed.searchParams.get('state')
    const error    = parsed.searchParams.get('error')
    if (error)              throw new Error(error)
    if (!code)              throw new Error('No code')
    if (retState !== state) throw new Error('State mismatch')
    resolve(code)
  } catch (e) { reject(e) }
}

module.exports = {
  // OAuth window helpers
  startOAuthFlow,
  handleProtocolCallback,
  // Token management
  saveTokens,
  loadTokens,
  clearTokens,
  getValidAccessToken,
  isTokenExpired,
  // PKCE — used by main.js to build the auth URL
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
}