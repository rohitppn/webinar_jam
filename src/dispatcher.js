import { config } from './config.js'
import { db, save } from './store.js'
import { sendText, wa } from './wa.js'
import { BY_ID } from './sequence.js'
import { logMessage, syncContact, logOps } from './sheets.js'
import { now, isoStamp, inSendWindow, nextWindowOpen, randomGapMs, isEventDay, dayKey } from './time.js'

export const dispatcher = {
  running: false,
  nextSendAt: null,
  lastSendAt: null,
  reason: 'idle'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Why can't we send right now? Returns null when clear to send. */
export function blockedReason(item) {
  const t = now()
  if (db.settings.paused) return 'paused by operator'
  if (wa.status !== 'open' && !config.dryRun) return `whatsapp ${wa.status}`
  db.rollDayCounters()
  const c = db.counters
  if (c.restUntil && new Date(c.restUntil) > t.toJSDate()) {
    const mins = Math.ceil((new Date(c.restUntil) - t.toJSDate()) / 60000)
    return `burst rest: ${mins} min left`
  }
  if (c.sentToday >= config.dailyCap) return `daily cap ${config.dailyCap} reached`
  const late = !!item?.lateWindow && isEventDay(t)
  if (!inSendWindow(t, late)) return `outside send window (${config.quietStartHour}:00–${config.quietEndHour}:00)`
  return null
}

/** Per-contact gate: opt-out, duplicate, one-per-day. */
function contactGate(contact, msg) {
  if (!contact) return 'contact missing'
  if (contact.optedOut) return 'opted out'
  if (contact.sent[msg.id]) return 'already sent'
  if (msg.audience && !msg.audience(contact)) return 'no longer in audience'
  const exemptFromDaily = msg.ignoreDailyCapPairing || msg.replyToInbound
  if (config.onePerContactPerDay && !isEventDay() && !exemptFromDaily) {
    if (contact.lastSentDay === dayKey() && (contact.sentCountToday || 0) >= 1) return 'already messaged today'
  }
  return null
}

async function tick() {
  const item = db.dequeueNext((q) => new Date(q.notBefore) <= new Date())
  if (!item) { dispatcher.reason = 'queue empty'; return 15000 }

  const block = blockedReason(item)
  if (block) {
    dispatcher.reason = block
    if (block.startsWith('outside send window')) {
      const wait = nextWindowOpen().diffNow('milliseconds').milliseconds
      return Math.max(30000, Math.min(wait, 15 * 60 * 1000))
    }
    if (block.startsWith('burst rest')) {
      const wait = new Date(db.counters.restUntil) - Date.now()
      return Math.max(15000, Math.min(wait, 5 * 60 * 1000))
    }
    return 30000
  }

  const contact = db.findContact(item.phone)
  const msg = BY_ID[item.messageId] || {}
  const gate = contactGate(contact, { ...msg, id: item.messageId })
  if (gate) {
    db.finishQueueItem(item.id, 'skipped', gate)
    if (contact) logMessage(contact, item.messageId, 'skipped', gate, '')
    dispatcher.reason = `skipped ${item.messageId} -> ${item.phone}: ${gate}`
    return 500
  }

  try {
    await sendText(item.phone, item.body)
    db.recordSend(contact, item.messageId)
    db.finishQueueItem(item.id, 'sent')
    dispatcher.lastSendAt = isoStamp()
    logMessage(contact, item.messageId, 'sent', '', item.body)
    syncContact(contact)
    console.log(`[send] ${item.messageId} -> ${item.phone} (burst ${db.counters.burstCount}/${config.burstSize}, today ${db.counters.sentToday}/${config.dailyCap})`)
  } catch (e) {
    item.attempts += 1
    if (item.attempts >= 3) {
      db.finishQueueItem(item.id, 'failed', e.message)
      logMessage(contact, item.messageId, 'failed', e.message, item.body)
      db.ops('send_failed', `${item.messageId} ${item.phone}: ${e.message}`)
    } else {
      item.notBefore = now().plus({ minutes: 5 }).toISO()
      db.ops('send_retry', `${item.messageId} ${item.phone}: ${e.message}`)
    }
    save()
    return 10000
  }

  // Burst accounting: after BURST_SIZE sends, rest for BURST_REST_MINUTES.
  if (db.counters.burstCount >= config.burstSize) {
    db.counters.burstCount = 0
    db.counters.restUntil = now().plus({ minutes: config.burstRestMinutes }).toISO()
    save()
    logOps('burst_complete', `${config.burstSize} sent, resting ${config.burstRestMinutes} min`)
    console.log(`[throttle] burst of ${config.burstSize} done — resting ${config.burstRestMinutes} min`)
    return config.burstRestMinutes * 60 * 1000
  }

  save()
  return randomGapMs()
}

export function startDispatcher() {
  if (dispatcher.running) return
  dispatcher.running = true
  ;(async function loop() {
    while (true) {
      let wait = 15000
      try {
        wait = await tick()
      } catch (e) {
        console.error('[dispatcher] tick error:', e.message)
        wait = 15000
      }
      dispatcher.nextSendAt = now().plus({ milliseconds: wait }).toISO()
      await sleep(wait)
    }
  })()
}
