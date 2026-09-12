# TheBroThing — WhatsApp Masterclass Sequencer

Runs the full WhatsApp sequence from `TheBroThing_Masterclass_Comms_Sequence_FINAL.docx`.
WebinarJam registration → instant M1 → throttled pre-event sequence → attendance segmentation →
post-event P/D tracks. Every send, reply and flag is mirrored into Google Sheets.

Not the WhatsApp Business API. It links to the **WhatsApp Business app on your own number** by QR,
exactly as rule 6 of the doc requires.

---

## What it does

| Piece | Behaviour |
|---|---|
| **M1** | Fires within seconds of the WebinarJam form being submitted (queued at top priority). |
| **M1R** | Auto-replies to `CONFIRMED`, tolerating one typo. The only automated reply in the system. |
| **M2–M6** | Scheduled 7:30 PM sends to all registrants. |
| **M7** | 7:00 PM Friday — **only** to contacts with at least one inbound reply. Never-replied contacts get nothing. |
| **M8** | 8:55 PM Friday to everyone who received M7. |
| **P1** | 10:30 PM Friday to attendees, using the late-night window exception. |
| **SS** | Never automatic. A human opens the screenshot, confirms the ₹999 landed, clicks send. |
| **NA1 / P2–P7 / FC / D1 / D2** | Scheduled with the exact audiences from the doc. Booking exits P and D instantly. |
| **STOP** | Removes the contact from everything within the minute, permanently, and logs it. |

### Throttle (your rule)

**30 messages, then a 60-minute rest**, then 30 more. Random 45–110 second gaps inside a burst,
so 30 sends take roughly 40 minutes and never look like a machine. Also enforced:

- hard ceiling of 120 sends/day on the number
- no sends outside 08:00–23:00 IST (P1 on event night runs to 23:30)
- never two messages to one contact in a day, except on event day and for replies to an inbound

> Your comms doc specifies **15/hour**, not 30. 30/hour on a number that hasn't been warmed for
> 14 days is how numbers get banned. To follow the doc, set `BURST_SIZE=15`. Nothing else changes.

---

## Deploy to Railway

### 1. Push the code

```bash
cd wa-sequencer
git init && git add -A && git commit -m "WhatsApp sequencer"
gh repo create thebrothing-wa --private --source=. --push
```

### 2. Create the Railway service

New Project → Deploy from GitHub repo → pick the repo. Nixpacks builds it automatically.

### 3. Add a Volume — this step is not optional

Service → **Variables/Settings → Volumes → New Volume**, mount path exactly:

```
/data
```

Without it, every redeploy logs WhatsApp out and you rescan the QR, losing the queue and contacts.

### 4. Set environment variables

| Variable | Value |
|---|---|
| `ADMIN_USER` | your login for the dashboard |
| `ADMIN_PASS` | a long password |
| `WEBHOOK_TOKEN` | a long random string |
| `EVENT_START` | `2026-09-18T21:00:00` |
| `EVENT_DAY_EXCEPTION` | `2026-09-18` |
| `BURST_SIZE` | `30` |
| `BURST_REST_MINUTES` | `60` |
| `GOOGLE_SHEET_ID` | the id from the sheet URL |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the whole service-account JSON, or its base64 |
| `JOIN_LINK` | **required** — the WebinarJam attendee join link |
| `CALENDLY_LINK` | **required** — the consultation booking link |
| `UPI_ID` | **required** — the UPI id for the ₹999 |

> This repo is public, so `JOIN_LINK`, `CALENDLY_LINK` and `UPI_ID` have **no defaults in the code**.
> Set all three in Railway before the campaign starts. Any message that uses one of them is held
> until it is set — M7 and M8 will not go out with a blank join link, and P1/P2/P4/P5/NA1 will not
> go out with a blank UPI id. The dashboard shows a banner listing anything still unset.

Everything else has a working default — see `.env.example`.

### 5. Generate a domain

Settings → Networking → Generate Domain. That URL is your dashboard.

### 6. Scan the QR

