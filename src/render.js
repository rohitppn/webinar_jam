import { config } from './config.js'
import { db } from './store.js'

/** Light spintax: {a|b|c} picks one at random. Lets Arunav vary a word per batch without code changes. */
function spin(text) {
  return text.replace(/\{([^{}|]*\|[^{}]*)\}/g, (_, group) => {
    const opts = group.split('|')
    return opts[Math.floor(Math.random() * opts.length)]
  })
}

export function render(body, contact) {
  const s = db.settings
  const map = {
    first_name: contact.first_name || 'there',
    full_name: contact.full_name || contact.first_name || '',
    seats_left: s.seats_left,
    seats_taken: s.seats_taken,
    one_line_action: s.one_line_action || '',
    join_link: config.joinLink,
    calendly_link: config.calendlyLink,
    upi_id: config.upiId,
    room_cap: String(config.roomCap)
  }
  let out = spin(body)
  out = out.replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m))
  return out.trim()
}

// Fields that must not be blank. Sending "Join link: " with nothing after it is worse
// than sending nothing at all, so a message referencing an empty one is held.
const REQUIRED_IF_USED = {
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
