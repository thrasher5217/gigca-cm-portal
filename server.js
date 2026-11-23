// GigaCM Portal server: serves the dashboard, stores the latest scan, and holds the action queue
// that the Mac Mini runner drains (Discord sends for CapCut, rescans).
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // mount a Railway volume here
const STATE = path.join(DATA_DIR, 'state.json'), QUEUE = path.join(DATA_DIR, 'queue.json');
const SAMPLE = path.join(__dirname, 'public', 'state.json');
const PASS = process.env.PORTAL_PASSWORD || '', TOKEN = process.env.RUNNER_TOKEN || '';
fs.mkdirSync(DATA_DIR, { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const getState = () => readJson(STATE, null) || readJson(SAMPLE, { campaigns: [], slack: [], audits: [] });
const getQueue = () => readJson(QUEUE, []);

// --- auth: password cookie for you, bearer token for the Mini runner ---
function userAuth(req, res, next) {
  if (!PASS) return next();
  const c = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('gk='));
  if (c && same(c.slice(3), sha(PASS))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login required' });
  res.send('<!doctype html><meta name=viewport content="width=device-width"><body style="background:#0e1012;color:#eee;font:16px system-ui;display:grid;place-items:center;height:100vh"><form method=post action=/login><input type=password name=p placeholder=Password autofocus style="padding:10px;font:inherit"> <button style="padding:10px;font:inherit">Enter</button></form>');
}
function runnerAuth(req, res, next) {
  const h = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (TOKEN && same(h, TOKEN)) return next();
  res.status(401).json({ error: 'bad runner token' });
}
app.post('/login', (req, res) => {
  if (PASS && same(sha(req.body.p || ''), sha(PASS)))
    res.setHeader('Set-Cookie', `gk=${sha(PASS)}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`);
  res.redirect('/');
});

// --- runner API (Mac Mini) ---
const RUNNER = path.join(DATA_DIR, 'runner.json'); // Mac Mini heartbeat + last scheduled slot
// Scopes: all | <campaign> | dms | slack | channel:<campaign>:<id> | parts:<list> where the list picks pieces, e.g.
// parts:lp.capcut,dc.artlist,slack (lp = LaunchPoint analytics, dc = Discord messages, for that campaign).
const CAMPS = ['capcut', 'artlist', 'creatify', 'melius', 'yri'];
const MINE = ['capcut', 'yri']; // campaigns where Ty is the coach: replies can be sent from the portal
const SENDABLE = [...CAMPS, 'coaches']; // live replies Ty sends himself: his creators, @tags of him in any campaign, the coaches server
// Messages queued before sending was turned on were never meant to go out: cancel them once so they can't be sent by surprise.
{ const q = getQueue(); let n = 0;
  q.forEach(a => { if (a.type === 'discord_send' && a.status === 'pending' && !a.live) { a.status = 'cancelled'; a.detail = 'queued before sending was turned on'; n++; } });
  if (n) writeJson(QUEUE, q); }
const PART = `((lp|dc)\\.(${CAMPS.join('|')})|dms|slack|coaches)`;
const SCOPE_OK = new RegExp(`^(all|${CAMPS.join('|')}|dms|slack|coaches|channel:(${CAMPS.join('|')}):\\d{15,22}|parts:${PART}(,${PART})*)$`);
const ALL_PARTS = [...CAMPS.map(c => 'lp.' + c), ...CAMPS.map(c => 'dc.' + c), 'dms', 'coaches', 'slack'];
function toParts(s) {
  if (s === 'all') return ALL_PARTS;
  if (CAMPS.includes(s)) return ['lp.' + s, 'dc.' + s];
  if (s === 'dms' || s === 'slack' || s === 'coaches') return [s];
  if (s.startsWith('channel:')) return ['dc.' + s.split(':')[1]];
  return s.slice(6).split(',');
}
// One run covers every waiting request: a single scope runs as is, several are merged into the pieces they need.
function mergeScopes(list) {
  const u = [...new Set(list)];
  if (u.length === 1) return normScope(u[0]);
  return partsScope(new Set(u.flatMap(toParts)));
}
// Only the coaches server -> the plain 'coaches' scope, so the Mac Mini gets one fixed instruction instead of a parts list.
const partsScope = set => ALL_PARTS.every(p => set.has(p)) ? 'all' : set.size === 1 && set.has('coaches') ? 'coaches' : 'parts:' + ALL_PARTS.filter(p => set.has(p)).join(',');
const normScope = s => s.startsWith('parts:') ? partsScope(new Set(toParts(s))) : s;
// Full scans at :43 past these hours, Chicago time. The Mac Mini asks every 30s; the portal decides when a scheduled scan is due.
const SCHEDULE = { tz: 'America/Chicago', hours: [8, 11, 14, 17, 20, 23], minute: 43 };
function dueSlot(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: SCHEDULE.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]));
  const h = +p.hour, m = +p.minute, slotH = [...SCHEDULE.hours].reverse().find(x => x < h || (x === h && m >= SCHEDULE.minute));
  if (slotH === undefined || (h - slotH) * 60 + m - SCHEDULE.minute > 90) return null; // only within 90 min of the slot
  return `${p.year}-${p.month}-${p.day} ${String(slotH).padStart(2, '0')}:${SCHEDULE.minute}`;
}
app.get('/api/runner/pending', runnerAuth, (req, res) => res.json(getQueue().filter(a => a.status === 'pending')));
// The Mac Mini calls this every 30s. Returns the work to do now (or scope:null), marking those rescans as running.
app.post('/api/runner/claim', runnerAuth, (req, res) => {
  const rn = readJson(RUNNER, {}), q = getQueue(), now = new Date().toISOString();
  rn.lastPollAt = now; rn.host = String((req.body || {}).host || '').slice(0, 60);
  const ch = (req.body || {}).chrome; rn.chrome = typeof ch === 'boolean' ? ch : null; // null = an older runner that doesn't report it
  if (q.some(a => (a.type === 'rescan' || a.type === 'audit' || a.live) && a.status === 'running')) { writeJson(RUNNER, rn); return res.json({ scope: null, why: 'the Mac Mini is busy' }); }
  // Replies to send go first: they're quick. A waiting scan is picked up on the next poll, 30 seconds later.
  const sends = q.filter(a => a.type === 'discord_send' && a.live && a.status === 'pending').slice(0, 10);
  if (sends.length) {
    sends.forEach(a => { a.status = 'running'; a.startedAt = now; });
    writeJson(QUEUE, q); writeJson(RUNNER, rn);
    return res.json({ scope: null, sends: sends.map(a => ({ id: a.id, guildId: a.guildId, channelId: a.channelId, channel: a.channel, text: a.text })) });
  }
  let picked = q.filter(a => a.type === 'rescan' && a.status === 'pending');
  const slot = dueSlot();
  if (!picked.length && slot && rn.lastSlot !== slot) {
    const a = { id: crypto.randomUUID(), type: 'rescan', scope: 'all', source: 'schedule', status: 'pending', createdAt: now };
    q.push(a); picked = [a]; rn.lastSlot = slot;
  }
  if (!picked.length) {
    // The in-depth campaign audit: when asked for, or every 2 days (7 AM to 9 PM Chicago), once nothing else is waiting.
    let au = q.find(a => a.type === 'audit' && a.status === 'pending');
    const hr = +new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULE.tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date());
    if (!au && hr >= 7 && hr < 21 && (!rn.lastAuditAt || Date.now() - Date.parse(rn.lastAuditAt) > 48 * 36e5) && (!rn.lastAuditTry || Date.now() - Date.parse(rn.lastAuditTry) > 3 * 36e5)) {
      au = { id: crypto.randomUUID(), type: 'audit', source: 'schedule', status: 'pending', createdAt: now }; q.push(au); }
    if (au) { au.status = 'running'; au.startedAt = now; rn.lastAuditTry = now; writeJson(QUEUE, q); writeJson(RUNNER, rn); return res.json({ scope: null, audit: { id: au.id } }); }
    writeJson(RUNNER, rn); return res.json({ scope: null });
  }
  const scope = mergeScopes(picked.map(a => SCOPE_OK.test(String(a.scope || 'all')) ? String(a.scope || 'all') : 'all'));
  picked.forEach(a => { a.status = 'running'; a.startedAt = now; a.runScope = scope; });
  if (scope === 'all' && slot) rn.lastSlot = slot; // a manual full scan in the slot window counts as the scheduled one
  writeJson(QUEUE, q); writeJson(RUNNER, rn);
  res.json({ scope, ids: picked.map(a => a.id) });
});
app.post('/api/runner/finish', runnerAuth, (req, res) => {
  const b = req.body || {}, ids = new Set(Array.isArray(b.ids) ? b.ids : []), q = getQueue(), now = new Date().toISOString();
  const status = b.status === 'failed' ? 'failed' : 'done'; let n = 0;
  q.forEach(a => { if (ids.has(a.id) && a.status === 'running') { a.status = status; a.finishedAt = now; a.detail = String(b.detail || '').slice(0, 300); n++; } });
  writeJson(QUEUE, q); res.json({ ok: true, updated: n });
});
// A run that died without reporting back (Mac Mini asleep, crash): free it so the next request can run.
// Scans get 40 minutes, sends 15. A send that times out may still have gone out, so check the channel before retrying.
setInterval(() => {
  const q = getQueue(), now = Date.now(); let n = 0;
  q.forEach(a => { const lim = (a.live ? 15 : 40) * 60000; if (a.status === 'running' && a.startedAt && +new Date(a.startedAt) < now - lim) { a.status = 'failed'; a.finishedAt = new Date().toISOString(); a.detail = a.live ? 'no report from the Mac Mini after 15 minutes. Check the channel before sending again' : 'no report from the Mac Mini after 40 minutes'; n++; } });
  if (n) writeJson(QUEUE, q);
}, 60000);
app.post('/api/runner/actions/:id', runnerAuth, (req, res) => {
  const q = getQueue(), a = q.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  a.status = req.body.status === 'failed' ? 'failed' : 'done'; a.detail = String(req.body.detail || '').slice(0, 300); a.finishedAt = new Date().toISOString();
  writeJson(QUEUE, q);
  // A reply went out: Ty spoke last in that channel now, so it leaves the waiting list right away instead of at the next scan.
  if (a.type === 'discord_send' && a.status === 'done' && a.channelId) {
    const st = readJson(STATE, null), c = st && (st.campaigns || []).find(x => x.id === a.campaign);
    if (st && a.campaign === 'coaches' && st.coaches) { st.coaches.items = (st.coaches.items || []).filter(it => it.channelId !== a.channelId); writeJson(STATE, st); }
    if (c) { c.unanswered = (c.unanswered || []).filter(u => u.channelId !== a.channelId); c.tagged = (c.tagged || []).filter(u => u.channelId !== a.channelId);
      const ch = c.discord && c.discord.channels && c.discord.channels[a.channelId]; if (ch) ch.lastStaffMsgAt = a.finishedAt;
      writeJson(STATE, st); }
  }
  res.json(a);
});
// Full scan replaces state; partial scan ({campaigns:[one]}, {slack:[...]}) merges by campaign id.
app.post('/api/runner/ingest', runnerAuth, (req, res) => {
  const inc = req.body || {}, cur = readJson(STATE, { campaigns: [], slack: [], audits: [] });
  if (inc.full) { delete inc.full; writeJson(STATE, { ...inc, sample: false }); return res.json({ ok: true }); }
  for (const c of inc.campaigns || []) {
    const i = cur.campaigns.findIndex(x => x.id === c.id);
    if (i >= 0) cur.campaigns[i] = c; else cur.campaigns.push(c);
  }
  if (inc.slack) cur.slack = inc.slack;
  if (inc.audits) cur.audits = inc.audits;
  cur.generatedAt = inc.generatedAt || new Date().toISOString(); cur.sample = false;
  writeJson(STATE, cur); res.json({ ok: true });
});

