const $ = (s) => document.querySelector(s)
const api = async (url, opts) => (await fetch(url, opts)).json()
const post = (url, body) => api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))

let S = {}

document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b))
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('on', s.id === b.dataset.t))
  refreshTab(b.dataset.t)
})

async function refreshStatus() {
  S = await api('/api/status')
  const w = S.wa.status
  const pill = (el, cls, text) => { const e = $(el); e.className = 'pill ' + cls; e.textContent = text }
  pill('#waPill', w === 'open' ? 'ok' : (w === 'qr' ? 'warn' : 'bad'), 'WhatsApp: ' + w)
  const sb = S.supabase || {}
  pill('#sbPill', sb.ready ? 'ok' : (sb.enabled ? 'warn' : ''), 'Supabase: ' + (sb.ready ? 'live' : sb.enabled ? 'retrying' : 'off'))
  pill('#sheetPill', S.sheets.ready ? 'ok' : (S.sheets.enabled ? 'warn' : ''), 'Sheets: ' + (S.sheets.ready ? 'live' : S.sheets.enabled ? 'retrying' : 'off'))
  const t = S.throttle
  pill('#throttlePill', t.restUntil && new Date(t.restUntil) > new Date() ? 'warn' : '', `${t.burstCount}/${t.burstSize} burst · ${t.sentToday}/${t.dailyCap} today`)
  $('#clock').textContent = S.now
  $('#pauseBtn').textContent = S.settings.paused ? 'Resume' : 'Pause'
  $('#pauseBtn').className = S.settings.paused ? 'act' : 'ghost'

  const st = S.stats
  $('#stats').innerHTML = [
    ['Contacts', st.contacts], ['Confirmed', st.confirmed], ['Replied', st.replied],
    ['Attended', st.attended], ['Booked', st.booked], ['Opted out', st.optedOut],
    ['Queue', st.queuePending], ['Screenshots', st.screenshotsPending]
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('')

  const d = S.dispatcher
  $('#disp').innerHTML = `
    <div>Status: <b>${esc(d.blocked || 'sending')}</b></div>
    <div>Last send: ${d.lastSendAt ? new Date(d.lastSendAt).toLocaleString() : '—'}</div>
    <div>Next attempt: ${d.nextSendAt ? new Date(d.nextSendAt).toLocaleTimeString() : '—'}</div>
    <div class="mut" style="margin-top:8px">Throttle: ${t.burstSize} per burst, ${t.burstRestMinutes} min rest, ${t.gap} gaps, window ${t.window}${S.dryRun ? ' · <b style="color:var(--warn)">DRY RUN</b>' : ''}</div>`

  const warn = []
  if (w !== 'open') warn.push('WhatsApp is not connected — go to <b>Connect</b> and scan the QR.')
  if (S.settings.paused) warn.push('Sending is <b>paused</b>.')
  if (!S.settings.campaignArmed) warn.push('Campaign is <b>disarmed</b> — scheduled messages will not queue.')
  if (!S.settings.one_line_action) warn.push('<b>one_line_action</b> is empty — P7 is held until you fill it in.')
  if (S.sheets.enabled && !S.sheets.ready) warn.push('Google Sheets is not writing: ' + esc(S.sheets.error))
  if (sb.enabled && !sb.ready) warn.push('Supabase is not writing: ' + esc(sb.error) + (sb.buffered ? ` — ${sb.buffered} writes buffered` : ''))
  if ((S.unsetConfig || []).length) warn.push(`Not set in Railway variables: <b>${S.unsetConfig.join(', ')}</b> — every message using them is held until you set them.`)
  $('#warnings').innerHTML = warn.map((x) => `<div class="banner">${x}</div>`).join('')

  for (const k of ['seats_left', 'seats_taken', 'one_line_action']) {
    if (document.activeElement !== $('#' + k)) $('#' + k).value = S.settings[k] || ''
  }
}

$('#pauseBtn').onclick = async () => { await post('/api/settings', { paused: !S.settings.paused }); refreshStatus() }
$('#saveSettings').onclick = async () => {
  await post('/api/settings', { seats_left: $('#seats_left').value, seats_taken: $('#seats_taken').value, one_line_action: $('#one_line_action').value })
  refreshStatus()
}

async function refreshQR() {
  const q = await api('/api/qr')
  $('#qrBox').innerHTML = q.qr
    ? `<img src="${q.qr}"><p class="mut">Scan within 60 seconds. The code refreshes automatically.</p>`
    : (q.status === 'open'
        ? `<p style="color:var(--accent);font-size:18px">Connected${S.wa && S.wa.me ? ' as ' + esc(S.wa.me.split(':')[0]) : ''}</p>`
        : `<p class="mut">Status: ${esc(q.status)} — waiting for a QR code…</p>`)
}
$('#logoutBtn').onclick = async () => { if (confirm('Log out this WhatsApp session?')) { await post('/api/logout'); setTimeout(refreshQR, 2500) } }

async function refreshContacts() {
  const list = await api('/api/contacts?q=' + encodeURIComponent($('#search').value || ''))
  $('#ctable').innerHTML = `<tr><th>Name</th><th>Phone</th><th>Flags</th><th>Sent</th><th>Last reply</th><th></th></tr>` +
    list.map((c) => `<tr>
      <td>${esc(c.first_name)}<div class="mut" style="font-size:11px">${esc(c.email || '')}</div></td>
      <td>${esc(c.phone)}</td>
      <td>${c.confirmed ? '<span class="tag">CONFIRMED</span>' : ''}${c.attended ? '<span class="tag">ATTENDED</span>' : ''}${c.booked ? '<span class="tag">BOOKED</span>' : ''}${c.optedOut ? '<span class="tag" style="color:var(--bad)">STOP</span>' : ''}${(c.tags || []).filter((t) => !['CONFIRMED', 'STOP', 'BOOKED'].includes(t)).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
      <td class="mut" style="font-size:11px">${Object.keys(c.sent || {}).join(' ')}</td>
      <td class="mut" style="font-size:12px;max-width:260px">${esc((c.last_inbound_text || '').slice(0, 90))}</td>
      <td><button class="ghost" onclick="flag('${c.phone}','attended',${!c.attended})">${c.attended ? 'unmark' : 'mark'} attended</button></td>
    </tr>`).join('')
}
window.flag = async (phone, key, val) => { await post(`/api/contact/${phone}/flag`, { [key]: val }); refreshContacts() }
$('#search').oninput = () => { clearTimeout(window._s); window._s = setTimeout(refreshContacts, 250) }
$('#msgSearch').oninput = () => { clearTimeout(window._m); window._m = setTimeout(refreshSent, 250) }
$('#inSearch').oninput = () => { clearTimeout(window._i); window._i = setTimeout(refreshReplies, 250) }

async function refreshQueue() {
  const q = await api('/api/queue')
  $('#qtable').innerHTML = `<tr><th>Msg</th><th>Phone</th><th>Not before</th><th>Priority</th><th>Preview</th><th></th></tr>` +
    q.map((x) => `<tr>
      <td><b>${esc(x.messageId)}</b></td><td>${esc(x.phone)}</td>
      <td class="mut">${new Date(x.notBefore).toLocaleString()}</td><td>${x.priority}</td>
      <td class="mut" style="max-width:380px;font-size:12px">${esc(x.body.slice(0, 110))}…</td>
      <td><button class="ghost" onclick="cancelQ('${x.id}')">cancel</button></td>
    </tr>`).join('') || '<tr><td class="mut">Queue is empty.</td></tr>'
}
window.cancelQ = async (id) => { await post(`/api/queue/${id}/cancel`); refreshQueue() }

async function refreshSent() {
  const [rows, stats] = await Promise.all([
    api('/api/logs/messages?q=' + encodeURIComponent($('#msgSearch').value || '')),
    api('/api/logs/stats')
  ])
  const st = stats.byStatus || {}
  $('#msgStats').innerHTML = [
    ['Sent', st.sent || 0], ['Skipped', st.skipped || 0], ['Failed', st.failed || 0], ['Total logged', stats.total || 0]
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('')
  $('#msgTable').innerHTML = `<tr><th>When</th><th>Msg</th><th>To</th><th>Status</th><th>Text</th></tr>` +
    rows.map((r) => `<tr>
      <td class="mut" style="white-space:nowrap;font-size:12px">${esc(r.timestamp)}</td>
      <td><b>${esc(r.message_id)}</b></td>
      <td>${esc(r.first_name)}<div class="mut" style="font-size:11px">${esc(r.phone)}</div></td>
      <td><span class="tag" style="${r.status === 'sent' ? 'color:var(--accent)' : r.status === 'failed' ? 'color:var(--bad)' : 'color:var(--muted)'}">${esc(r.status)}</span>${r.error ? `<div class="mut" style="font-size:11px">${esc(r.error)}</div>` : ''}</td>
      <td class="mut" style="font-size:12px;max-width:420px">${esc((r.text || '').slice(0, 160))}</td>
    </tr>`).join('') || '<tr><td class="mut">Nothing sent yet.</td></tr>'
}

async function refreshReplies() {
  const rows = await api('/api/logs/inbound?q=' + encodeURIComponent($('#inSearch').value || ''))
  $('#inTable').innerHTML = `<tr><th>When</th><th>From</th><th>Keyword</th><th>Message</th><th>Image</th></tr>` +
    rows.map((r) => `<tr>
      <td class="mut" style="white-space:nowrap;font-size:12px">${esc(r.timestamp)}</td>
      <td>${esc(r.first_name)}<div class="mut" style="font-size:11px">${esc(r.phone)}</div></td>
      <td>${r.keyword ? `<span class="tag">${esc(r.keyword)}</span>` : ''}</td>
      <td style="max-width:460px">${esc(r.text || '')}</td>
      <td>${r.media_file ? `<a href="/media/${encodeURIComponent(r.media_file)}" target="_blank">view</a>` : ''}</td>
    </tr>`).join('') || '<tr><td class="mut">No replies yet.</td></tr>'
}

async function refreshShots() {
  const list = await api('/api/screenshots')
  $('#shotList').innerHTML = list.map((s) => `<div class="shot">
    <a href="/media/${encodeURIComponent(s.file)}" target="_blank"><img src="/media/${encodeURIComponent(s.file)}"></a>
    <div style="flex:1">
      <b>${esc(s.first_name)}</b> · ${esc(s.phone)}<br>
      <span class="mut">${new Date(s.at).toLocaleString()}</span>
      <div class="mut">${esc(s.caption || '')}</div>
      <div style="margin-top:10px">${s.handled
        ? `<span class="tag">${s.rejected ? 'rejected' : 'Calendly sent'}</span>`
        : `<button class="act" onclick="sendSS('${s.id}')">Verified — send Calendly</button>
           <button class="ghost" onclick="rejectSS('${s.id}')">Not a valid payment</button>`}</div>
    </div></div>`).join('') || '<p class="mut">No screenshots yet.</p>'
}
window.sendSS = async (id) => { if (confirm('Confirm the ₹999 actually landed, then send the Calendly link?')) { await post(`/api/screenshots/${id}/send-ss`); refreshShots() } }
window.rejectSS = async (id) => { await post(`/api/screenshots/${id}/reject`); refreshShots() }

async function refreshTimeline() {
  const t = await api('/api/timeline')
  $('#ttable').innerHTML = `<tr><th>ID</th><th>When (IST)</th><th>Audience</th><th>Eligible</th><th>Sent</th><th>State</th></tr>` +
    t.map((x) => `<tr><td><b>${esc(x.id)}</b></td><td>${esc(x.due)}</td><td class="mut">${esc(x.label)}</td>
      <td>${x.eligible}</td><td>${x.sentCount}</td>
      <td><span class="pill ${x.state === 'sent' ? 'ok' : x.state === 'due' ? 'warn' : ''}">${x.state}</span></td></tr>`).join('')
}

async function refreshOps() {
  const ops = await api('/api/ops')
  $('#ops').innerHTML = ops.slice(0, 20).map((o) => `<div class="mut" style="font-size:12px;padding:3px 0;border-bottom:1px solid var(--line)">
    ${new Date(o.at).toLocaleString()} · <b style="color:var(--ink)">${esc(o.event)}</b> ${esc(o.detail)}</div>`).join('') || '<span class="mut">Nothing yet.</span>'
}

// tools
$('#addContact').onclick = async () => {
  const r = await post('/api/contacts', { name: $('#nName').value, first_name: $('#nName').value, phone: $('#nPhone').value, email: $('#nEmail').value, sendM1: $('#nM1').checked })
  alert(r.ok ? 'Added.' + ($('#nM1').checked ? ' M1 queued.' : '') : 'Error: ' + r.error)
  $('#nPhone').value = ''
}
const uploadCsv = async (input, url, extra) => {
  if (!input.files[0]) return alert('Pick a file first.')
  const fd = new FormData(); fd.append('file', input.files[0])
  for (const [k, v] of Object.entries(extra || {})) fd.append(k, v)
  const r = await (await fetch(url, { method: 'POST', body: fd })).json()
  alert(JSON.stringify(r))
}
$('#impBtn').onclick = () => uploadCsv($('#impFile'), '/api/import/contacts', { sendM1: $('#impM1').checked })
$('#attBtn').onclick = () => uploadCsv($('#attFile'), '/api/import/attendance')
$('#snBtn').onclick = async () => {
  const r = await post('/api/send-now', { phone: $('#snPhone').value, messageId: $('#snMsg').value })
  alert(r.ok ? 'Queued.' : 'Error: ' + r.error)
}
$('#snMsg').onchange = async () => {
  const p = await api('/api/messages/' + $('#snMsg').value + '/preview')
  $('#preview').textContent = p.body || ''
}
$('#ssBtn').onclick = async () => {
  const r = await post('/api/send-ss', { phone: $('#ssPhone').value })
  alert(r.ok ? 'Calendly link queued; contact marked booked.' : 'Error: ' + r.error)
}

async function loadMessages() {
  const ms = await api('/api/messages')
  $('#snMsg').innerHTML = ms.map((m) => `<option value="${m.id}">${m.id} — ${esc(m.label)}</option>`).join('')
  $('#snMsg').onchange()
}

function refreshTab(t) {
  ({ connect: refreshQR, contacts: refreshContacts, queue: refreshQueue, sent: refreshSent,
     replies: refreshReplies, shots: refreshShots, timeline: refreshTimeline, dash: refreshOps }[t] || (() => {}))()
}

refreshStatus(); loadMessages(); refreshOps()
setInterval(refreshStatus, 5000)
setInterval(() => {
  const on = document.querySelector('section.on').id
  refreshTab(on)
}, 8000)
