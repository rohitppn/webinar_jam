import { db, save } from './store.js'
import { BY_ID } from './sequence.js'
import { render } from './render.js'
import { logInbound, syncContact, logMessage } from './sheets.js'
import { isoStamp, now, eventStart, sendTimeFor } from './time.js'
import { config } from './config.js'

/** Levenshtein distance, capped — "tolerate one typo" from the spec. */
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 9
  const m = a.length, n = b.length
  const prev = new Array(n + 1), cur = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j]
  }
  return prev[n]
}

const KEYWORDS = ['STOP', 'CONFIRMED', 'YES', 'CALL', 'PROFILE', 'TEXTING', 'STYLING', 'APPROACH']
const STOP_WORDS = ['STOP', 'UNSUBSCRIBE', 'REMOVE', 'OPTOUT', 'OPT-OUT']

/** Match a keyword anywhere in a short reply, tolerating one typo. */
export function matchKeyword(text) {
  const clean = (text || '').toUpperCase().replace(/[^A-Z\s]/g, ' ').trim()
  if (!clean) return null
  const words = clean.split(/\s+/)
  for (const w of words) {
    for (const s of STOP_WORDS) if (w === s) return 'STOP'
  }
  for (const kw of KEYWORDS) {
    for (const w of words) {
      if (w === kw) return kw
      if (kw.length >= 4 && lev(w, kw) <= 1) return kw
    }
  }
  return null
}

export async function handleInbound({ phone, text, mediaFile }) {
  let contact = db.findContact(phone)
  if (!contact) {
    // Unknown number replying — record it so nothing is lost, but it gets no sequence.
    contact = db.upsertContact(phone, { first_name: 'Unknown', source: 'inbound-unknown' }).contact
    contact.notes = 'Replied but not in the WebinarJam registration list'
  }

  contact.inboundCount = (contact.inboundCount || 0) + 1
  contact.last_inbound_at = isoStamp()
  contact.last_inbound_text = text
  if (now() > eventStart()) contact.repliedAfterEvent = true
  const d1 = sendTimeFor(BY_ID.D1)
  if (contact.sent.D1 && now() > d1) contact.repliedAfterD1 = true

  const kw = matchKeyword(text)
  if (kw && !contact.tags.includes(kw)) contact.tags.push(kw)

  let action = ''

  if (kw === 'STOP') {
    contact.optedOut = true
    contact.tags = [...new Set([...contact.tags, 'STOP'])]
    // Purge every pending send for this contact within the minute, permanently.
    for (const q of db.queue) if (q.phone === phone && q.status === 'pending') { q.status = 'cancelled'; q.error = 'opt-out' }
    action = 'opted-out'
    db.ops('opt_out', phone)
  } else if (kw === 'CONFIRMED') {
    contact.confirmed = true
    if (!contact.sent.M1R) {
      const m = BY_ID.M1R
      db.enqueue({ phone, messageId: 'M1R', body: render(m.body, contact), priority: 0 })
      action = 'auto-reply M1R queued'
    }
  } else if (mediaFile) {
    // Payment screenshot → human review queue. Nothing is verified automatically.
    db.addScreenshot({
      id: `${phone}-${Date.now()}`,
      phone, first_name: contact.first_name, file: mediaFile,
      at: isoStamp(), handled: false, caption: text || ''
    })
    action = 'screenshot -> review inbox'
  }

  save()
  logInbound(contact, text, kw || '', mediaFile || '')
  syncContact(contact)
  console.log(`[inbound] ${phone}: "${(text || '').slice(0, 60)}" kw=${kw || '-'} ${action}`)
  return { contact, keyword: kw, action }
}

/** Human-triggered: send the Calendly link after a person eyeballs the payment. */
export function sendSS(phone) {
  const contact = db.findContact(phone)
  if (!contact) throw new Error('unknown contact')
  const m = BY_ID.SS
  db.enqueue({ phone, messageId: 'SS', body: render(m.body, contact), priority: 0 })
  contact.booked = true
  contact.tags = [...new Set([...contact.tags, 'BOOKED'])]
  // Booking exits the P and D tracks immediately.
  for (const q of db.queue) {
    if (q.phone === phone && q.status === 'pending' && /^(P[1-7]|D[12]|NA1)$/.test(q.messageId)) {
      q.status = 'cancelled'; q.error = 'booked — exited P/D'
    }
  }
  save()
  syncContact(contact)
  db.ops('ss_sent', phone)
  return contact
}
