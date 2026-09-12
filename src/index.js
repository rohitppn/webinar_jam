import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, isDataDirEphemeral } from './config.js'
import { startWhatsApp, wa } from './wa.js'
import { handleInbound } from './inbound.js'
import { startDispatcher } from './dispatcher.js'
import { startScheduler } from './scheduler.js'
import { initSheets } from './sheets.js'
import { buildRoutes } from './routes.js'
import { db } from './store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true, limit: '2mb' }))

// Railway health check — must not require auth.
app.get('/health', (req, res) => res.json({ ok: true, wa: wa.status, uptime: process.uptime() }))

const routes = buildRoutes()
// The webhook authenticates with its own token, so it bypasses basic auth.
app.use((req, res, next) => {
  if (req.path.startsWith('/webhook/') || req.path === '/health') return next()
  const hdr = req.get('authorization') || ''
  const [, b64] = hdr.split(' ')
  const [u, p] = Buffer.from(b64 || '', 'base64').toString().split(':')
  if (u === config.adminUser && p === config.adminPass) return next()
  res.set('WWW-Authenticate', 'Basic realm="TheBroThing Sequencer"').status(401).send('Auth required')
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
  console.log(`  contacts   : ${db.allContacts().length}\n`)
  if (isDataDirEphemeral) {
    console.warn('  !! No /data volume mounted on Railway — the WhatsApp session will be lost on redeploy.')
    console.warn('  !! Add a Volume with mount path /data in the Railway service settings.\n')
  }
  initSheets()
  startWhatsApp()
  startDispatcher()
  startScheduler()
})

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e))
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e))
