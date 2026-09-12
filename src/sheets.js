import { google } from 'googleapis'
import { config } from './config.js'
import { stamp } from './time.js'
import { appendJsonl } from './store.js'

const TABS = {
  Contacts: [
    'phone', 'first_name', 'full_name', 'email', 'registered_at', 'source',
    'confirmed', 'tags', 'inbound_count', 'last_inbound_at', 'last_inbound_text',
    'opted_out', 'attended', 'booked', 'messages_sent', 'last_message', 'last_sent_at', 'notes'
  ],
  Message_Log: ['timestamp', 'phone', 'first_name', 'message_id', 'status', 'error', 'text'],
  Inbound_Log: ['timestamp', 'phone', 'first_name', 'text', 'keyword', 'media_file'],
  Ops_Log: ['timestamp', 'event', 'detail']
}

let sheetsApi = null
let ready = false
let initError = ''
const rowIndex = new Map() // phone -> 1-based row number in Contacts
const pending = []         // buffered appends when Sheets is slow/down

export const sheetsState = () => ({ enabled: config.sheetsEnabled, ready, error: initError, buffered: pending.length })

export async function initSheets() {
  if (!config.sheetsEnabled) {
    console.log('[sheets] disabled (GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON not set) — logging to local JSONL only')
    return
  }
  try {
    let creds = config.googleCreds.trim()
    if (!creds.startsWith('{')) creds = Buffer.from(creds, 'base64').toString('utf8') // allow base64 env
    const parsed = JSON.parse(creds)
    if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n')
    const auth = new google.auth.GoogleAuth({
      credentials: parsed,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    })
    sheetsApi = google.sheets({ version: 'v4', auth: await auth.getClient() })

    const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: config.sheetId })
    const have = new Set(meta.data.sheets.map((s) => s.properties.title))
    const missing = Object.keys(TABS).filter((t) => !have.has(t))
    if (missing.length) {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: config.sheetId,
        requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }
      })
    }
    for (const [tab, headers] of Object.entries(TABS)) {
      const r = await sheetsApi.spreadsheets.values.get({ spreadsheetId: config.sheetId, range: `${tab}!A1:Z1` })
      if (!r.data.values || !r.data.values[0] || r.data.values[0].length < headers.length) {
        await sheetsApi.spreadsheets.values.update({
          spreadsheetId: config.sheetId,
          range: `${tab}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [headers] }
        })
      }
    }
    // Map existing contact rows so we update in place instead of duplicating.
    const contacts = await sheetsApi.spreadsheets.values.get({ spreadsheetId: config.sheetId, range: 'Contacts!A2:A100000' })
    ;(contacts.data.values || []).forEach((row, i) => { if (row[0]) rowIndex.set(String(row[0]), i + 2) })

    ready = true
    initError = ''
    console.log(`[sheets] connected, ${rowIndex.size} contact rows mapped`)
    flush()
  } catch (e) {
    ready = false
    initError = e.message
    console.error('[sheets] init failed:', e.message)
    setTimeout(initSheets, 60000)
  }
}

const contactRow = (c) => [
  c.phone, c.first_name, c.full_name || '', c.email || '', c.registered_at || '', c.source || '',
  c.confirmed ? 'YES' : '', (c.tags || []).join(','), c.inboundCount || 0, c.last_inbound_at || '',
  (c.last_inbound_text || '').slice(0, 250), c.optedOut ? 'STOP' : '', c.attended ? 'YES' : '',
  c.booked ? 'YES' : '', Object.keys(c.sent || {}).length,
  Object.keys(c.sent || {}).slice(-1)[0] || '', Object.values(c.sent || {}).slice(-1)[0] || '', c.notes || ''
]

/** Write/refresh one contact row. Safe to call often; failures are buffered. */
export async function syncContact(c) {
  appendJsonl('contacts.jsonl', { at: stamp(), ...c })
  if (!ready) { pending.push({ kind: 'contact', c }); return }
  try {
    const row = contactRow(c)
    const at = rowIndex.get(c.phone)
    if (at) {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId: config.sheetId, range: `Contacts!A${at}`,
        valueInputOption: 'RAW', requestBody: { values: [row] }
      })
    } else {
      const res = await sheetsApi.spreadsheets.values.append({
        spreadsheetId: config.sheetId, range: 'Contacts!A1',
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] }
      })
      const m = /Contacts!A(\d+)/.exec(res.data.updates?.updatedRange || '')
      if (m) rowIndex.set(c.phone, Number(m[1]))
    }
  } catch (e) {
    console.error('[sheets] syncContact failed:', e.message)
    pending.push({ kind: 'contact', c })
  }
}

export async function appendRow(tab, values) {
  appendJsonl(tab.toLowerCase() + '.jsonl', { at: stamp(), values })
  if (!ready) { pending.push({ kind: 'row', tab, values }); return }
  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: config.sheetId, range: `${tab}!A1`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [values] }
    })
  } catch (e) {
    console.error(`[sheets] append ${tab} failed:`, e.message)
    pending.push({ kind: 'row', tab, values })
  }
}

export const logMessage = (c, messageId, status, error, text) =>
  appendRow('Message_Log', [stamp(), c.phone, c.first_name, messageId, status, error || '', (text || '').slice(0, 500)])
export const logInbound = (c, text, keyword, mediaFile) =>
  appendRow('Inbound_Log', [stamp(), c.phone, c.first_name, (text || '').slice(0, 500), keyword || '', mediaFile || ''])
export const logOps = (event, detail) => appendRow('Ops_Log', [stamp(), event, String(detail || '').slice(0, 500)])

async function flush() {
  while (ready && pending.length) {
    const item = pending.shift()
    try {
      if (item.kind === 'contact') await syncContact(item.c)
      else await appendRow(item.tab, item.values)
    } catch { pending.unshift(item); break }
  }
}
setInterval(() => { if (ready && pending.length) flush() }, 30000).unref()
