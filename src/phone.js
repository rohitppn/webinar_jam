import { config } from './config.js'

/** Normalise anything WebinarJam sends into bare international digits. */
export function normalisePhone(raw) {
  if (!raw) return null
  let d = String(raw).replace(/[^\d]/g, '')
  if (!d) return null
  d = d.replace(/^0+/, '')
  const cc = config.defaultCountryCode
  if (d.length === 10) d = cc + d                 // bare Indian mobile
  else if (d.length === 11 && d.startsWith('0')) d = cc + d.slice(1)
  else if (d.length === 12 && d.startsWith(cc)) { /* already fine */ }
  if (d.length < 10 || d.length > 15) return null
  return d
}

export function firstNameOf(nameLike, fallback = 'there') {
  const n = String(nameLike || '').trim()
  if (!n) return fallback
  const first = n.split(/\s+/)[0]
  return first.charAt(0).toUpperCase() + first.slice(1)
}
