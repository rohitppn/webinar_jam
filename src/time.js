import { DateTime } from 'luxon'
import { config } from './config.js'

export const now = () => DateTime.now().setZone(config.tz)
export const fromISO = (s) => DateTime.fromISO(s, { zone: config.tz })
export const eventStart = () => fromISO(config.eventStart)

/** Absolute send time for a scheduled message, from its offset in minutes. */
export const sendTimeFor = (msg) => eventStart().plus({ minutes: msg.at })

export const dayKey = (dt = now()) => dt.toFormat('yyyy-LL-dd')
export const stamp = (dt = now()) => dt.toFormat('yyyy-LL-dd HH:mm:ss')
export const isoStamp = (dt = now()) => dt.toISO()

/** Is `dt` inside the allowed sending window? `late` allows the event-night P1 window. */
export function inSendWindow(dt = now(), late = false) {
  const h = dt.hour + dt.minute / 60
  const end = late ? config.lateWindowEndHour : config.quietEndHour
  return h >= config.quietStartHour && h < end
}

/** Next moment the window opens again. */
export function nextWindowOpen(dt = now()) {
  const h = dt.hour + dt.minute / 60
  if (h < config.quietStartHour) return dt.set({ hour: config.quietStartHour, minute: 0, second: 0, millisecond: 0 })
  return dt.plus({ days: 1 }).set({ hour: config.quietStartHour, minute: 0, second: 0, millisecond: 0 })
}

export const isEventDay = (dt = now()) => dayKey(dt) === config.eventDayException
export const randomGapMs = () => {
  const { minGapSeconds: a, maxGapSeconds: b } = config
  return Math.round((a + Math.random() * Math.max(0, b - a)) * 1000)
}
