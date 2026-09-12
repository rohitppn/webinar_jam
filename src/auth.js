import crypto from 'node:crypto'
import { config } from './config.js'
import { db, save } from './store.js'

// Dashboard sign-in goes through Supabase Auth. We never see or store a password:
// the credentials are exchanged with Supabase, and what we keep is an opaque session id.
// ADMIN_USER / ADMIN_PASS still works as a break-glass route, so a Supabase outage or a
// misconfigured project can never lock the operator out mid-campaign.

const SESSION_DAYS = 7
const MAX_ATTEMPTS = 8
const attempts = new Map() // ip -> { count, until }

export const supabaseAuthEnabled = () => !!(config.supabaseUrl && config.supabaseAnonKey)

function sessions() {
  db.state.sessions = db.state.sessions || {}
  return db.state.sessions
}

function pruneSessions() {
  const s = sessions()
  const now = Date.now()
  let changed = false
  for (const [id, v] of Object.entries(s)) {
    if (!v.expires || v.expires < now) { delete s[id]; changed = true }
  }
  if (changed) save()
}
setInterval(pruneSessions, 60 * 60 * 1000).unref()

export function parseCookies(req) {
  const out = {}
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** Exchange email + password with Supabase. Returns the user, or throws. */
export async function signIn(email, password, ip) {
  const rec = attempts.get(ip)
  if (rec && rec.count >= MAX_ATTEMPTS && rec.until > Date.now()) {
    throw new Error('Too many attempts. Try again in a few minutes.')
  }
  if (!supabaseAuthEnabled()) throw new Error('Supabase sign-in is not configured on this server.')

  const res = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const r = attempts.get(ip) || { count: 0 }
    attempts.set(ip, { count: r.count + 1, until: Date.now() + 10 * 60 * 1000 })
    throw new Error(data.error_description || data.msg || data.message || 'Invalid email or password')
  }
  attempts.delete(ip)

  const id = crypto.randomBytes(32).toString('hex')
  sessions()[id] = {
    email: data.user?.email || email,
    userId: data.user?.id || '',
    created: Date.now(),
    expires: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  }
  save()
  return { sessionId: id, email: data.user?.email || email, days: SESSION_DAYS }
}

export function signOut(sessionId) {
  if (sessionId && sessions()[sessionId]) { delete sessions()[sessionId]; save() }
}

export function sessionFor(req) {
  const id = parseCookies(req).sid
  if (!id) return null
  const s = sessions()[id]
  if (!s || s.expires < Date.now()) return null
  return { id, ...s }
}

/** Break-glass: the shared ADMIN_USER / ADMIN_PASS over HTTP basic auth. */
export function basicAuthOk(req) {
  const [, b64] = (req.get('authorization') || '').split(' ')
  if (!b64) return false
  const [u, p] = Buffer.from(b64, 'base64').toString().split(':')
  return u === config.adminUser && p === config.adminPass && p !== 'change-me'
}

export const sessionCookie = (id) =>
  `sid=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${config.secureCookies ? '; Secure' : ''}`
export const clearCookie = () => 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'
