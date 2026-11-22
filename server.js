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
// Messages queued before sending was turned on were never meant to go out: cancel them once so they can't be sent by surprise.
{ const q = getQueue(); let n = 0;
  q.forEach(a => { if (a.type === 'discord_send' && a.status === 'pending' && !a.live) { a.status = 'cancelled'; a.detail = 'queued before sending was turned on'; n++; } });
  if (n) writeJson(QUEUE, q); }
const PART = `((lp|dc)\\.(${CAMPS.join('|')})|dms|slack)`;
const SCOPE_OK = new RegExp(`^(all|${CAMPS.join('|')}|dms|slack|channel:(${CAMPS.join('|')}):\\d{15,22}|parts:${PART}(,${PART})*)$`);
const ALL_PARTS = [...CAMPS.map(c => 'lp.' + c), ...CAMPS.map(c => 'dc.' + c), 'dms', 'slack'];
function toParts(s) {
  if (s === 'all') return ALL_PARTS;
  if (CAMPS.includes(s)) return ['lp.' + s, 'dc.' + s];
  if (s === 'dms' || s === 'slack') return [s];
  if (s.startsWith('channel:')) return ['dc.' + s.split(':')[1]];
  return s.slice(6).split(',');
}
// One run covers every waiting request: a single scope runs as is, several are merged into the pieces they need.
function mergeScopes(list) {
  const u = [...new Set(list)];
  if (u.length === 1) return normScope(u[0]);
  return partsScope(new Set(u.flatMap(toParts)));
}
const partsScope = set => ALL_PARTS.every(p => set.has(p)) ? 'all' : 'parts:' + ALL_PARTS.filter(p => set.has(p)).join(',');
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
  if (q.some(a => (a.type === 'rescan' || a.live) && a.status === 'running')) { writeJson(RUNNER, rn); return res.json({ scope: null, why: 'the Mac Mini is busy' }); }
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
  if (!picked.length) { writeJson(RUNNER, rn); return res.json({ scope: null }); }
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
    if (c) { c.unanswered = (c.unanswered || []).filter(u => u.channelId !== a.channelId);
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

// Browser-tab ingest: Claude in Chrome submits a plain form from the LaunchPoint/Discord/Slack tab
// (cross-origin form posts need no CORS). Fields: token, payload (JSON). Merges into current state.
function mergeState(inc) {
  let cur = readJson(STATE, null);
  if (!cur || cur.sample) cur = { campaigns: [], slack: [], dms: [], audits: [] };
  for (const c of inc.campaigns || []) {
    const i = cur.campaigns.findIndex(x => x.id === c.id);
    if (i >= 0) cur.campaigns[i] = { ...cur.campaigns[i], ...c }; else cur.campaigns.push(c);
  }
  for (const k of ['slack', 'dms', 'audits', 'eod', 'accountsCheckedAt']) if (inc[k] !== undefined) cur[k] = inc[k];
  for (const u of inc.channelUpdates || []) { // one channel rechecked: replace just that channel's waiting item
    const c = cur.campaigns.find(x => x.id === u.campaign); if (!c) continue;
    const known = ((c.discord || {}).channels || {})[u.channelId] || {};
    if (u.guildId && !c.guildId) c.guildId = u.guildId;
    c.unanswered = (c.unanswered || []).filter(x => x.channelId !== u.channelId);
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
app.get('/api/state', (req, res) => res.json({ ...getState(), queue: getQueue().slice(-200), live: true, runner: readJson(RUNNER, {}), read: readJson(READ, {}) }));
app.post('/api/read', (req, res) => {
  const b = req.body || {}, key = String(b.key || '');
  if (!key || key.length > 300) return res.status(400).json({ error: 'key required' });
  const r = readJson(READ, {}), cut = Date.now() - 45 * 864e5;
  for (const k of Object.keys(r)) if (+new Date(r[k].at) < cut) delete r[k]; // forget marks after 45 days
  if (b.read === false) delete r[key]; else r[key] = { at: new Date().toISOString(), label: String(b.label || '').slice(0, 120) };
  writeJson(READ, r); res.json({ ok: true, read: r });
});
app.post('/api/actions', async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [req.body], q = getQueue(), out = [];
  for (const a of list) {
    if (!['discord_send', 'rescan'].includes(a.type)) return res.status(400).json({ error: 'unknown action type' });
    // Sending is only for Ty's own campaigns (CapCut, YRI); every other campaign is oversight.
    if (a.type === 'discord_send' && (!MINE.includes(a.campaign) || !a.channel || !String(a.text || '').trim()))
      return res.status(400).json({ error: 'discord_send needs campaign capcut or yri, a channel and text' });
    // live = really sent by the Mac Mini (replies). Without it the message only waits in the queue, as bulk messages always have.
    const live = a.type === 'discord_send' && a.live === true;
    if (live && (!/^\d{15,22}$/.test(String(a.channelId || '')) || !/^\d{15,22}$/.test(String(a.guildId || ''))))
      return res.status(400).json({ error: 'sending needs the Discord server and channel ids; rescan the campaign first' });
    if (live && String(a.text).length > 2000) return res.status(400).json({ error: 'Discord messages are limited to 2000 characters' });
    out.push({ id: crypto.randomUUID(), type: a.type, campaign: a.campaign || null, creator: a.creator || null,
      channel: a.channel || null, channelId: a.channelId || null, guildId: live ? String(a.guildId) : null, live: live || undefined,
      text: a.text || null, scope: a.scope || null, status: 'pending', createdAt: new Date().toISOString() });
  }
  // Rescans wait in the queue until the Mac Mini claims them (it asks every 30s). Only fixed scope formats are accepted,
  // and a scope that is already waiting is not queued twice.
  out.forEach(a => { if (a.type === 'rescan' && SCOPE_OK.test(String(a.scope || 'all'))) a.scope = normScope(String(a.scope || 'all')); });
  const keep = out.filter(a => a.type !== 'rescan' || (SCOPE_OK.test(a.scope || 'all') && !q.some(x => x.type === 'rescan' && x.status === 'pending' && x.scope === (a.scope || 'all'))));
  keep.forEach(a => { if (a.type === 'rescan') a.scope = a.scope || 'all'; });
  writeJson(QUEUE, q.concat(keep));
  res.json({ queued: keep, runner: readJson(RUNNER, {}) });
});
app.delete('/api/actions/:id', (req, res) => {
  const q = getQueue(), a = q.find(x => x.id === req.params.id);
  if (!a || a.status !== 'pending') return res.status(409).json({ error: 'not pending' });
  a.status = 'cancelled'; writeJson(QUEUE, q); res.json(a);
});
app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('gigacm-portal up'));
