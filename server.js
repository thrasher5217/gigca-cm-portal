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
app.get('/api/runner/pending', runnerAuth, (req, res) => res.json(getQueue().filter(a => a.status === 'pending')));
app.post('/api/runner/actions/:id', runnerAuth, (req, res) => {
  const q = getQueue(), a = q.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  a.status = req.body.status || 'done'; a.detail = req.body.detail || ''; a.finishedAt = new Date().toISOString();
  writeJson(QUEUE, q); res.json(a);
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
  if (inc.completeRescans) { // a full scan finished: clear pending refresh requests
    const q = getQueue(); let n = 0;
    q.forEach(a => { if (a.type === 'rescan' && a.status === 'pending') { a.status = 'done'; a.finishedAt = new Date().toISOString(); n++; } });
    if (n) writeJson(QUEUE, q);
    cur.scanStatus = { ...(cur.scanStatus || {}), running: false, finishedAt: new Date().toISOString() };
  }
  cur.generatedAt = inc.generatedAt || new Date().toISOString(); cur.sample = false;
  writeJson(STATE, cur); return cur;
}
app.post('/api/runner/ingest-form', express.urlencoded({ extended: false, limit: '10mb' }), (req, res) => {
  if (!TOKEN || !same(String(req.body.token || ''), TOKEN)) return res.status(401).send('bad token');
  let inc; try { inc = JSON.parse(req.body.payload); } catch { return res.status(400).send('bad payload'); }
  const cur = mergeState(inc);
  res.send('ingest ok: ' + cur.campaigns.map(c => c.name + ' ' + (c.creators || []).length).join(', '));
});

// Wake Claude on demand: when a button queues work, call the scheduled task's API trigger so a scan/drain
// starts right away instead of waiting for the next scheduled run. Set FIRE_URL and FIRE_TOKEN in Railway.
const FIRE_URL = process.env.FIRE_URL || '', FIRE_TOKEN = process.env.FIRE_TOKEN || '';
const FIRE = path.join(DATA_DIR, 'fire.json');
async function fireScan(reason, scoped, scope) {
  if (!FIRE_URL || !FIRE_TOKEN) return { fired: false, why: 'not configured' };
  const last = readJson(FIRE, {});
  const gap = scoped ? 60000 : 10 * 60000;
  if (last.at && Date.now() - new Date(last.at) < gap && last.ok) return { fired: false, why: 'a run was started ' + (scoped ? 'less than a minute ago' : 'less than 10 minutes ago') };
  try {
    const r = await fetch(FIRE_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + FIRE_TOKEN, 'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: reason }) });
    const body = await r.json().catch(() => ({}));
    writeJson(FIRE, { at: new Date().toISOString(), ok: r.ok, status: r.status, scope: scope || 'all', session: body.claude_code_session_url || null });
    return { fired: r.ok, why: r.ok ? 'started' : 'fire endpoint returned ' + r.status };
  } catch (e) { writeJson(FIRE, { at: new Date().toISOString(), ok: false, status: String(e) }); return { fired: false, why: String(e) }; }
}

// --- user API ---
app.use(userAuth);
app.get('/api/state', (req, res) => res.json({ ...getState(), queue: getQueue().slice(-200), live: true, fire: { configured: !!(FIRE_URL && FIRE_TOKEN), last: readJson(FIRE, null) } }));
app.post('/api/actions', async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [req.body], q = getQueue(), out = [];
  for (const a of list) {
    if (!['discord_send', 'rescan'].includes(a.type)) return res.status(400).json({ error: 'unknown action type' });
    // Sending is CapCut-only by design; every other campaign is oversight.
    if (a.type === 'discord_send' && (a.campaign !== 'capcut' || !a.channel || !String(a.text || '').trim()))
      return res.status(400).json({ error: 'discord_send needs campaign=capcut, channel and text' });
    out.push({ id: crypto.randomUUID(), type: a.type, campaign: a.campaign || null, creator: a.creator || null,
      channel: a.channel || null, channelId: a.channelId || null, text: a.text || null, scope: a.scope || null, status: 'pending', createdAt: new Date().toISOString() });
  }
  writeJson(QUEUE, q.concat(out));
  // Only fixed scope formats are ever passed to the task: all | <campaign> | channel:<campaign>:<channelId> | dms | slack
  const rs = out.filter(a => a.type === 'rescan').map(a => String(a.scope || 'all')), ok = /^(all|capcut|artlist|creatify|melius|dms|slack|channel:(capcut|artlist|creatify|melius):\d{15,22})$/;
  const scope = rs.length === 1 && ok.test(rs[0]) ? rs[0] : 'all';
  const fire = rs.length ? await fireScan('Manual refresh requested from the GigaCM portal. SCOPE=' + scope, scope !== 'all', scope) : null;
  res.json({ queued: out, fire });
});
app.delete('/api/actions/:id', (req, res) => {
  const q = getQueue(), a = q.find(x => x.id === req.params.id);
  if (!a || a.status !== 'pending') return res.status(409).json({ error: 'not pending' });
  a.status = 'cancelled'; writeJson(QUEUE, q); res.json(a);
});
app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('gigacm-portal up'));