Open `https://your-app.up.railway.app/` → log in → **Connect** tab.
On the campaign phone: WhatsApp → Settings → Linked devices → Link a device → scan.

The status pill turns green. The session now survives redeploys.

### 7. Point WebinarJam at the webhook

WebinarJam → your webinar → Integrations → Webhook (or Zapier/Make → Webhooks → POST):

```
https://your-app.up.railway.app/webhook/webinarjam?token=YOUR_WEBHOOK_TOKEN
```

Send `first_name`, `phone`, `email`. The endpoint also accepts `name`, `phone_number`,
`mobile`, `user_phone` and form-encoded bodies, so most integration tools work unchanged.
Indian 10-digit numbers get `91` prefixed automatically.

---

## Where the data lives

The dashboard is the record. Everything is written to the Railway volume at `/data` and readable
in the browser:

- **Contacts** — every registrant with flags, tags, replies and which messages they received
- **Sent log** — every message with timestamp, status and the exact text that went out
- **Replies** — every inbound message with the keyword it matched, and any image received
- **Screenshots** — the ₹999 review inbox

Each of those exports to CSV from its own tab. Google Sheets below is **optional** — a live mirror,
not the store. Leave `GOOGLE_SHEET_ID` unset and nothing is lost.

## Google Sheets setup (optional)

1. Google Cloud Console → new project → enable **Google Sheets API**.
2. Create a **Service Account** → Keys → Add key → JSON. Download it.
3. Create a Google Sheet. Share it with the service account's `client_email` as **Editor**.
4. Put the sheet id (the long string in its URL) in `GOOGLE_SHEET_ID` and the whole JSON file
   contents in `GOOGLE_SERVICE_ACCOUNT_JSON`.

Four tabs are created and maintained automatically:

- **Contacts** — one live row per person: flags, tags, inbound count, last reply, every message sent
- **Message_Log** — every send with timestamp, status, and the text that went out
- **Inbound_Log** — every reply with the matched keyword
- **Ops_Log** — registrations, opt-outs, burst rests, failures

If Sheets is down the writes buffer in memory and flush on reconnect. Everything is also written
to JSONL files on the volume, so nothing is ever lost.

---

## Running the week

**Before go-live**
1. Connect tab → scan QR.
2. Tools tab → add your own number → send M1 → check it arrives and reads correctly.
3. Dashboard → set `seats_taken` and `seats_left`.

**Thursday** — update `seats_taken` to the live WebinarJam count before 7:30 PM (M6 uses it).

**Friday night**
1. Export attendance from WebinarJam after the session.
2. Tools → Import attendance → upload the CSV. Everyone matched is flagged attended.
3. P1 goes out at 10:30 PM to attendees only; everyone else moves to NA1 on Saturday.

**Whenever a ₹999 screenshot arrives** — Screenshots tab. Open the image, confirm the money
actually landed, click **Verified — send Calendly**. That queues SS, marks them booked, and
cancels their remaining P and D messages. Nothing is verified automatically, anywhere.

**Saturday** — write the P7 one-liner into `one_line_action`. P7 is held until you do.

**Any time** — the Pause button stops all sending immediately without losing the queue.

---

## Safety notes

- Test with `DRY_RUN=true` first: messages are logged, nothing is sent.
- Rule 6 says one number per 250 registrants. This app drives **one** number. For more than 250
  contacts, run a second Railway service with its own volume, its own number, and its own contact
  list — never point two services at one list.
- Age the number at least 14 days with normal human use before the first campaign send.
- If the number gets restricted, stop that service. Do not swap in a replacement mid-campaign.
- This is an unofficial WhatsApp client. Bans are possible. The throttle reduces the risk; it does
  not remove it.

## Local development

```bash
npm install
cp .env.example .env   # set DRY_RUN=true
npm start              # http://localhost:3000
```

Testing helper — simulate an inbound reply without a phone:

```bash
curl -u admin:pass -X POST localhost:3000/api/simulate-inbound \
  -H 'content-type: application/json' -d '{"phone":"9876543210","text":"CONFIRMED"}'
```
