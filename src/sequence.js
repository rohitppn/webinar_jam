// All copy is verbatim from TheBroThing_Masterclass_Comms_Sequence_FINAL.docx.
// `at` is minutes relative to EVENT_START (Fri 18 Sep 2026, 21:00 IST). Negative = before.
// `audience(c, ctx)` decides, per contact, whether this message applies.

export const AUDIENCE = {
  all: (c) => true,
  replied: (c) => (c.inboundCount || 0) > 0,
  gotM7: (c) => !!(c.sent && c.sent.M7),
  attended: (c) => !!c.attended,
  noShow: (c) => !c.attended,
  attendedNotBooked: (c) => !!c.attended && !c.booked,
  attendedNotBookedNoD1Reply: (c) => !!c.attended && !c.booked && !c.repliedAfterD1,
  silentAfterEvent: (c) => !c.booked && !c.repliedAfterEvent
}

export const MESSAGES = [
  // ---------- pre-event ----------
  {
    id: 'M1',
    label: 'Instant on registration',
    trigger: 'instant',
    priority: 0, // jumps the queue
    audience: AUDIENCE.all,
    body: `{first_name}, Arunav here from TheBroThing.

You're in for Friday, 18 September, 9 PM. The masterclass where I show you the system my clients use to get 2 to 3 dates in 72 hours.

Reply *CONFIRMED* to lock your seat. 400 seats, live only.

And save this number as TheBroThing, or Friday's link may not reach you.`
  },
  {
    id: 'M1R',
    label: 'Auto-reply on CONFIRMED',
    trigger: 'inbound',
    priority: 0,
    replyToInbound: true, // a reply to the contact's own message — exempt from one-per-day
    audience: AUDIENCE.all,
    body: `Locked. One question so I can build Friday around real situations: what's the one thing that keeps going wrong for you in dating right now? One line is enough.`
  },
  {
    id: 'M2', label: 'Sun 13 Sep, 7:30 PM', trigger: 'scheduled', at: -7290, priority: 5,
    audience: AUDIENCE.all,
    body: `{first_name}, five days to Friday.

If you haven't told me yet: what's the one thing that keeps going wrong for you in dating right now? One line. I'm building Friday around the answers.`
  },
  {
    id: 'M3', label: 'Mon 14 Sep, 7:30 PM', trigger: 'scheduled', at: -5850, priority: 5,
    audience: AUDIENCE.all,
    body: `Everyone who attends Friday live gets FlirtCoach AI free, the tool my clients use between sessions.

Want it set up for you after the session? Reply *YES*.`
  },
  {
    id: 'M4', label: 'Tue 15 Sep, 7:30 PM', trigger: 'scheduled', at: -4410, priority: 5,
    audience: AUDIENCE.all,
    body: `72 hours to go, {first_name}. Friday, 9 PM.

Four things on Friday: the top 1% profile, the flirt texting framework, styling, and the cold approach protocol. If there's one you want me to spend more time on, reply with the word. Profile, texting, styling, or approach.`
  },
  {
    id: 'M5', label: 'Wed 16 Sep, 7:30 PM', trigger: 'scheduled', at: -2970, priority: 5,
    audience: AUDIENCE.all,
    body: `48 hours, {first_name}. If there's a question about your own situation you want answered on Friday, send it here now. The specific ones get answered first.`
  },
  {
    id: 'M6', label: 'Thu 17 Sep, 7:30 PM', trigger: 'scheduled', at: -1530, priority: 5,
    audience: AUDIENCE.all,
    body: `Tomorrow, 9 PM, {first_name}. The room is capped at 400 and {seats_taken} seats are taken.

If you haven't replied *CONFIRMED* yet, do it now so your seat isn't released. Your join link comes here tomorrow morning.`
  },
  {
    id: 'M7', label: 'Fri 18 Sep, 7:00 PM (replied contacts only)', trigger: 'scheduled', at: -120, priority: 2,
    audience: AUDIENCE.replied,
    body: `Two hours, {first_name}. Join link: {join_link}

Be seated alone for the hour, earphones in, something to take notes on. I start at 9 sharp.`
  },
  {
    id: 'M8', label: 'Fri 18 Sep, 8:55 PM', trigger: 'scheduled', at: -5, priority: 1,
    audience: AUDIENCE.gotM7,
    body: `Starting now. {join_link}`
  },

  // ---------- post-event ----------
  {
    id: 'P1', label: 'Fri 18 Sep, 10:30 PM — offer + ₹999 call booking', trigger: 'scheduled', at: 90, priority: 2,
    audience: AUDIENCE.attended, lateWindow: true,
    body: `Thanks for staying till the end, {first_name}.

As I said in the session: five seats in this batch, the full programme, ₹80,000 plus GST, work starts next week.

If you want one, the next step is a 20-minute call with me. To book it, send ₹999 to *{upi_id}* and reply with the screenshot. You get your slot within the hour, and the ₹999 comes off your programme fee.

If you're not there yet, no reply needed. The system from tonight is yours.`
  },
  {
    id: 'SS', label: 'Manual — after a human verifies the ₹999', trigger: 'manual', priority: 0,
    replyToInbound: true, lateWindow: true,
    audience: AUDIENCE.all,
    body: `Got it. Pick any slot in the next 72 hours: {calendly_link}

Come with your specific situation; the call is about you, not the programme.`
  },
  {
    id: 'NA1', label: 'Sat 19 Sep, 11:00 AM — missed it', trigger: 'scheduled', at: 840, priority: 5,
    audience: AUDIENCE.noShow,
    body: `You missed last night, {first_name}. No replay, I don't record these. Two options: the next masterclass is Thursday 8 October, or if your situation can't wait, ₹999 to *{upi_id}* books a 20-minute call with me this week and comes off the fee if you join.`
  },
  {
    id: 'P2', label: 'Sat 19 Sep, 11:00 AM — Akshay review', trigger: 'scheduled', at: 840, priority: 5,
    audience: AUDIENCE.attendedNotBooked,
    body: `Akshay was in the last batch. Same starting point as a lot of you: apps on, almost no matches. Here's what changed, in his words: https://youtu.be/DeBM6430Ti8

{seats_left} seats remaining. ₹999 to *{upi_id}* and send the screenshot to book your call.`
  },
  {
    id: 'FC', label: 'Sat 19 Sep, 11:05 AM — FlirtCoach AI + community', trigger: 'scheduled', at: 845, priority: 5,
    audience: AUDIENCE.attended, ignoreDailyCapPairing: true,
    body: `Your FlirtCoach AI access, as promised: https://thebrothing.com/FlirtCoachAI

And the attendee community: https://www.skool.com/attraction-academy-3111/about

Both are yours for showing up.`
  },
  {
    id: 'P3', label: 'Sat 19 Sep, 7:30 PM — Amit review', trigger: 'scheduled', at: 1350, priority: 5,
    audience: AUDIENCE.attendedNotBooked,
    body: `Amit had never dated before he came in. Late 30s, small town, almost no one on the apps near him. If you think your situation is the hard one, watch his: https://youtu.be/CygNY3BsGRw

{seats_left} seats remaining as of tonight.`
  },
  {
    id: 'P4', label: 'Sun 20 Sep, 11:00 AM — results page', trigger: 'scheduled', at: 2280, priority: 5,
    audience: AUDIENCE.attendedNotBooked,
    body: `Every client result we've recorded is here, in their words, not mine: https://thebrothing.com/ThebrothingClientResults

Calls are being booked through Monday night. ₹999 to *{upi_id}*, screenshot here, slot within the hour.`
  },
  {
    id: 'P5', label: 'Sun 20 Sep, 7:30 PM — seats left, deadline', trigger: 'scheduled', at: 2790, priority: 5,
    audience: AUDIENCE.attendedNotBooked,
    body: `{seats_left} seats left, {first_name}. Booking closes Monday at 9 PM and I don't extend it, because the men already in need my attention from Tuesday.

₹999 to *{upi_id}*, screenshot here. If UPI doesn't work for you, reply *CALL* and I'll send a booking link.`
  },
  {
    id: 'P6', label: 'Mon 21 Sep, 7:30 PM — final hour', trigger: 'scheduled', at: 4230, priority: 5,
    audience: AUDIENCE.attendedNotBooked,
    body: `Last message on the batch. Booking closes at 9 PM tonight. After that it's full and the next intake is October. If you've been going back and forth, that's usually the answer: reply *CALL* or send the ₹999 now.`
  },
  {
    id: 'D1', label: 'Wed 23 Sep, 7:30 PM — downsell 1 (₹35K)', trigger: 'scheduled', at: 7110, priority: 5,
    audience: AUDIENCE.attendedNotBooked,
    body: `Batch is closed. If ₹80K wasn't the right size for you right now, there's a smaller one: the Online Dating package. I rebuild your profile with you, run the texting framework on your live matches for 30 days, and you get FlirtCoach AI for the full period. Ten spots.

Book 15 minutes and I'll tell you the price and whether it fits: {calendly_link}`
  },
  {
    id: 'D2', label: 'Fri 25 Sep, 7:30 PM — downsell 2 (₹15K)', trigger: 'scheduled', at: 9990, priority: 5,
    audience: AUDIENCE.attendedNotBookedNoD1Reply,
    body: `Last option, and it's the one most men in the room can do: the full course. Profile, texting, styling, approach, recorded, with FlirtCoach AI. Under ₹15K.

If you want it, book 15 minutes and we set it up: {calendly_link}. After this, nothing until 8 October.`
  },
  {
    id: 'P7', label: 'Mon 28 Sep, 11:00 AM — October date', trigger: 'scheduled', at: 13800, priority: 5,
    audience: AUDIENCE.silentAfterEvent,
    body: `Next masterclass is Thursday 8 October, 8 PM. I'll send the link when registration opens. Until then, one thing from the session to actually do this week: {one_line_action}.`
  }
]

export const BY_ID = Object.fromEntries(MESSAGES.map((m) => [m.id, m]))
export const SCHEDULED = MESSAGES.filter((m) => m.trigger === 'scheduled')
