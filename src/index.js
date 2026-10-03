import express from 'express'
import fs from 'node:fs'
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
import { db, hadStateFile } from './store.js'
import { normalisePhone, firstNameOf } from './phone.js'
import { enqueueInstant } from './scheduler.js'
import { syncContact, logOps } from './sheets.js'
import { eventStart, now } from './time.js'
import { signIn, signOut, sessionFor, basicAuthOk, sessionCookie, clearCookie, parseCookies, supabaseAuthEnabled } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true, limit: '2mb' }))

// Railway health check — must not require auth.
app.get('/health', (req, res) => res.json({ ok: true, wa: wa.status, uptime: process.uptime() }))

const routes = buildRoutes()

// --- public registration form (no auth: it is the front door) ---
const regHits = new Map() // ip -> timestamps, a light brake on abuse
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'register.html')))
app.get('/api/event-info', (req, res) => {
  const ev = eventStart()
  const time = ev.minute === 0 ? ev.toFormat('h a') : ev.toFormat('h:mm a')
  res.json({
    when: `${ev.toFormat('cccc d LLLL')}, ${time} IST`,
    // the campaign number, so the thank-you page can deep-link into the chat
    whatsapp: (wa.me || '').split(':')[0].split('@')[0] || null,
    group: config.whatsappGroupLink || null,
    video: videoEmbedUrl(),
    poster: config.welcomeVideoPoster || null
  })
})

/** Share links are not embeddable; each host has its own player url. */
function videoEmbedUrl() {
  const raw = (config.welcomeVideo || '').trim()
  if (!raw) return null

  // Vimeo, including the unlisted form vimeo.com/<id>/<privacy hash>
  // Autoplay is only permitted muted, which is what the guide asks for: it plays on
  // arrival with captions, and the viewer turns sound on from the player.
  const vim = raw.match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([A-Za-z0-9]+))?/)
  if (vim) {
    const q = new URLSearchParams({
      badge: '0', byline: '0', portrait: '0', title: '0', dnt: '1',
      autoplay: '1', muted: '1', playsinline: '1', texttrack: config.videoTexttrack
    })
    if (vim[2]) q.set('h', vim[2])
    return `https://player.vimeo.com/video/${vim[1]}?${q}`
  }

  // YouTube, unlisted or otherwise
  const yt = raw.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([A-Za-z0-9_-]{6,})/)
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}?rel=0&modestbranding=1&autoplay=1&mute=1&playsinline=1&cc_load_policy=1`

  // Google Drive
  const gd = raw.match(/\/d\/([A-Za-z0-9_-]{10,})/) || raw.match(/[?&]id=([A-Za-z0-9_-]{10,})/)
  if (gd) return `https://drive.google.com/file/d/${gd[1]}/preview`
  if (/^[A-Za-z0-9_-]{20,}$/.test(raw)) return `https://drive.google.com/file/d/${raw}/preview`

  return raw   // already an embeddable url, or a direct mp4
}

app.get(['/thanks', '/thank-you'], (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'thanks.html')))

// A calendar invite the registrant can actually save.
app.get('/event.ics', (req, res) => {
  const ev = eventStart()
  const end = ev.plus({ minutes: 90 })
  const fmt = (d) => d.toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'")
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TheBroThing//Masterclass//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:masterclass-${ev.toFormat('yyyyLLdd')}@thebrothing`,
    `DTSTAMP:${fmt(now())}`, `DTSTART:${fmt(ev)}`, `DTEND:${fmt(end)}`,
    'SUMMARY:Double Your Dating Masterclass',
    'DESCRIPTION:90 minutes live. The room link lands in the WhatsApp group an hour before we start.',
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:Masterclass starts in 30 minutes',
    'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n')
  res.set('Content-Disposition', 'attachment; filename="masterclass.ics"').type('text/calendar').send(ics)
})
app.post('/register', async (req, res) => {
  const b = req.body || {}
  if (b.website) return res.json({ ok: true, first_name: 'there' })   // honeypot: bots fill it, people don't
  const now = Date.now()
  const hits = (regHits.get(req.ip) || []).filter((t) => now - t < 60 * 60 * 1000)
  if (hits.length >= 10) return res.status(429).json({ ok: false, error: 'Too many sign-ups from here. Try again later.' })
  regHits.set(req.ip, [...hits, now])

  const phone = normalisePhone(b.phone)
  if (!phone) return res.status(400).json({ ok: false, error: 'That does not look like a valid mobile number.' })
  const first_name = firstNameOf(b.name || b.first_name)
  const { contact } = db.upsertContact(phone, {
    first_name, full_name: String(b.name || '').trim(), email: b.email || '', source: 'register-form'
  })
  enqueueInstant(contact, 'M1')
  syncContact(contact)
  logOps('registration', `${phone} ${first_name} (registration form)`)
  res.json({ ok: true, first_name })
})

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
  if (['/register', '/thanks', '/thank-you', '/event.ics', '/api/event-info'].includes(req.path)) return next()
  const sess = sessionFor(req)
  if (sess) { res.locals.sessionEmail = sess.email; return next() }
  if (basicAuthOk(req)) return next()          // break-glass
  // Browsers get the sign-in page; API callers get a clean 401.
  if (req.accepts('html') && !req.path.startsWith('/api/')) return res.redirect('/login')
  return res.status(401).json({ ok: false, error: 'not signed in' })
})
app.use(routes)

// Fingerprint the assets so the browser can cache them for a year, and serve the
// HTML with no-cache so a new build is picked up on the very next load.
const BUILD = String(Date.now())
app.get(['/', '/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
    .replace('src="app.js"', `src="app.js?v=${BUILD}"`)
  res.set('Cache-Control', 'no-cache').type('html').send(html)
})
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  maxAge: '1y',
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
    else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  }
}))

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

/** Rebuild contacts from Supabase, but only when the volume is genuinely new.
 *  An existing state file with no contacts is a deliberate state — someone deleted
 *  them — and restoring would resurrect people who were removed on purpose. */
async function restoreFromSupabaseIfEmpty() {
  try {
    if (db.allContacts().length > 0) return
    if (hadStateFile) {
      console.log('[supabase] volume has history and no contacts — treating that as deliberate, not restoring')
      return
    }
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
