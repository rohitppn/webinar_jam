import 'dotenv/config'
import path from 'node:path'
import fs from 'node:fs'

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v))
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)))

// On Railway attach a Volume mounted at /data so the WhatsApp session survives redeploys.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.resolve('data'))
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true })

export const config = {
  port: num(process.env.PORT, 3000),
  tz: process.env.TZ_NAME || 'Asia/Kolkata',
  dataDir: DATA_DIR,
  authDir: path.join(DATA_DIR, 'wa-auth'),
  mediaDir: path.join(DATA_DIR, 'media'),

  // --- security ---
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'change-me',
  webhookToken: process.env.WEBHOOK_TOKEN || 'change-me-too',

  // --- event ---
  // Event start, in local tz. Every scheduled message is an offset from this instant.
  eventStart: process.env.EVENT_START || '2026-09-18T21:00:00',
  eventDayException: process.env.EVENT_DAY_EXCEPTION ?? '2026-09-18', // day where >1 msg/contact is allowed

  // --- throttle (the numbers you asked for) ---
  burstSize: num(process.env.BURST_SIZE, 30),            // messages per burst
  burstRestMinutes: num(process.env.BURST_REST_MINUTES, 60), // pause after a full burst
  minGapSeconds: num(process.env.MIN_GAP_SECONDS, 45),   // random gap between two sends
  maxGapSeconds: num(process.env.MAX_GAP_SECONDS, 110),
  dailyCap: num(process.env.DAILY_CAP, 120),             // hard per-day ceiling on the number
  quietStartHour: num(process.env.QUIET_START_HOUR, 8),  // no sends before 08:00
  quietEndHour: num(process.env.QUIET_END_HOUR, 23),     // no sends after 23:00 ...
  lateWindowEndHour: num(process.env.LATE_WINDOW_END_HOUR, 23.5), // ... except P1 on event night
  onePerContactPerDay: bool(process.env.ONE_PER_CONTACT_PER_DAY, true),

  // --- sending behaviour ---
  dryRun: bool(process.env.DRY_RUN, false),
  typingSimulation: bool(process.env.TYPING_SIMULATION, true),
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '91',

  // --- google sheets ---
  sheetId: process.env.GOOGLE_SHEET_ID || '',
  googleCreds: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  sheetsEnabled: !!(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON),

  // --- supabase (optional mirror + restore) ---
  supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  supabaseKey: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '',
  supabaseEnabled: !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY)),

  // --- links / merge values ---
  // No defaults on purpose: this repo is public. Set these in Railway's variables.
  // A message that needs one of these is held, not sent blank — see render.js.
  joinLink: process.env.JOIN_LINK || '',
  calendlyLink: process.env.CALENDLY_LINK || '',
  upiId: process.env.UPI_ID || '',
  roomCap: num(process.env.ROOM_CAP, 400)
}

export const isDataDirEphemeral = DATA_DIR !== '/data' && !!process.env.RAILWAY_ENVIRONMENT