// --- campaign audit (Mac Mini, every 2 days) ---
// Last calendar week (Monday to Sunday, Chicago) as dates and as [start, end) times.
const chiDate = t => new Date(t).toLocaleDateString('en-CA', { timeZone: SCHEDULE.tz });
const addDay = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const chiMidnight = d => { const h = +new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULE.tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(d + 'T12:00:00Z')); return Date.parse(d + 'T00:00:00Z') + (12 - h) * 36e5; };
function lastWeek(now = Date.now()) {
  const today = chiDate(now), end = addDay(today, -(((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7) + 1)), from = addDay(end, -6);
  return { from, to: end, t0: chiMidnight(from), t1: chiMidnight(addDay(end, 1)) };
}
const med = a => { a = a.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
// The audit period: last week (default), the last 7 days, or custom dates (within the last 31 days, Chicago dates).
function auditPeriod(r) {
  const now = Date.now(), today = chiDate(now), kind = r && ['7d', 'custom'].includes(r.kind) ? r.kind : 'lw', ok = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  if (kind === '7d') return { kind, from: chiDate(now - 7 * 864e5), to: today, t0: now - 7 * 864e5, t1: now, label: 'Last 7 days' };
  if (kind === 'custom' && ok(r.from) && ok(r.to)) {
    let [from, to] = r.from <= r.to ? [r.from, r.to] : [r.to, r.from]; if (from < addDay(today, -31)) from = addDay(today, -31); if (to > today) to = today;
    return { kind, from, to, t0: chiMidnight(from), t1: Math.min(now, chiMidnight(addDay(to, 1))), label: `${from} to ${to}` };
  }
  const w = lastWeek(now); return { kind: 'lw', ...w, label: 'Last week' };
}
const cleanRange = r => { const p = auditPeriod(r); return p.kind === 'custom' ? { kind: 'custom', from: p.from, to: p.to } : { kind: p.kind }; };
// What the audit writer reads: one compact block per campaign, last week's numbers and coach stats.
function auditDigest(range) {
  const st = readJson(STATE, { campaigns: [] }), w = auditPeriod(range), m0 = w.t0 / 6e4, m1 = w.t1 / 6e4, today = chiDate(Date.now());
  const days = []; for (let d = w.from; d <= w.to && d < today; d = addDay(d, 1)) days.push(d); // whole days only, for check-ins and daily posts
  // Per-creator numbers for the period: last week and the last 7 days come straight from LaunchPoint; custom dates add up the 30-day daily posts.
  const inP = (c, x) => { if (w.kind === 'lw') return x.rng && x.rng.w ? { posts: x.rng.w.posts, views: x.rng.w.v, cpm: x.rng.w.cpm } : { posts: null, views: null, cpm: null };
    if (w.kind === '7d') return { posts: x.posts7d ?? null, views: x.views7d ?? null, cpm: x.cpm ?? null };
    const d = x.d30, ds = c.days30 && d && c.days30.length === d.length ? c.days30 : null; return { posts: ds ? d.reduce((a, n, i) => a + (days.includes(ds[i]) ? n || 0 : 0), 0) : null, views: null, cpm: null }; };
  return { period: { kind: w.kind, label: w.label, from: w.from, to: w.to }, week: { from: w.from, to: w.to }, generatedAt: new Date().toISOString(), campaigns: (st.campaigns || []).map(c => {
    const chans = (c.discord || {}).channels || {}, stats = (c.discord || {}).coachStats || {}, coachOf = x => (chans[x.channelId] || {}).coach || 'Unassigned';
    const names = [...new Set([...Object.keys(stats), ...Object.values(chans).filter(v => !v.general).map(v => v.coach)])].filter(n => n && n !== 'Unassigned');
    const un = c.unanswered || [], cr = c.creators || [];
    return { id: c.id, name: c.name || c.id, yourRole: MINE.includes(c.id) ? 'Ty coaches these creators himself' : 'Ty oversees the coaches (Giga CM)', targetCpm: c.targetCpm || 4,
      totals: w.kind === 'lw' ? (c.lastWeek || null) : w.kind === '7d' ? { views: c.views7d ?? null, posts: (c.postsByDay || []).reduce((a, d) => a + (d.posts || 0), 0) || null, cpm: c.cpm ?? null, note: 'last 7 days; no comparison week' }
        : { posts: (c.creators || []).reduce((a, x) => a + (inP(c, x).posts || 0), 0) || null, views: null, cpm: null, note: 'custom dates: LaunchPoint views and CPM are not collected for custom ranges' },
      cpm7d: c.cpm ?? null, cpmAllTime: c.cpmAllTime ?? null, analyticsScannedAt: c.scannedAt || null, discordScannedAt: c.discordScannedAt || null,
      coaches: names.map(n => { const cs = stats[n] || {}, r = (cs.resp || []).filter(e => e[0] >= m0 && e[0] < m1).map(e => e[1]), ck = new Set(cs.checkins || []);
        const mine = cr.filter(x => coachOf(x) === n), wait = un.filter(u => u.coach === n);
        return { name: n, creators: mine.length || Object.values(chans).filter(v => v.coach === n && !v.general).length, repliesLastWeek: r.length, medianReplyMinutes: med(r), repliesOver15h: r.filter(x => x > 900).length,
          acknowledgmentsNeedingNoReply: (cs.acks || []).filter(x => x >= m0 && x < m1).length, checkinsHit: days.reduce((a, d) => a + ['a', 'b', 'c'].filter(k => ck.has(d + ':' + k)).length, 0),
          waitingNow: wait.length, waitingOver15hNow: wait.filter(u => u.waitingMin >= 900).length,
          checkinsPossible: days.length * 3, postsInPeriod: mine.reduce((a, x) => a + (inP(c, x).posts || 0), 0), viewsInPeriod: w.kind === 'custom' ? null : mine.reduce((a, x) => a + (inP(c, x).views || 0), 0) }; }),
      creators: cr.slice(0, 200).map(x => ({ name: x.name, coach: coachOf(x), daysOnCampaign: x.daysOnCampaign, everPosted: x.everPosted, lastPostAt: x.lastPostAt, expectedPerDay: x.expectedPerDay,
        postsInPeriod: inP(c, x).posts, viewsInPeriod: inP(c, x).views, cpmInPeriod: inP(c, x).cpm,
        posts7d: x.posts7d, last7Days: x.daily, cpm7d: x.cpm, cpmAllTime: x.cpmAllTime, inDiscord: x.inDiscord })),
      waitingOldest: un.slice().sort((a, b) => b.waitingMin - a.waitingMin).slice(0, 15).map(u => ({ channel: u.channel, coach: u.coach, hoursWaiting: Math.round(u.waitingMin / 60), message: String(u.message || '').slice(0, 160) })) };
  }) };
}
app.get('/api/runner/audit-input', runnerAuth, (req, res) => { const a = getQueue().find(x => x.id === req.query.id && x.type === 'audit'); res.json(auditDigest(a && a.range)); });
app.post('/api/runner/audit', runnerAuth, (req, res) => {
  const b = req.body || {}, q = getQueue(), a = q.find(x => x.id === b.id && x.type === 'audit'), now = new Date().toISOString();
  if (!b.audits || typeof b.audits !== 'object' || Array.isArray(b.audits)) return res.status(400).json({ error: 'audits must be an object keyed by campaign id' });
  const cur = readJson(AUDITS, {}), w = auditPeriod(a && a.range), clip = (v, n) => typeof v === 'string' ? v.slice(0, n) : Array.isArray(v) ? v.slice(0, 30).map(x => clip(x, n)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, clip(x, n)])) : v;
  let n = 0; for (const [cid, au] of Object.entries(b.audits)) if (CAMPS.includes(cid) && au && typeof au === 'object') { cur[cid] = { ...clip(au, 1500), week: `${w.from} to ${w.to}`, period: { kind: w.kind, from: w.from, to: w.to }, generatedAt: now }; n++; }
  writeJson(AUDITS, cur);
  if (a) { a.status = n ? 'done' : 'failed'; a.finishedAt = now; a.detail = n ? `${n} campaigns` : 'no campaigns in the audit'; writeJson(QUEUE, q); }
  if (n) { const rn = readJson(RUNNER, {}); rn.lastAuditAt = now; writeJson(RUNNER, rn); }
  res.json({ ok: !!n, saved: n });
});

