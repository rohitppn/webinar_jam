// Optional Supabase mirror. Uses PostgREST over fetch — no client library needed.
// Every write is fire-and-forget with a retry buffer: Supabase being down never
// blocks a WhatsApp send, and nothing is lost because the volume is still the store.
import { config } from './config.js'

const TBL = {
  contacts: 'webinar_contacts',
  messages: 'webinar_messages',
  inbound: 'webinar_inbound',
  ops: 'webinar_ops'
}

let ready = false
let initError = ''
const pending = []

export const supabaseState = () => ({
  enabled: config.supabaseEnabled,
  ready,
  error: initError,
  buffered: pending.length,
  url: config.supabaseUrl ? config.supabaseUrl.replace(/^https?:\/\//, '') : ''
})

function headers(extra = {}) {
  return {
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    'Content-Type': 'application/json',
    ...extra
  }
}

async function req(path, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
      ...opts,
      headers: headers(opts.headers),
      signal: ctrl.signal
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`${res.status} ${body.slice(0, 200)}`)
    }
    const text = await res.text()
    return text ? JSON.parse(text) : null
  } finally {
    clearTimeout(t)
  }
}

/** Confirm the tables exist and are reachable. Retries quietly on failure. */
export async function initSupabase() {
  if (!config.supabaseEnabled) {
    console.log('[supabase] disabled (SUPABASE_URL / SUPABASE_SERVICE_KEY not set)')
    return
  }
  try {
    for (const t of Object.values(TBL)) {
      await req(`${t}?select=*&limit=1`)
    }
    ready = true
    initError = ''
    console.log('[supabase] connected — all four tables reachable')
    flush()
  } catch (e) {
    ready = false
    initError = e.message
    console.error('[supabase] not ready:', e.message)
    setTimeout(initSupabase, 60000)
  }
}

/** A failed write means we are no longer live: flip the flag so the dashboard
 *  shows it and the retry loop starts, instead of silently dropping to the buffer. */
let reinitTimer = null
function markDown(what, e) {
  console.error(`[supabase] ${what} failed:`, e.message)
  if (ready) {
    ready = false
    initError = e.message
    if (!reinitTimer) reinitTimer = setTimeout(() => { reinitTimer = null; initSupabase() }, 15000)
  }
}

const contactRow = (c) => ({
  phone: c.phone,
  first_name: c.first_name || '',
  full_name: c.full_name || '',
  email: c.email || '',
  registered_at: c.registered_at || null,
  source: c.source || '',
  confirmed: !!c.confirmed,
  tags: c.tags || [],
  inbound_count: c.inboundCount || 0,
  last_inbound_at: c.last_inbound_at || null,
  last_inbound_text: (c.last_inbound_text || '').slice(0, 1000),
  opted_out: !!c.optedOut,
  attended: !!c.attended,
  booked: !!c.booked,
  sent: c.sent || {},
  notes: c.notes || '',
  updated_at: new Date().toISOString()
})

export async function sbUpsertContact(c) {
  if (!config.supabaseEnabled) return
  if (!ready) { pending.push({ kind: 'contact', c }); return }
  try {
    await req(TBL.contacts, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(contactRow(c))
    })
  } catch (e) {
    markDown('contact upsert', e)
    pending.push({ kind: 'contact', c })
  }
}

async function insert(table, row) {
  if (!config.supabaseEnabled) return
  if (!ready) { pending.push({ kind: 'row', table, row }); return }
  try {
    await req(table, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) })
  } catch (e) {
    markDown(`insert ${table}`, e)
    pending.push({ kind: 'row', table, row })
  }
}

export const sbLogMessage = (c, messageId, status, error, text) =>
  insert(TBL.messages, {
    ts: new Date().toISOString(), phone: c.phone, first_name: c.first_name || '',
    message_id: messageId, status, error: error || '', text: (text || '').slice(0, 4000)
  })

export const sbLogInbound = (c, text, keyword, mediaFile) =>
  insert(TBL.inbound, {
    ts: new Date().toISOString(), phone: c.phone, first_name: c.first_name || '',
    text: (text || '').slice(0, 4000), keyword: keyword || '', media_file: mediaFile || ''
  })

export const sbLogOps = (event, detail) =>
  insert(TBL.ops, { ts: new Date().toISOString(), event, detail: String(detail || '').slice(0, 1000) })

/** Pull contacts back from Supabase — used when the volume is empty after a rebuild. */
export async function sbFetchContacts() {
  if (!config.supabaseEnabled || !ready) return []
  const rows = await req(`${TBL.contacts}?select=*&limit=10000`)
  return (rows || []).map((r) => ({
    phone: r.phone,
    first_name: r.first_name || 'there',
    full_name: r.full_name || '',
    email: r.email || '',
    registered_at: r.registered_at || '',
    source: r.source || 'supabase-restore',
    confirmed: !!r.confirmed,
    tags: r.tags || [],
    inboundCount: r.inbound_count || 0,
    last_inbound_at: r.last_inbound_at || '',
    last_inbound_text: r.last_inbound_text || '',
    optedOut: !!r.opted_out,
    attended: !!r.attended,
    booked: !!r.booked,
    repliedAfterEvent: false,
    repliedAfterD1: false,
    sent: r.sent || {},
    lastSentDay: '',
    sentCountToday: 0,
    notes: r.notes || ''
  }))
}

/** Row counts straight from Supabase, read with the service key so RLS doesn't hide them.
 *  Lets the operator confirm the mirror is actually recording, not just accepting writes. */
export async function sbCounts() {
  if (!config.supabaseEnabled) return { enabled: false }
  const out = { enabled: true, ready, tables: {} }
  for (const [label, table] of Object.entries(TBL)) {
    try {
      const res = await fetch(`${config.supabaseUrl}/rest/v1/${table}?select=*`, {
        method: 'HEAD',
        headers: headers({ Prefer: 'count=exact', Range: '0-0' })
      })
      const cr = res.headers.get('content-range') || ''
      out.tables[label] = cr.includes('/') ? Number(cr.split('/')[1]) : null
    } catch (e) {
      out.tables[label] = `error: ${e.message}`
    }
  }
  return out
}

/** Most recent rows from one table, for spot-checking what was written. */
export async function sbPeek(table, limit = 5) {
  if (!config.supabaseEnabled || !TBL[table]) return []
  const order = table === 'contacts' ? 'updated_at.desc' : 'ts.desc'
  return (await req(`${TBL[table]}?select=*&order=${order}&limit=${limit}`)) || []
}

/** Delete every row in the four webinar_ tables. Used only by the explicit reset. */
export async function sbPurge() {
  if (!config.supabaseEnabled) return { enabled: false }
  const out = {}
  for (const [label, table] of Object.entries(TBL)) {
    try {
      // PostgREST refuses an unfiltered delete, so match on a column that is always present.
      const filter = label === 'contacts' ? 'phone=not.is.null' : 'id=gt.0'
      await req(`${table}?${filter}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } })
      out[label] = 'cleared'
    } catch (e) {
      out[label] = `error: ${e.message}`
    }
  }
  return out
}

async function flush() {
  while (ready && pending.length) {
    const item = pending.shift()
    try {
      if (item.kind === 'contact') await sbUpsertContact(item.c)
      else await insert(item.table, item.row)
    } catch { pending.unshift(item); break }
  }
}
setInterval(() => { if (ready && pending.length) flush() }, 30000).unref()
