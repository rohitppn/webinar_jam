import * as baileys from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import QRCode from 'qrcode'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { db } from './store.js'
import { isoStamp } from './time.js'

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  makeCacheableSignalKeyStore
} = baileys

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' })

export const wa = {
  sock: null,
  status: 'starting',      // starting | qr | connecting | open | logged-out | error
  qrDataUrl: null,
  qrGeneratedAt: null,
  me: null,
  lastError: '',
  onInbound: null          // set by inbound.js
}

let reconnectAttempts = 0
let starting = false
const seenInbound = new Set() // message ids already handled, so a redelivery is ignored

export async function startWhatsApp() {
  if (starting) return
  starting = true
  try {
    // Drop the previous socket first. Without this, every reconnect leaves its
    // listeners attached — and two live sockets means one inbound reply handled
    // twice, which would send a contact two auto-replies.
    if (wa.sock) {
      try { wa.sock.ev.removeAllListeners() } catch {}
      try { wa.sock.end(undefined) } catch {}
      wa.sock = null
    }
    fs.mkdirSync(config.authDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      browser: ['TheBroThing Sequencer', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,       // keeps phone notifications working
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    })
    wa.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u
      if (qr) {
        wa.status = 'qr'
        wa.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 })
        wa.qrGeneratedAt = isoStamp()
        console.log('[wa] QR ready — open the admin page and scan it')
      }
      if (connection === 'connecting') wa.status = 'connecting'
      if (connection === 'open') {
        wa.status = 'open'
        wa.qrDataUrl = null
        wa.me = sock.user?.id || null
        reconnectAttempts = 0
        db.ops('wa_connected', wa.me || '')
        console.log('[wa] connected as', wa.me)
      }
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode
        const loggedOut = code === DisconnectReason.loggedOut
        wa.status = loggedOut ? 'logged-out' : 'connecting'
        wa.lastError = lastDisconnect?.error?.message || ''
        // 408 is the QR simply rotating while nobody has scanned yet; logging it as a
        // disconnect buried the handful of real ones under 84 routine entries.
        if (code !== 408) db.ops('wa_disconnected', `code=${code} ${wa.lastError}`)
        console.log('[wa] closed. code=', code, 'loggedOut=', loggedOut)
        starting = false
        if (loggedOut) {
          // Credentials are dead — wipe so a fresh QR is produced.
          fs.rmSync(config.authDir, { recursive: true, force: true })
          setTimeout(() => startWhatsApp(), 2000)
        } else {
          reconnectAttempts += 1
          const delay = Math.min(60000, 2000 * reconnectAttempts)
          setTimeout(() => startWhatsApp(), delay)
        }
      }
    })

    sock.ev.on('messages.upsert', async (ev) => {
      if (ev.type !== 'notify') return
      for (const m of ev.messages) {
        try {
          if (m.key.fromMe) continue
          if (m.key.id && seenInbound.has(m.key.id)) continue
          if (m.key.id) {
            seenInbound.add(m.key.id)
            if (seenInbound.size > 2000) seenInbound.delete(seenInbound.values().next().value)
          }
          const jid = m.key.remoteJid || ''
          if (!jid.endsWith('@s.whatsapp.net')) continue // ignore groups/status/broadcast
          const phone = jid.split('@')[0]
          const msg = m.message || {}
          const text =
            msg.conversation ||
            msg.extendedTextMessage?.text ||
            msg.imageMessage?.caption ||
            msg.videoMessage?.caption ||
            msg.buttonsResponseMessage?.selectedDisplayText ||
            msg.listResponseMessage?.title ||
            ''
          let mediaFile = null
          if (msg.imageMessage || msg.documentMessage) {
            try {
              const buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
              const ext = msg.imageMessage ? 'jpg' : (msg.documentMessage?.fileName?.split('.').pop() || 'bin')
              const file = `${phone}-${Date.now()}.${ext}`
              fs.writeFileSync(path.join(config.mediaDir, file), buf)
              mediaFile = file
            } catch (e) {
              console.error('[wa] media download failed:', e.message)
            }
          }
          if (wa.onInbound) await wa.onInbound({ phone, text: (text || '').trim(), mediaFile, raw: m })
        } catch (e) {
          console.error('[wa] inbound handler error:', e.message)
        }
      }
    })
  } catch (e) {
    wa.status = 'error'
    wa.lastError = e.message
    starting = false
    console.error('[wa] start failed:', e.message)
    setTimeout(() => startWhatsApp(), 10000)
  }
}

export function jidOf(phone) { return `${phone}@s.whatsapp.net` }

/** Does this number have WhatsApp? Returns the canonical jid or null. */
/** Tri-state on purpose. "I could not ask" is not the same as "no account",
 *  and conflating them marked 900+ perfectly good numbers as undeliverable
 *  the moment the socket dropped. */
export async function lookupOnWhatsApp(phone) {
  if (!wa.sock || wa.status !== 'open') return { state: 'unknown', jid: null }
  try {
    const res = await wa.sock.onWhatsApp(jidOf(phone))
    if (!Array.isArray(res)) return { state: 'unknown', jid: null }
    const hit = res.find((r) => r.exists)
    return hit ? { state: 'yes', jid: hit.jid } : { state: 'no', jid: null }
  } catch {
    return { state: 'unknown', jid: null }
  }
}

export async function checkOnWhatsApp(phone) {
  const r = await lookupOnWhatsApp(phone)
  return r.state === 'yes' ? r.jid : null
}

export async function sendText(phone, body) {
  if (config.dryRun) {
    console.log(`[dry-run] -> ${phone}\n${body}\n---`)
    return { dryRun: true }
  }
  if (!wa.sock || wa.status !== 'open') throw new Error('WhatsApp not connected')
  // A number with no WhatsApp account silently swallows the message, and the log
  // would then claim it was delivered. Refuse instead, so the operator sees it.
  const look = await lookupOnWhatsApp(phone)
  if (look.state === 'no') {
    const e = new Error('number is not on WhatsApp')
    e.permanent = true
    throw e
  }
  if (look.state === 'unknown') {
    // Could not ask. Transient, so the message waits rather than being written off.
    throw new Error('could not verify the number right now, will retry')
  }
  const jid = look.jid
  if (config.typingSimulation) {
    try {
      await wa.sock.presenceSubscribe(jid)
      await wa.sock.sendPresenceUpdate('composing', jid)
      await new Promise((r) => setTimeout(r, Math.min(6000, 800 + body.length * 25)))
      await wa.sock.sendPresenceUpdate('paused', jid)
    } catch {}
  }
  return wa.sock.sendMessage(jid, { text: body })
}

export async function logout() {
  try { await wa.sock?.logout() } catch {}
  fs.rmSync(config.authDir, { recursive: true, force: true })
  wa.status = 'logged-out'
  db.ops('wa_logout_manual')
  setTimeout(() => startWhatsApp(), 1500)
}
