import { SCHEDULED, BY_ID } from './sequence.js'
import { db, save } from './store.js'
import { render, missingFields } from './render.js'
import { bodyOf } from './templates.js'
import { now, sendTimeFor, isoStamp, fromISO } from './time.js'
import { logOps } from './sheets.js'

/** Enqueue everything that is due and not yet sent. Runs every minute and on boot. */
export function runScheduler() {
  if (!db.settings.campaignArmed) return { enqueued: 0, note: 'campaign disarmed' }
  const t = now()
  let enqueued = 0
  const notes = []

  for (const msg of SCHEDULED) {
    const due = sendTimeFor(msg)
    if (due > t) continue
    // Don't fire messages that became due more than 24h ago (e.g. after a long outage).
    if (t.diff(due, 'hours').hours > 24) continue

    for (const c of db.allContacts()) {
      if (c.optedOut || c.sent[msg.id]) continue
      // A late registrant joins the sequence where it currently stands: M1 on registration,
      // then only the messages that fall due afterwards. Anything already past is skipped
      // permanently, never delivered late and never as a backlog burst.
      if (c.registered_at && due < fromISO(c.registered_at)) continue
      if (!msg.audience(c)) continue
      const body = bodyOf(msg)
      const miss = missingFields(body, c)
      if (miss.length) {
        if (!notes.includes(msg.id)) {
          notes.push(msg.id)
          logOps('message_held', `${msg.id} held — unset merge field(s): ${miss.join(', ')}`)
        }
        continue
      }
      db.enqueue({
        phone: c.phone,
        messageId: msg.id,
        body: render(body, c),
        priority: msg.priority,
        lateWindow: msg.lateWindow,
        notBefore: isoStamp(due > t ? due : t)
      })
      enqueued += 1
    }
  }
  if (enqueued) { save(); console.log(`[scheduler] enqueued ${enqueued}`) }
  db.pruneQueue()
  return { enqueued, held: notes }
}

/** Instant M1 on registration — highest priority, still throttled. */
export function enqueueInstant(contact, messageId = 'M1') {
  const msg = BY_ID[messageId]
  if (!msg || contact.optedOut || contact.sent[messageId]) return null
  const body = bodyOf(msg)
  const miss = missingFields(body, contact)
  if (miss.length) {
    logOps('message_held', `${messageId} held for ${contact.phone} — unset: ${miss.join(', ')}`)
    return null
  }
  const q = db.enqueue({
    phone: contact.phone,
    messageId,
    body: render(body, contact),
    priority: msg.priority ?? 0,
    lateWindow: msg.lateWindow
  })
  save()
  return q
}

export function startScheduler() {
  runScheduler()
  setInterval(() => {
    try { runScheduler() } catch (e) { console.error('[scheduler]', e.message) }
  }, 60 * 1000)
}

/** What the whole campaign looks like on a timeline — for the admin page. */
export function timeline() {
  const t = now()
  return SCHEDULED.map((m) => {
    const due = sendTimeFor(m)
    const sentCount = db.allContacts().filter((c) => c.sent[m.id]).length
    const eligible = db.allContacts().filter((c) => !c.optedOut && m.audience(c)).length
    return {
      id: m.id, label: m.label,
      due: due.toFormat('ccc dd LLL, HH:mm'),
      dueISO: due.toISO(),
      state: due > t ? 'scheduled' : (sentCount ? 'sent' : 'due'),
      eligible, sentCount
    }
  })
}
