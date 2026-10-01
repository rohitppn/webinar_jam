import { config } from './config.js'
import { db } from './store.js'
import { eventStart } from './time.js'

/** Light spintax: {a|b|c} picks one at random. Lets Arunav vary a word per batch without code changes. */
function spin(text) {
  return text.replace(/\{([^{}|]*\|[^{}]*)\}/g, (_, group) => {
    const opts = group.split('|')
    return opts[Math.floor(Math.random() * opts.length)]
  })
}

/** "Friday, 9 October" and "9 PM", straight from EVENT_START. */
function eventStrings() {
  const ev = eventStart()
  const time = ev.minute === 0 ? ev.toFormat('h a') : ev.toFormat('h:mm a')
  const date = ev.toFormat('cccc, d LLLL')
  return { event_date: date, event_time: time, event_datetime: `${date}, ${time}` }
}

export function render(body, contact) {
  const s = db.settings
  const ev = eventStrings()
  const map = {
    first_name: contact.first_name || 'there',
    full_name: contact.full_name || contact.first_name || '',
    seats_left: s.seats_left,
    seats_taken: s.seats_taken,
    one_line_action: s.one_line_action || '',
    join_link: config.joinLink,
    calendly_link: config.calendlyLink,
    upi_id: config.upiId,
    room_cap: String(config.roomCap),
    next_masterclass: s.next_masterclass || '',
    ...ev
  }
  let out = spin(body)
  out = out.replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m))
  return out.trim()
}

// Fields that must not be blank. Sending "Join link: " with nothing after it is worse
// than sending nothing at all, so a message referencing an empty one is held.
const REQUIRED_IF_USED = {
  next_masterclass: () => db.settings.next_masterclass,
  join_link: () => config.joinLink,
  calendly_link: () => config.calendlyLink,
  upi_id: () => config.upiId,
  one_line_action: () => db.settings.one_line_action,
  seats_left: () => db.settings.seats_left,
  seats_taken: () => db.settings.seats_taken
}

/** Merge fields that are unresolved or blank. A non-empty result holds the send. */
export function missingFields(body, contact) {
  const rendered = render(body, contact)
  const unresolved = [...rendered.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
  const blank = Object.entries(REQUIRED_IF_USED)
    .filter(([key, get]) => body.includes(`{${key}}`) && !String(get() ?? '').trim())
    .map(([key]) => key)
  return [...new Set([...unresolved, ...blank])]
}

/** Config-level merge values that are not set — surfaced on the dashboard. */
export function unsetConfigFields() {
  return [
    ['JOIN_LINK', config.joinLink],
    ['CALENDLY_LINK', config.calendlyLink],
    ['UPI_ID', config.upiId]
  ].filter(([, v]) => !String(v || '').trim()).map(([k]) => k)
}
