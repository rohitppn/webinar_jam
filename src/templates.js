import { BY_ID, MESSAGES } from './sequence.js'
import { db, save } from './store.js'

// Message copy lives in sequence.js as the shipped default. An edit made in the dashboard
// is stored as an override, so the original is always recoverable.

const KNOWN_FIELDS = [
  'first_name', 'full_name', 'seats_left', 'seats_taken',
  'one_line_action', 'join_link', 'calendly_link', 'upi_id', 'room_cap'
]

/** The live text for a message: the override if one exists, otherwise the shipped copy. */
export function bodyOf(msgOrId) {
  const msg = typeof msgOrId === 'string' ? BY_ID[msgOrId] : msgOrId
  if (!msg) return ''
  const override = (db.settings.templates || {})[msg.id]
  return typeof override === 'string' && override.trim() ? override : msg.body
}

export const isEdited = (id) => {
  const o = (db.settings.templates || {})[id]
  return typeof o === 'string' && o.trim() && o !== BY_ID[id]?.body
}

/** Placeholders the renderer cannot fill — a typo like {frist_name} would send literally. */
export function unknownFields(body) {
  return [...new Set([...String(body).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))]
    .filter((f) => !KNOWN_FIELDS.includes(f))
}

export function setTemplate(id, body) {
  if (!BY_ID[id]) throw new Error(`unknown message ${id}`)
  const text = String(body || '')
  if (!text.trim()) throw new Error('message text cannot be empty')
  if (text.length > 4000) throw new Error('message is too long for WhatsApp (4000 char limit)')
  const unknown = unknownFields(text)
  if (unknown.length) throw new Error(`unknown merge field(s): ${unknown.map((u) => `{${u}}`).join(', ')}`)
  db.settings.templates = { ...(db.settings.templates || {}), [id]: text }
  save()
  return text
}

export function resetTemplate(id) {
  const t = { ...(db.settings.templates || {}) }
  delete t[id]
  db.settings.templates = t
  save()
  return BY_ID[id]?.body || ''
}

export const listTemplates = () =>
  MESSAGES.map((m) => ({
    id: m.id,
    label: m.label,
    trigger: m.trigger,
    body: bodyOf(m),
    original: m.body,
    edited: isEdited(m.id)
  }))
