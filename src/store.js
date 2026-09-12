import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { isoStamp, now, dayKey } from './time.js'

const FILE = path.join(config.dataDir, 'state.json')
const TMP = FILE + '.tmp'

const EMPTY = {
  contacts: {},   // phone -> contact
  queue: [],      // pending sends
  settings: {
    seats_left: '5',
    seats_taken: '0',
    one_line_action: '',
    paused: false,
    campaignArmed: true
  },
  counters: { day: null, sentToday: 0, burstCount: 0, restUntil: null },
  screenshots: [], // { id, phone, first_name, file, at, handled }
  opsLog: []
}

let state = load()
let dirty = false

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
      return { ...structuredClone(EMPTY), ...raw, settings: { ...EMPTY.settings, ...(raw.settings || {}) }, counters: { ...EMPTY.counters, ...(raw.counters || {}) } }
    }
  } catch (e) {
    console.error('[store] state.json unreadable, starting fresh:', e.message)
    try { fs.copyFileSync(FILE, FILE + '.corrupt.' + Date.now()) } catch {}
  }
  return structuredClone(EMPTY)
}

export function save() {
  fs.writeFileSync(TMP, JSON.stringify(state, null, 2))
  fs.renameSync(TMP, FILE)
  dirty = false
}
export const markDirty = () => { dirty = true }
setInterval(() => { if (dirty) save() }, 5000).unref()
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { save() } catch {} ; process.exit(0) })

export const db = {
  get state() { return state },
  get settings() { return state.settings },
  get contacts() { return state.contacts },
  get queue() { return state.queue },
  get counters() { return state.counters },

  setSetting(k, v) { state.settings[k] = v; markDirty() },

  /** Create or update a contact keyed by normalised phone. Returns { contact, created }. */
  upsertContact(phone, fields = {}) {
    const existing = state.contacts[phone]
    if (existing) {
      Object.assign(existing, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== '')))
      markDirty()
      return { contact: existing, created: false }
    }
    const c = {
      phone,
      first_name: fields.first_name || 'there',
      full_name: fields.full_name || '',
      email: fields.email || '',
      registered_at: fields.registered_at || isoStamp(),
      source: fields.source || 'manual',
      confirmed: false,
      tags: [],
      inboundCount: 0,
      last_inbound_at: '',
      last_inbound_text: '',
      optedOut: false,
      attended: false,
      booked: false,
      repliedAfterEvent: false,
      repliedAfterD1: false,
      sent: {},          // messageId -> ISO timestamp
      lastSentDay: '',
      sentCountToday: 0,
      notes: ''
    }
    state.contacts[phone] = c
    markDirty()
    return { contact: c, created: true }
  },

  findContact(phone) { return state.contacts[phone] || null },
  allContacts() { return Object.values(state.contacts) },

  enqueue(item) {
    const dup = state.queue.find((q) => q.phone === item.phone && q.messageId === item.messageId && q.status === 'pending')
    if (dup) return dup
    const q = {
      id: `${item.messageId}:${item.phone}:${Date.now()}`,
      phone: item.phone,
      messageId: item.messageId,
      body: item.body,
      priority: item.priority ?? 5,
      lateWindow: !!item.lateWindow,
      notBefore: item.notBefore || isoStamp(),
      attempts: 0,
      status: 'pending',
      queued_at: isoStamp(),
      error: ''
    }
    state.queue.push(q)
    markDirty()
    return q
  },

  dequeueNext(predicate) {
    const ready = state.queue
      .filter((q) => q.status === 'pending' && predicate(q))
      .sort((a, b) => a.priority - b.priority || new Date(a.notBefore) - new Date(b.notBefore) || new Date(a.queued_at) - new Date(b.queued_at))
    return ready[0] || null
  },

  finishQueueItem(id, status, error = '') {
    const q = state.queue.find((x) => x.id === id)
    if (!q) return
    q.status = status
    q.error = error
    q.finished_at = isoStamp()
    markDirty()
  },

  pruneQueue(keepHours = 72) {
    const cutoff = now().minus({ hours: keepHours })
    state.queue = state.queue.filter((q) => q.status === 'pending' || new Date(q.finished_at || q.queued_at) > cutoff.toJSDate())
    markDirty()
  },

  rollDayCounters() {
    const k = dayKey()
    if (state.counters.day !== k) {
      state.counters.day = k
      state.counters.sentToday = 0
      for (const c of Object.values(state.contacts)) c.sentCountToday = 0
      markDirty()
    }
  },

  recordSend(contact, messageId) {
    contact.sent[messageId] = isoStamp()
    contact.lastSentDay = dayKey()
    contact.sentCountToday = (contact.sentCountToday || 0) + 1
    state.counters.sentToday += 1
    state.counters.burstCount += 1
    markDirty()
  },

  deleteContact(phone) {
    if (!state.contacts[phone]) return false
    delete state.contacts[phone]
    state.queue = state.queue.filter((q) => q.phone !== phone)
    state.screenshots = state.screenshots.filter((s) => s.phone !== phone)
    markDirty()
    return true
  },

  /** Wipe campaign data but keep settings and the WhatsApp session. For clearing test runs. */
  resetCampaign() {
    const n = Object.keys(state.contacts).length
    state.contacts = {}
    state.queue = []
    state.screenshots = []
    state.counters = { day: null, sentToday: 0, burstCount: 0, restUntil: null }
    markDirty()
    return n
  },

  addScreenshot(entry) { state.screenshots.unshift(entry); markDirty() },
  ops(event, detail = '') {
    state.opsLog.unshift({ at: isoStamp(), event, detail })
    state.opsLog = state.opsLog.slice(0, 500)
    markDirty()
  }
}

export const logFile = (name) => path.join(config.dataDir, name)
export function appendJsonl(name, obj) {
  fs.appendFileSync(logFile(name), JSON.stringify(obj) + '\n')
}
