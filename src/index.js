import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, isDataDirEphemeral } from './config.js'
import { startWhatsApp, wa } from './wa.js'
import { handleInbound } from './inbound.js'
import { startDispatcher } from './dispatcher.js'
import { startScheduler } from './scheduler.js'
import { initSheets } from './sheets.js'
import { initSupabase, sbFetchContacts } from './supabase.js'
import { buildRoutes } from './routes.js'
import { db } from './store.js'
import { signIn, signOut, sessionFor, basicAuthOk, sessionCookie, clearCookie, parseCookies, supabaseAuthEnabled } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true, limit: '2mb' }))

// Railway health check — must not require auth.
app.get('/health', (req, res) => res.json({ ok: true, wa: wa.status, uptime: process.uptime() }))

const routes = buildRoutes()

// --- sign in / out (must sit before the auth gate) ---
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')))
app.get('/api/auth/mode', (req, res) =>
  res.json({ supabase: supabaseAuthEnabled(), session: sessionFor(req)?.email || null }))
app.post('/api/login', async (req, res) => {
  try {
    const { sessionId, email, days } = await signIn(req.body.email, req.body.password, req.ip)
    res.set('Set-Cookie', sessionCookie(sessionId)).json({ ok: true, email, days })
  } catch (e) {
    res.status(401).json({ ok: false, error: e.message })
  }
})
app.post('/api/auth/logout', (req, res) => {
  signOut(parseCookies(req).sid)
  res.set('Set-Cookie', clearCookie()).json({ ok: true })
})

// The webhook carries its own token, so it bypasses the dashboard gate.
app.use((req, res, next) => {
  if (req.path.startsWith('/webhook/') || req.path === '/health') return next()
  if (sessionFor(req)) return next()
  if (basicAuthOk(req)) return next()          // break-glass
  // Browsers get the sign-in page; API callers get a clean 401.
  if (req.accepts('html') && !req.path.startsWith('/api/')) return res.redirect('/login')
  return res.status(401).json({ ok: false, error: 'not signed in' })
})
app.use(routes)
app.use(express.static(path.join(__dirname, '..', 'public')))

wa.onInbound = handleInbound

app.listen(config.port, () => {
  console.log(`\n  TheBroThing WhatsApp Sequencer`)
  console.log(`  admin      : http://localhost:${config.port}/`)
  console.log(`  webhook    : POST /webhook/webinarjam?token=${config.webhookToken.slice(0, 3)}***`)
  console.log(`  data dir   : ${config.dataDir}`)
  console.log(`  throttle   : ${config.burstSize}/burst, ${config.burstRestMinutes} min rest, ${config.minGapSeconds}-${config.maxGapSeconds}s gaps, cap ${config.dailyCap}/day`)
  console.log(`  window     : ${config.quietStartHour}:00-${config.quietEndHour}:00 ${config.tz}`)
  console.log(`  dry run    : ${config.dryRun}`)
  console.log(`  sign-in    : ${supabaseAuthEnabled() ? 'Supabase Auth + break-glass admin' : 'break-glass admin only (set SUPABASE_ANON_KEY)'}`)
  console.log(`  contacts   : ${db.allContacts().length}\n`)
  if (isDataDirEphemeral) {
    console.warn('  !! No /data volume mounted on Railway — the WhatsApp session will be lost on redeploy.')
    console.warn('  !! Add a Volume with mount path /data in the Railway service settings.\n')
  }
  initSheets()
  initSupabase().then(restoreFromSupabaseIfEmpty)
  startWhatsApp()
  startDispatcher()
  startScheduler()
})

/** If the volume came up empty but Supabase has contacts, pull them back. */
async function restoreFromSupabaseIfEmpty() {
  try {
    if (db.allContacts().length > 0) return
    const rows = await sbFetchContacts()
    if (!rows.length) return
    for (const c of rows) db.state.contacts[c.phone] = c
    db.ops('supabase_restore', `${rows.length} contacts restored`)
    console.log(`[supabase] restored ${rows.length} contacts into an empty volume`)
  } catch (e) {
    console.error('[supabase] restore skipped:', e.message)
  }
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e))
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e))
