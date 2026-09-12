import fs from 'node:fs'
import { logFile } from './store.js'

/** Read a JSONL log newest-first, with an optional substring filter. */
function readJsonl(name, { q = '', limit = 300 } = {}) {
  const p = logFile(name)
  if (!fs.existsSync(p)) return []
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
  const out = []
  const needle = q.toLowerCase()
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let row
    try { row = JSON.parse(lines[i]) } catch { continue }
    const v = row.values || []
    if (needle && !JSON.stringify(v).toLowerCase().includes(needle)) continue
    out.push(v)
  }
  return out
}

// Column order matches what sheets.js writes.
export const messageLog = (opts) =>
  readJsonl('message_log.jsonl', opts).map(([timestamp, phone, first_name, message_id, status, error, text]) =>
    ({ timestamp, phone, first_name, message_id, status, error, text }))

export const inboundLog = (opts) =>
  readJsonl('inbound_log.jsonl', opts).map(([timestamp, phone, first_name, text, keyword, media_file]) =>
    ({ timestamp, phone, first_name, text, keyword, media_file }))

export function toCsv(rows, headers) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n')
}

/** Counts for the dashboard, so the operator can see delivery at a glance. */
export function messageStats() {
  const all = messageLog({ limit: 100000 })
  const byStatus = {}
  const byMessage = {}
  for (const r of all) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1
    if (r.status === 'sent') byMessage[r.message_id] = (byMessage[r.message_id] || 0) + 1
  }
  return { total: all.length, byStatus, byMessage }
}
