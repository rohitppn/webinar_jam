import express from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { db, save } from './store.js'
import { wa, logout } from './wa.js'
import { dispatcher, blockedReason } from './dispatcher.js'
import { runScheduler, enqueueInstant, timeline } from './scheduler.js'
import { sendSS, handleInbound } from './inbound.js'
import { normalisePhone, firstNameOf } from './phone.js'
import { syncContact, sheetsState, logOps } from './sheets.js'
import { supabaseState, sbCounts, sbPeek, sbPurge } from './supabase.js'
import { now, isoStamp } from './time.js'
import { MESSAGES, BY_ID } from './sequence.js'
import { render, missingFields, unsetConfigFields } from './render.js'
import { messageLog, inboundLog, messageStats, toCsv } from './logs.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

export function buildRoutes() {
  const r = express.Router()

  // ---------- WebinarJam webhook (no basic-auth; guarded by token) ----------
  // Accept the token from the query string, the body, a header, or the path — integration
  // tools vary in what they preserve, and a stripped query string should not look like silence.
  const webhookHandler = (req, res) => {
    const token = req.query.token || req.body?.token || req.get('x-webhook-token') || req.params.token
    const b = { ...(req.query || {}), ...(req.body || {}) }
    // Record every hit, accepted or not, so a misconfigured sender is visible instead of invisible.
    const hit = {
      at: isoStamp(),
      method: req.method,
      ip: req.ip,
      ua: (req.get('user-agent') || '').slice(0, 120),
      contentType: req.get('content-type') || '',
      queryKeys: Object.keys(req.query || {}),
      bodyKeys: Object.keys(req.body || {}),
      body: JSON.stringify(b).slice(0, 800),
      result: ''
    }
    db.state.webhookHits = db.state.webhookHits || []

    const finish = (result, status, payload) => {
      hit.result = result
      db.state.webhookHits.unshift(hit)
      db.state.webhookHits = db.state.webhookHits.slice(0, 50)
      save()
      return res.status(status).json(payload)
    }

    if (token !== config.webhookToken) {
      logOps('webhook_bad_token', `from ${req.ip} ua=${hit.ua.slice(0, 40)}`)
      return finish('rejected: bad or missing token', 401, { ok: false, error: 'bad token' })
    }

    const rawPhone = b.phone || b.phone_number || b.mobile || b.whatsapp || b.user_phone || b.telephone || b.number
    const rawName = b.first_name || b.firstname || b.name || b.full_name || b.user_name
    const email = b.email || b.user_email || ''
    const phone = normalisePhone(rawPhone)

    if (!phone) {
      logOps('webhook_bad_phone', JSON.stringify(b).slice(0, 400))
      return finish('rejected: no usable phone field', 200, { ok: false, error: 'no usable phone', received: b })
    }

    const { contact, created } = db.upsertContact(phone, {
      first_name: firstNameOf(b.first_name || rawName),
      full_name: String(rawName || '').trim(),
      email,
      source: 'webinarjam',
      registered_at: isoStamp()
    })
    const q = enqueueInstant(contact, 'M1')
    syncContact(contact)
    logOps(created ? 'registration' : 'registration_duplicate', `${phone} ${contact.first_name}`)
    return finish(`accepted: ${phone}${created ? ' (new)' : ' (duplicate)'}`, 200, { ok: true, phone, created, m1_queued: !!q })
  }

  r.all('/webhook/webinarjam', webhookHandler)
  r.all('/webhook/webinarjam/:token', webhookHandler)

  // Recent webhook traffic — the first place to look when registrations are not arriving.
  r.get('/api/webhook-hits', (req, res) => res.json(db.state.webhookHits || []))

  // ---------- everything below is admin (basic-auth applied in index.js) ----------
  r.get('/api/status', (req, res) => {
    db.rollDayCounters()
    const contacts = db.allContacts()
    res.json({
      wa: { status: wa.status, me: wa.me, lastError: wa.lastError, qrAt: wa.qrGeneratedAt },
      sheets: sheetsState(),
      supabase: supabaseState(),
      dispatcher: { ...dispatcher, blocked: blockedReason(null) },
      throttle: {
        burstSize: config.burstSize,
        burstRestMinutes: config.burstRestMinutes,
        gap: `${config.minGapSeconds}-${config.maxGapSeconds}s`,
        dailyCap: config.dailyCap,
        window: `${config.quietStartHour}:00-${config.quietEndHour}:00`,
        burstCount: db.counters.burstCount,
        sentToday: db.counters.sentToday,
        restUntil: db.counters.restUntil
      },
      settings: db.settings,
      unsetConfig: unsetConfigFields(),
      webhookToken: config.webhookToken,
      stats: {
        contacts: contacts.length,
        confirmed: contacts.filter((c) => c.confirmed).length,
        replied: contacts.filter((c) => c.inboundCount > 0).length,
        optedOut: contacts.filter((c) => c.optedOut).length,
        attended: contacts.filter((c) => c.attended).length,
        booked: contacts.filter((c) => c.booked).length,
        queuePending: db.queue.filter((q) => q.status === 'pending').length,
        screenshotsPending: db.state.screenshots.filter((s) => !s.handled).length
      },
      now: now().toFormat('ccc dd LLL yyyy, HH:mm:ss ZZZZ'),
      dryRun: config.dryRun
    })
  })

  r.get('/api/qr', (req, res) => res.json({ status: wa.status, qr: wa.qrDataUrl, at: wa.qrGeneratedAt }))
  r.post('/api/logout', async (req, res) => { await logout(); res.json({ ok: true }) })

  r.get('/api/timeline', (req, res) => res.json(timeline()))

  r.get('/api/contacts', (req, res) => {
    const q = (req.query.q || '').toLowerCase()
    const list = db.allContacts()
      .filter((c) => !q || c.phone.includes(q) || (c.first_name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q))
      .sort((a, b) => String(b.registered_at).localeCompare(String(a.registered_at)))
      .slice(0, 500)
    res.json(list)
  })

  r.get('/api/queue', (req, res) => {
    res.json(db.queue.filter((x) => x.status === 'pending')
      .sort((a, b) => a.priority - b.priority || new Date(a.notBefore) - new Date(b.notBefore))
      .slice(0, 200))
  })

  r.get('/api/ops', (req, res) => res.json(db.state.opsLog.slice(0, 100)))

  // ---------- message + reply history (the dashboard is the record) ----------
  r.get('/api/logs/messages', (req, res) =>
    res.json(messageLog({ q: req.query.q || '', limit: Number(req.query.limit) || 300 })))
  r.get('/api/logs/inbound', (req, res) =>
    res.json(inboundLog({ q: req.query.q || '', limit: Number(req.query.limit) || 300 })))
  r.get('/api/logs/stats', (req, res) => res.json(messageStats()))
  r.get('/api/supabase/counts', async (req, res) => res.json(await sbCounts()))
  r.get('/api/supabase/peek/:table', async (req, res) => {
    try { res.json(await sbPeek(req.params.table, Number(req.query.limit) || 5)) }
    catch (e) { res.status(500).json({ error: e.message }) }
  })
  r.get('/api/export/messages.csv', (req, res) =>
    res.type('text/csv').attachment('message-log.csv').send(
      toCsv(messageLog({ limit: 100000 }), ['timestamp', 'phone', 'first_name', 'message_id', 'status', 'error', 'text'])))
  r.get('/api/export/inbound.csv', (req, res) =>
    res.type('text/csv').attachment('inbound-log.csv').send(
      toCsv(inboundLog({ limit: 100000 }), ['timestamp', 'phone', 'first_name', 'text', 'keyword', 'media_file'])))

  r.post('/api/settings', (req, res) => {
    for (const k of ['seats_left', 'seats_taken', 'one_line_action']) {
      if (req.body[k] !== undefined) db.setSetting(k, String(req.body[k]))
    }
    if (req.body.paused !== undefined) db.setSetting('paused', !!req.body.paused)
    if (req.body.campaignArmed !== undefined) db.setSetting('campaignArmed', !!req.body.campaignArmed)
    save()
    logOps('settings_changed', JSON.stringify(req.body))
    res.json({ ok: true, settings: db.settings })
  })

  // Manual contact add (for testing your own number before go-live)
  r.post('/api/contacts', (req, res) => {
    const phone = normalisePhone(req.body.phone)
    if (!phone) return res.status(400).json({ ok: false, error: 'bad phone' })
    const { contact, created } = db.upsertContact(phone, {
      first_name: firstNameOf(req.body.first_name || req.body.name),
      full_name: req.body.name || '',
      email: req.body.email || '',
      source: 'manual'
    })
    if (req.body.sendM1) enqueueInstant(contact, 'M1')
    syncContact(contact)
    res.json({ ok: true, created, contact })
  })

  // Bulk import registrants (CSV: name,phone,email — header row optional)
  r.post('/api/import/contacts', upload.single('file'), (req, res) => {
    const text = req.file ? req.file.buffer.toString('utf8') : (req.body.csv || '')
    const rows = text.split(/\r?\n/).filter(Boolean)
    let added = 0, skipped = 0
    for (const line of rows) {
      const cells = line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
      const phone = cells.map(normalisePhone).find(Boolean)
      if (!phone) { skipped++; continue }
      const name = cells.find((c) => /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(c)) || ''
      const email = cells.find((c) => c.includes('@')) || ''
      const { contact, created } = db.upsertContact(phone, { first_name: firstNameOf(name), full_name: name, email, source: 'import' })
      if (created) added++
      if (req.body.sendM1 === 'true' || req.body.sendM1 === true) enqueueInstant(contact, 'M1')
      syncContact(contact)
    }
    save()
    logOps('contacts_imported', `added=${added} skipped=${skipped}`)
    res.json({ ok: true, added, skipped })
  })

  // Attendance import from the WebinarJam export — sets the Attended flag.
  r.post('/api/import/attendance', upload.single('file'), (req, res) => {
    const text = req.file ? req.file.buffer.toString('utf8') : (req.body.csv || '')
    const found = new Set()
    for (const line of text.split(/\r?\n/)) {
      for (const cell of line.split(',')) {
        const p = normalisePhone(cell)
        if (p && db.findContact(p)) found.add(p)
      }
    }
    let marked = 0
    for (const p of found) { const c = db.findContact(p); if (c && !c.attended) { c.attended = true; marked++; syncContact(c) } }
    save()
    logOps('attendance_imported', `matched=${found.size} newly_marked=${marked}`)
    res.json({ ok: true, matched: found.size, marked })
  })

  r.post('/api/contact/:phone/flag', (req, res) => {
    const c = db.findContact(req.params.phone)
    if (!c) return res.status(404).json({ ok: false })
    for (const k of ['attended', 'booked', 'confirmed', 'optedOut']) {
      if (req.body[k] !== undefined) c[k] = !!req.body[k]
    }
    if (req.body.notes !== undefined) c.notes = String(req.body.notes)
    save(); syncContact(c)
    res.json({ ok: true, contact: c })
  })

  // ---------- screenshot review inbox ----------
  r.get('/api/screenshots', (req, res) => res.json(db.state.screenshots.slice(0, 100)))
  r.get('/media/:file', (req, res) => {
    const p = path.join(config.mediaDir, path.basename(req.params.file))
    if (!fs.existsSync(p)) return res.status(404).end()
    res.sendFile(p)
  })
  r.post('/api/screenshots/:id/send-ss', (req, res) => {
    const s = db.state.screenshots.find((x) => x.id === req.params.id)
    if (!s) return res.status(404).json({ ok: false })
    try {
      sendSS(s.phone)
      s.handled = true
      save()
      res.json({ ok: true })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })
  r.post('/api/screenshots/:id/reject', (req, res) => {
    const s = db.state.screenshots.find((x) => x.id === req.params.id)
    if (s) { s.handled = true; s.rejected = true; save() }
    res.json({ ok: true })
  })
  r.post('/api/send-ss', (req, res) => {
    const phone = normalisePhone(req.body.phone)
    try { sendSS(phone); res.json({ ok: true }) }
    catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  // ---------- manual / preview sends ----------
  r.get('/api/messages', (req, res) => res.json(MESSAGES.map((m) => ({ id: m.id, label: m.label, trigger: m.trigger, at: m.at }))))
  r.get('/api/messages/:id/preview', (req, res) => {
    const m = BY_ID[req.params.id]
    if (!m) return res.status(404).json({ ok: false })
    const sample = db.allContacts()[0] || { first_name: 'Rahul' }
    res.json({ id: m.id, body: render(m.body, sample) })
  })
  r.post('/api/send-now', (req, res) => {
    const phone = normalisePhone(req.body.phone)
    const m = BY_ID[req.body.messageId]
    const c = phone && db.findContact(phone)
    if (!c || !m) return res.status(400).json({ ok: false, error: 'unknown contact or message' })
    const miss = missingFields(m.body, c)
    if (miss.length) return res.status(400).json({ ok: false, error: `unset merge field(s): ${miss.join(', ')}` })
    db.enqueue({ phone, messageId: m.id, body: render(m.body, c), priority: 0, lateWindow: m.lateWindow })
    save()
    res.json({ ok: true })
  })
  r.post('/api/queue/:id/cancel', (req, res) => {
    const q = db.queue.find((x) => x.id === req.params.id)
    if (q) { q.status = 'cancelled'; q.error = 'cancelled by operator'; save() }
    res.json({ ok: true })
  })
  r.post('/api/scheduler/run', (req, res) => res.json(runScheduler()))

  // Remove one contact and everything queued for them.
  r.delete('/api/contact/:phone', (req, res) => {
    const ok = db.deleteContact(normalisePhone(req.params.phone) || req.params.phone)
    if (ok) { save(); logOps('contact_deleted', req.params.phone) }
    res.json({ ok })
  })

  // Clear all contacts/queue after a test run. Requires an explicit confirm string.
  r.post('/api/reset', async (req, res) => {
    if (req.body.confirm !== 'DELETE ALL CONTACTS') {
      return res.status(400).json({ ok: false, error: 'send {"confirm":"DELETE ALL CONTACTS"}' })
    }
    const n = db.resetCampaign()
    save()
    logOps('campaign_reset', `${n} contacts removed`)
    // Supabase rows are only cleared when explicitly asked for — it is someone else's database.
    const supabase = req.body.alsoSupabase ? await sbPurge() : 'left untouched'
    res.json({ ok: true, removed: n, supabase })
  })

  // Simulate an inbound reply — for testing keyword routing without a live phone.
  r.post('/api/simulate-inbound', async (req, res) => {
    const phone = normalisePhone(req.body.phone)
    if (!phone) return res.status(400).json({ ok: false, error: 'bad phone' })
    const out = await handleInbound({ phone, text: req.body.text || '', mediaFile: req.body.mediaFile || null })
    res.json({ ok: true, keyword: out.keyword, action: out.action })
  })

  // ---------- CSV export ----------
  r.get('/api/export/contacts.csv', (req, res) => {
    const head = ['phone', 'first_name', 'email', 'registered_at', 'confirmed', 'tags', 'inbound_count', 'last_inbound_text', 'opted_out', 'attended', 'booked', 'messages_sent', 'notes']
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [head.join(',')]
    for (const c of db.allContacts()) {
      lines.push([c.phone, c.first_name, c.email, c.registered_at, c.confirmed ? 'YES' : '', (c.tags || []).join('|'),
        c.inboundCount, c.last_inbound_text, c.optedOut ? 'STOP' : '', c.attended ? 'YES' : '', c.booked ? 'YES' : '',
        Object.keys(c.sent || {}).join('|'), c.notes].map(esc).join(','))
    }
    res.type('text/csv').attachment('contacts.csv').send(lines.join('\n'))
  })

  return r
}