// Browser-tab ingest: Claude in Chrome submits a plain form from the LaunchPoint/Discord/Slack tab
// (cross-origin form posts need no CORS). Fields: token, payload (JSON). Merges into current state.
function mergeState(inc) {
  let cur = readJson(STATE, null);
  if (!cur || cur.sample) cur = { campaigns: [], slack: [], dms: [], audits: [] };
  for (const c of inc.campaigns || []) {
    const i = cur.campaigns.findIndex(x => x.id === c.id);
    if (i >= 0) cur.campaigns[i] = { ...cur.campaigns[i], ...c }; else cur.campaigns.push(c);
  }
  for (const k of ['slack', 'dms', 'coaches', 'audits', 'eod', 'accountsCheckedAt']) if (inc[k] !== undefined) cur[k] = inc[k];
  for (const u of inc.channelUpdates || []) { // one channel rechecked: replace just that channel's waiting item
    const c = cur.campaigns.find(x => x.id === u.campaign); if (!c) continue;
    const known = ((c.discord || {}).channels || {})[u.channelId] || {};
    if (u.guildId && !c.guildId) c.guildId = u.guildId;
    c.unanswered = (c.unanswered || []).filter(x => x.channelId !== u.channelId);
    if (u.tagged !== undefined) { c.tagged = (c.tagged || []).filter(x => x.channelId !== u.channelId); if (u.tagged) c.tagged.push({ ...u.tagged, coach: known.coach || u.tagged.coach || '', channel: known.name ? '#' + known.name : u.tagged.channel }); }
    if (u.item) c.unanswered.push({ ...u.item, coach: known.coach || u.item.coach || '', channel: known.name ? '#' + known.name : u.item.channel });
    if (u.info && c.discord && c.discord.channels) c.discord.channels[u.channelId] = { ...known, ...u.info, name: known.name || u.info.name, cat: known.cat || u.info.cat, coach: known.coach || u.info.coach };
  }
  if (inc.scanStatus) cur.scanStatus = { ...(cur.scanStatus || {}), ...inc.scanStatus };
  if (inc.completeRescans) cur.scanStatus = { ...(cur.scanStatus || {}), running: false, finishedAt: new Date().toISOString() };
  cur.generatedAt = inc.generatedAt || new Date().toISOString(); cur.sample = false;
  writeJson(STATE, cur); return cur;
}
app.post('/api/runner/ingest-form', express.urlencoded({ extended: false, limit: '10mb' }), (req, res) => {
  if (!TOKEN || !same(String(req.body.token || ''), TOKEN)) return res.status(401).send('bad token');
  let inc; try { inc = JSON.parse(req.body.payload); } catch { return res.status(400).send('bad payload'); }
  const cur = mergeState(inc);
  res.send('ingest ok: ' + cur.campaigns.map(c => c.name + ' ' + (c.creators || []).length).join(', '));
});

