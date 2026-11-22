// Discord scan. Run in a discord.com tab (Claude in Chrome, Mac Mini). Read-only: opens channels and reads the DOM.
// Optional scope, set before running: window.__discScope = {mode:'all'} (default) | {mode:'campaign', key:'capcut'} |
//   {mode:'channel', key:'capcut', channelId:'123'} | {mode:'dms'} | {mode:'parts', keys:['capcut','melius'], dms:true}.
// Starts in the background; poll window.__disc.progress until window.__disc.done is true.
// Then read window.__disc.mine (Ty's CapCut creators waiting), and call window.discSubmit(drafts, acks, TOKEN):
//   drafts = {"#channel-name": "reply text"}, acks = ["#channel-name", ...] (messages that need no reply).
(() => {
  const GUILDS = [
    ['capcut', '1569756845319520387', /Creators/i], ['artlist', '1570552478817067038', /^Team /i],
    ['creatify', '1562201369811877949', /Creators/i], ['melius', '1559661121588306052', /Creators/i]];
  const COACH = { 'Ty': 'Ty McGuire', 'Amrin': 'Amrin Jahan', 'Dakota': 'Dakota Crane', 'Team Aristotle': 'Joseph Ferrall', 'Team Da Vinci': 'Razeen Khan',
    'Team Van Gogh': 'Ryan Soto', 'Mat': 'Mathew Wu', 'Eric': 'Eric Liang', 'Grace': 'Grace Goldstein', 'Anna': 'Anna Florek', 'Baraa': 'Baraa Alrash' };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const go = p => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); };
  const SC = window.__discScope || { mode: 'all' };
  const STAFF = /^(Ty M|Amrin|Dakota|Reece|yan\b|Razeen|Joseph|matwu|Eric|Grace|baroobi|Anna)/i; // used when only one channel is read
  const D = window.__disc = { done: false, progress: 'starting', errors: [], campaigns: [], dms: null, mine: [], channelUpdates: null, scope: SC };

  async function sidebar() {
    const sc = document.querySelector('#channels'); if (!sc) throw new Error('channel list not found');
    const seen = new Map(); sc.scrollTop = 0; await sleep(400); let last = -1, stall = 0;
    for (let i = 0; i < 200; i++) {
      for (const el of sc.querySelectorAll('[data-list-item-id^="channels___"]')) {
        const id = el.getAttribute('data-list-item-id').slice(11); if (!/^\d+$/.test(id) || seen.has(id)) continue;
        seen.set(id, { id, name: (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 80), isCat: !el.getAttribute('href'), top: el.getBoundingClientRect().top + sc.scrollTop });
      }
      sc.scrollTop += Math.floor(sc.clientHeight * 0.8); await sleep(250);
      if (sc.scrollTop === last) { if (++stall > 2) break; } else stall = 0; last = sc.scrollTop;
    }
    const arr = [...seen.values()].sort((a, b) => a.top - b.top); let cur = null;
    for (const x of arr) { if (x.isCat) cur = x; else x.catName = cur ? cur.name.replace(/ \(category\)$/, '') : null; }
    return arr;
  }
  async function read(path, c) {
    go(path); let lis = [], prev = -1, stable = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(150); lis = [...document.querySelectorAll(`li[id^="chat-messages-${c}-"]`)];
      if (i > 12 && !lis.length && location.pathname.endsWith(c) && document.querySelector('ol[data-list-id="chat-messages"]')) break;
      if (lis.length && lis.length === prev) { if (++stable >= 3) break; } else stable = 0; prev = lis.length;
    }
    let author = null; const out = [];
    for (const li of lis) {
      const u = [...li.querySelectorAll('[id^="message-username-"]')].find(e => !e.closest('[id^="message-reply-context-"]'));
      if (u) author = u.innerText.trim();
      const tm = li.querySelector('time[datetime]');
      const ct = [...li.querySelectorAll('[id^="message-content-"]')].find(e => !e.closest('[id^="message-reply-context-"]'));
      const acc = li.querySelector('[id^="message-accessories-"]'), txt = (ct ? ct.innerText : '').trim();
      if (author && tm) out.push({ id: li.id.split('-').pop(), a: author, t: tm.getAttribute('datetime'), x: txt.slice(0, 400) || (acc && acc.children.length ? '[attachment]' : ''), b: !!li.querySelector('[class*="botTag"],[class*="appTag"]') });
    }
    return out;
  }
  const clean = a => a.split('\n')[0].replace(/,\s*$/, '').trim(), isBot = m => m.b || /\bAPP\b/.test(m.a);
  // Coach check-in windows (SOP: 3 a day, the last before 10 PM ET): start 5am-noon, mid noon-5pm, end 5-10pm ET.
  const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const win = t => { const p = Object.fromEntries(ET.formatToParts(new Date(t)).map(x => [x.type, x.value])), h = +p.hour; const w = h >= 5 && h < 12 ? 'a' : h >= 12 && h < 17 ? 'b' : h >= 17 && h < 22 ? 'c' : null; return w && `${p.year}-${p.month}-${p.day}:${w}`; };
  const WARM = /warm(ing)?[\s-]?up|warming|warmup|warm(ed)? (my|the|up)?\s*(acc|account|feed|page)/i;
  const ACK = /^(ok(ay)?|k+|bet|thanks?( you)?|thank u|ty|got it|sounds good|will do|perfect|awesome|cool|great|yes+|yep|yup|👍|🙏|❤️|🔥|lol|np|done|on it)[\s!.,a-z👍🙏❤️🔥]*$/i;
  function analyze(chans, staffRe) {
    const seenIn = {}; chans.forEach(c => new Set(c.msgs.filter(m => !isBot(m)).map(m => clean(m.a))).forEach(a => seenIn[a] = (seenIn[a] || 0) + 1));
    const staff = new Set(Object.keys(seenIn).filter(a => seenIn[a] >= 3)), now = Date.now(), wk = now - 7 * 864e5, mo = now - 31 * 864e5, un = [], channels = {}, rt = {}, wins = {}, resp = {};
    for (const c of chans) {
      const key = c.cat.replace(/['’]s Creators.*$/i, '').trim(), coach = COACH[key] || key, general = /announcement|general/i.test(c.name);
      const hs = c.msgs.filter(m => !isBot(m)).map(m => ({ id: m.id, a: clean(m.a), t: +new Date(m.t), x: m.x, st: staffRe ? staffRe.test(clean(m.a)) : staff.has(clean(m.a)) })), runs = [];
      for (const m of hs) { const L = runs[runs.length - 1]; if (L && L.st === m.st) { L.x += '\n' + m.x; L.end = m.t; L.n++; } else runs.push({ st: m.st, a: m.a, t: m.t, end: m.t, x: m.x, n: 1, id: m.id }); }
      hs.forEach(m => { if (m.st && m.t > mo) { const w = win(m.t); if (w) (wins[coach] = wins[coach] || new Set()).add(w); } });
      if (general) { channels[c.id] = { name: c.name, cat: c.cat, coach, general: true }; continue; }
      let asked = 0, answered = 0;
      runs.forEach((r, i) => { const nx = runs[i + 1]; if (!r.st && nx && r.t > mo) (resp[coach] = resp[coach] || []).push([Math.round(r.t / 6e4), Math.round((nx.t - r.t) / 6e4)]); if (!r.st && nx && r.t > wk) (rt[coach] = rt[coach] || []).push((nx.t - r.t) / 6e4); if (r.st) { if (nx) { asked++; answered++; } else if (now - r.end > 864e5) asked++; } });
      const L = runs[runs.length - 1], lastC = [...runs].reverse().find(r => !r.st), lastS = [...runs].reverse().find(r => r.st), firstS = hs.find(m => m.st);
      const warm = [...hs].reverse().find(m => !m.st && WARM.test(m.x)), iso = t => t ? new Date(t).toISOString() : null;
      channels[c.id] = { name: c.name, cat: c.cat, coach, msgs: hs.length, responseRate: asked ? Math.round(answered / asked * 100) : null,
        lastCreatorMsgAt: iso(lastC && lastC.end), lastStaffMsgAt: iso(lastS && lastS.end), firstStaffAt: iso(firstS && firstS.t), oldestMsgAt: iso(hs[0] && hs[0].t),
        warmAt: iso(warm && warm.t), warmText: warm ? warm.x.slice(0, 160) : null };
      if (L && !L.st) un.push({ id: c.id + '-' + L.t, channelId: c.id, messageId: L.id || null, channel: '#' + c.name, coach, creator: L.a, waitingMin: Math.round((now - L.t) / 6e4), message: L.x.slice(0, 600),
        context: (runs[runs.length - 2] || { x: '' }).x.slice(-300), ack: L.n === 1 && L.x.length < 45 && !L.x.includes('?') && ACK.test(L.x.trim()) });
    }
    const med = a => { a = a.slice().sort((x, y) => x - y); return a.length ? Math.round(a[Math.floor(a.length / 2)]) : null; }, coachStats = {};
    Object.keys(rt).forEach(k => coachStats[k] = { medianResponseMin: med(rt[k]), replies7d: rt[k].length, over15h7d: rt[k].filter(m => m > 900).length });
    // resp = every creator message -> next staff reply in the last 31 days, as [minute timestamp, minutes to reply], for any timeframe
    Object.keys(resp).forEach(k => (coachStats[k] = coachStats[k] || { medianResponseMin: null, replies7d: 0, over15h7d: 0 }).resp = resp[k].sort((a, b) => a[0] - b[0]).slice(-3000));
    Object.keys(wins).forEach(k => (coachStats[k] = coachStats[k] || { medianResponseMin: null, replies7d: 0, over15h7d: 0 }).checkins = [...wins[k]].sort());
    return { coachStats, channels, unanswered: un };
  }
  (async () => {
    if (SC.mode === 'channel') {
      try {
        const G = GUILDS.find(x => x[0] === SC.key); if (!G || !/^\d+$/.test(String(SC.channelId))) throw new Error('bad channel scope');
        go(`/channels/${G[1]}`); await sleep(3000);
        const msgs = await read(`/channels/${G[1]}/${SC.channelId}`, SC.channelId), name = ((document.title.match(/#([^ |]+)/) || [])[1] || 'channel');
        const r = analyze([{ id: SC.channelId, name, cat: '', msgs }], STAFF);
        D.channelUpdates = [{ campaign: SC.key, guildId: G[1], channelId: SC.channelId, item: r.unanswered[0] || null, info: r.channels[SC.channelId] || null }];
      } catch (e) { D.errors.push('channel: ' + e); }
    }
    for (const [key, g, re] of GUILDS.filter(x => SC.mode === 'all' || (SC.mode === 'campaign' && x[0] === SC.key) || (SC.mode === 'parts' && (SC.keys || []).includes(x[0])))) {
      try {
        go(`/channels/${g}`); await sleep(3500);
        const sb = await sidebar(), list = sb.filter(x => !x.isCat && x.catName && re.test(x.catName) && !/voice channel|stage channel/i.test(x.name)), chans = [];
        for (const ch of list) { D.progress = `${key} ${chans.length}/${list.length}`; chans.push({ id: ch.id, name: ch.name.replace(/ \(.*$/, '').replace(/^unread, /, ''), cat: ch.catName, msgs: await read(`/channels/${g}/${ch.id}`, ch.id).catch(() => []) }); }
        const r = analyze(chans);
        D.campaigns.push({ id: key, guildId: g, discordScannedAt: new Date().toISOString(), discord: { coachStats: r.coachStats, channels: r.channels }, unanswered: r.unanswered });
      } catch (e) { D.errors.push(key + ': ' + e); }
    }
    if (SC.mode === 'all' || SC.mode === 'dms' || (SC.mode === 'parts' && SC.dms)) try {
      D.progress = 'dms'; go('/channels/@me'); await sleep(3000);
      const links = [...document.querySelectorAll('a[href^="/channels/@me/"]')].map(a => ({ id: a.getAttribute('href').split('/').pop(), label: (a.getAttribute('aria-label') || a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80) })).filter(x => /^\d+$/.test(x.id)).slice(0, 20);
      const res = []; for (const l of links) res.push({ ...l, ms: (await read(`/channels/@me/${l.id}`, l.id).catch(() => [])).map(m => ({ id: m.id, a: clean(m.a), t: m.t, x: m.x })).slice(-8) });
      const cnt = {}; res.forEach(r => new Set(r.ms.map(m => m.a)).forEach(a => cnt[a] = (cnt[a] || 0) + 1));
      const me = (Object.entries(cnt).sort((a, b) => b[1] - a[1])[0] || [''])[0], now = Date.now();
      D.dms = res.map(r => { const L = r.ms[r.ms.length - 1]; if (!L || L.a === me) return null; let i = r.ms.length - 1; while (i > 0 && r.ms[i - 1].a !== me) i--; const run = r.ms.slice(i);
        return { id: r.id, messageId: run[0].id || null, from: r.label.replace(/^unread, /, '').replace(/ \((direct message|group message)\).*$/, ''), channel: 'Discord DM', unread: /^unread/.test(r.label), waitingMin: Math.round((now - new Date(run[0].t)) / 6e4), text: run.map(m => m.x).join('\n').slice(0, 500) }; }).filter(x => x && x.waitingMin < 14 * 1440);
    } catch (e) { D.errors.push('dms: ' + e); }
    const cc = D.campaigns.find(c => c.id === 'capcut'), one = D.channelUpdates && SC.key === 'capcut' && D.channelUpdates[0] && D.channelUpdates[0].item;
    D.mine = one ? [one].filter(u => !u.ack).map(u => `${u.channel} | ${Math.round(u.waitingMin / 60)}h | COACH SAID: ${u.context.replace(/\n/g, ' ').slice(-160)} | CREATOR: ${u.message.replace(/\n/g, ' / ').slice(0, 360)}`) : cc ? cc.unanswered.filter(u => !u.ack && /^Ty\b/.test(u.coach)).sort((a, b) => b.waitingMin - a.waitingMin).map(u => `${u.channel} | ${Math.round(u.waitingMin / 60)}h | COACH SAID: ${u.context.replace(/\n/g, ' ').slice(-160)} | CREATOR: ${u.message.replace(/\n/g, ' / ').slice(0, 360)}`) : [];
    D.progress = 'done'; D.done = true;
  })();
  window.discSubmit = (drafts, acks, token) => {
    const D = window.__disc;
    for (const c of D.campaigns) { c.unanswered.forEach(u => { if ((acks || []).includes(u.channel)) u.ack = true; if (c.id === 'capcut' && drafts && drafts[u.channel]) u.draft = drafts[u.channel]; }); c.unanswered = c.unanswered.filter(u => !u.ack).map(({ ack, ...u }) => u); }
    for (const cu of D.channelUpdates || []) if (cu.item) { if ((acks || []).includes(cu.item.channel)) cu.item = null; else { if (drafts && drafts[cu.item.channel]) cu.item.draft = drafts[cu.item.channel]; delete cu.item.ack; } }
    const payload = { campaigns: D.campaigns, ...(D.dms ? { dms: D.dms } : {}), ...(D.channelUpdates ? { channelUpdates: D.channelUpdates } : {}), ...(D.scope.mode !== 'all' ? { completeRescans: true } : {}), scanStatus: { discord: D.errors.length ? 'partial: ' + D.errors.join('; ') : 'ok', discordAt: new Date().toISOString() } };
    const f = document.createElement('form'); f.method = 'POST'; f.action = 'https://gigca-cm-portal-production.up.railway.app/api/runner/ingest-form'; f.style.display = 'none';
    for (const [k, v] of [['token', token], ['payload', JSON.stringify(payload)]]) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); }
    document.body.appendChild(f); setTimeout(() => f.submit(), 300); return 'submitting ' + JSON.stringify(payload).length + ' bytes';
  };
})();