// --- user API ---
app.use(userAuth);
// Messages you marked as read. The key names the exact message (channel + its latest message time + a hash of the text),
// so a new message from the same person gets a new key and shows up as unread again.
const READ = path.join(DATA_DIR, 'read.json');
const AUDITS = path.join(DATA_DIR, 'campaign-audits.json'); // in-depth weekly campaign audits written by the Mac Mini
app.get('/api/state', (req, res) => res.json({ ...getState(), queue: getQueue().slice(-200), live: true, runner: readJson(RUNNER, {}), read: readJson(READ, {}), schedule: SCHEDULE, campaignAudits: readJson(AUDITS, {}) }));
app.post('/api/read', (req, res) => {
  const b = req.body || {}, key = String(b.key || '');
  if (!key || key.length > 300) return res.status(400).json({ error: 'key required' });
  const r = readJson(READ, {}), cut = Date.now() - 45 * 864e5;
  for (const k of Object.keys(r)) if (+new Date(r[k].at) < cut) delete r[k]; // forget marks after 45 days
  if (b.read === false) delete r[key];
  else {
    r[key] = { at: new Date().toISOString(), label: String(b.label || '').slice(0, 120) };
    // For a creator waiting in a channel, the click counts as the reply: the portal times the response from the
    // creator's message (start) to this click, unless a coach answered sooner. last = their latest message at the time.
    const iso = v => { const t = Date.parse(v); return isNaN(t) ? null : new Date(t).toISOString(); };
    if (CAMPS.includes(b.c) && /^\d{15,22}$/.test(String(b.ch || '')) && iso(b.start))
      Object.assign(r[key], { c: b.c, ch: String(b.ch), coach: String(b.coach || '').slice(0, 80), start: iso(b.start), last: iso(b.last) });
  }
  writeJson(READ, r); res.json({ ok: true, read: r });
});
app.post('/api/actions', async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [req.body], q = getQueue(), out = [];
  for (const a of list) {
    if (!['discord_send', 'rescan', 'audit'].includes(a.type)) return res.status(400).json({ error: 'unknown action type' });
    // Sending is only for Ty's own campaigns (CapCut, YRI); every other campaign is oversight.
    if (a.type === 'discord_send' && (!SENDABLE.includes(a.campaign) || (!MINE.includes(a.campaign) && a.live !== true) || !a.channel || !String(a.text || '').trim()))
      return res.status(400).json({ error: 'discord_send needs campaign capcut, yri or coaches, a channel and text' });
    // live = really sent by the Mac Mini (replies). Without it the message only waits in the queue, as bulk messages always have.
    const live = a.type === 'discord_send' && a.live === true;
    if (live && (!/^\d{15,22}$/.test(String(a.channelId || '')) || !/^\d{15,22}$/.test(String(a.guildId || ''))))
      return res.status(400).json({ error: 'sending needs the Discord server and channel ids; rescan the campaign first' });
    if (live && String(a.text).length > 2000) return res.status(400).json({ error: 'Discord messages are limited to 2000 characters' });
    out.push({ id: crypto.randomUUID(), type: a.type, campaign: a.campaign || null, creator: a.creator || null,
      channel: a.channel || null, channelId: a.channelId || null, guildId: live ? String(a.guildId) : null, live: live || undefined,
      text: a.text || null, scope: a.scope || null, ...(a.type === 'audit' ? { range: cleanRange(a.range) } : {}), status: 'pending', createdAt: new Date().toISOString() });
  }
  // Rescans wait in the queue until the Mac Mini claims them (it asks every 30s). Only fixed scope formats are accepted,
  // and a scope that is already waiting is not queued twice.
  out.forEach(a => { if (a.type === 'rescan' && SCOPE_OK.test(String(a.scope || 'all'))) a.scope = normScope(String(a.scope || 'all')); });
  out.forEach(a => { const w = a.type === 'audit' && q.find(x => x.type === 'audit' && x.status === 'pending'); if (w) w.range = a.range; }); // a waiting audit takes the newest period asked for
  const keep = out.filter(a => a.type === 'audit' ? !q.some(x => x.type === 'audit' && (x.status === 'pending' || x.status === 'running')) : a.type !== 'rescan' || (SCOPE_OK.test(a.scope || 'all') && !q.some(x => x.type === 'rescan' && x.status === 'pending' && x.scope === (a.scope || 'all'))));
  keep.forEach(a => { if (a.type === 'rescan') a.scope = a.scope || 'all'; });
  writeJson(QUEUE, q.concat(keep));
  res.json({ queued: keep, runner: readJson(RUNNER, {}) });
});
// Clear queue. kind=messages: cancel every waiting message (optionally one campaign's) and drop finished ones from the list.
// kind=scans: cancel waiting rescans (finished scans stay, since they date the data). Anything running is left alone.
app.post('/api/actions/clear', (req, res) => {
  const b = req.body || {}, kind = b.kind === 'scans' ? 'scans' : 'messages', camp = b.campaign ? String(b.campaign) : null, now = new Date().toISOString();
  const mine = a => kind === 'scans' ? a.type === 'rescan' : a.type === 'discord_send' && (!camp || a.campaign === camp);
  let cancelled = 0, removed = 0;
  const q = getQueue().filter(a => {
    if (!mine(a) || a.status === 'running') return true;
    if (a.status === 'pending') { a.status = 'cancelled'; a.finishedAt = now; a.detail = 'cleared'; cancelled++; return kind === 'scans'; }
    if (kind === 'messages') { removed++; return false; }
    return true;
  });
  writeJson(QUEUE, q); res.json({ ok: true, cancelled, removed });
});
app.delete('/api/actions/:id', (req, res) => {
  const q = getQueue(), a = q.find(x => x.id === req.params.id);
  if (!a || a.status !== 'pending') return res.status(409).json({ error: 'not pending' });
  a.status = 'cancelled'; writeJson(QUEUE, q); res.json(a);
});
app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('gigacm-portal up'));
