// Discord scan. Run in a discord.com tab (Claude in Chrome, Mac Mini). Read-only: opens channels and reads the DOM.
// Optional scope, set before running: window.__discScope = {mode:'all'} (default) | {mode:'campaign', key:'capcut'} |
//   {mode:'channel', key:'capcut', channelId:'123'} | {mode:'dms'} | {mode:'coaches'} | {mode:'parts', keys:['capcut','melius'], dms:true, coaches:true}.
// Starts in the background; poll window.__disc.progress until window.__disc.done is true.
// Then read window.__disc.mine (Ty's CapCut creators waiting), and call window.discSubmit(drafts, acks, TOKEN):
//   drafts = {"#channel-name": "reply text"}, acks = ["#channel-name", ...] (messages that need no reply).
(() => {
  const GUILDS = [
    ['capcut', '1569756845319520387', /Creators/i], ['artlist', '1570552478817067038', /^Team /i],
    ['creatify', '1562201369811877949', /Creators/i], ['melius', '1559661121588306052', /Creators/i],
    // YRI lives in the shared UGC University server: no fixed id, found by server name; only the Team Ty category (Ty's creators).
    ['yri', null, /Team Ty\b/i, { server: /UGC\s*Univ/i, section: /\bYRI\b/i, coach: 'Ty McGuire', name: 'YRI', role: 'cm' }]];
  const MINE = ['capcut', 'yri']; // Ty is the coach: drafts are written for these
  // Find a server id from the server list on the left by its name.
  async function guildOf(G) {
    if (G[1]) return G[1];
    for (let i = 0; i < 20; i++) {
      const el = [...document.querySelectorAll('[data-list-item-id^="guildsnav___"]')].find(e => G[3].server.test((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '')));
      const id = el && el.getAttribute('data-list-item-id').slice(12); if (id && /^\d+$/.test(id)) return id;
      await sleep(300);
    }
    throw new Error('server not found in the Discord server list (is it inside a closed folder?)');
  }
  // Discord display names that don't start with the coach's first name (check-ins only count the coach's own messages)
  const ALIAS = { 'Mathew Wu': ['matwu'], 'Baraa Alrash': ['baroobi'], 'Ty McGuire': ['Ty M', 'tym0559'] };
  const isCoach = (coach, a) => { a = String(a || '').toLowerCase(); const f = String(coach || '').split(' ')[0].toLowerCase();
    return !!a && ((f.length > 1 && (a === f || a.startsWith(f + ' ') || a === String(coach).toLowerCase())) || (ALIAS[coach] || []).some(x => a === x.toLowerCase() || a.startsWith(x.toLowerCase()))); };
  const COACH = { 'Ty': 'Ty McGuire', 'Amrin': 'Amrin Jahan', 'Dakota': 'Dakota Crane', 'Team Aristotle': 'Joseph Ferrall', 'Team Da Vinci': 'Razeen Khan',
    'Team Van Gogh': 'Ryan Soto', 'Mat': 'Mathew Wu', 'Eric': 'Eric Liang', 'Grace': 'Grace Goldstein', 'Anna': 'Anna Florek', 'Baraa': 'Baraa Alrash' };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const dkey = (cid, ch) => (cid === 'capcut' ? '' : cid + ' ') + ch; // draft/ack key
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
  // Read a channel's latest messages. With needMore (a test on what's loaded so far), keep scrolling up toward the start of
  // the channel while it says more is needed, e.g. to find a new creator's real first coach message. read.top tells whether
  // the start of the channel was reached.
  async function read(path, c, needMore) {
    go(path); let lis = [], prev = -1, stable = 0; read.top = null;
    for (let i = 0; i < 40; i++) {
      await sleep(150); lis = [...document.querySelectorAll(`li[id^="chat-messages-${c}-"]`)];
      if (i > 12 && !lis.length && location.pathname.endsWith(c) && document.querySelector('ol[data-list-id="chat-messages"]')) break;
      if (lis.length && lis.length === prev) { if (++stable >= 3) break; } else stable = 0; prev = lis.length;
    }
    let out = parse(lis);
    if (needMore && out.length && needMore(out)) {
      const all = new Map(out.map(m => [m.id, m])), ol = document.querySelector('ol[data-list-id="chat-messages"]');
      const sc = ol && (ol.closest('[class*="scroller"]') || (ol.parentElement && ol.parentElement.parentElement)); let same = 0; read.top = false;
      for (let i = 0; i < 40 && sc; i++) {
        if (sc.scrollTop === 0) { sc.scrollTop = 40; await sleep(80); } // already at the top: nudge so the jump fires a scroll
        sc.scrollTop = 0; await sleep(900);
        const n = all.size; parse([...document.querySelectorAll(`li[id^="chat-messages-${c}-"]`)]).forEach(m => all.set(m.id, m)); // collect as we go: Discord unloads the bottom
        const sorted = [...all.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
        if (!needMore(sorted)) { read.top = true; break; }
        if (all.size === n) { if (++same >= 3) { read.top = true; break; } } else same = 0; // nothing older loads: this is the start
      }
      out = [...all.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
    } else if (needMore) read.top = true;
    return out;
  }
  function parse(lis) {
    let author = null; const out = [];
    for (const li of lis) {
      const u = [...li.querySelectorAll('[id^="message-username-"]')].find(e => !e.closest('[id^="message-reply-context-"]'));
      if (u) author = u.innerText.trim();
      const tm = li.querySelector('time[datetime]');
      const ct = [...li.querySelectorAll('[id^="message-content-"]')].find(e => !e.closest('[id^="message-reply-context-"]'));
      const acc = li.querySelector('[id^="message-accessories-"]'), txt = (ct ? ct.innerText : '').trim();
      const rc = li.querySelector('[id^="message-reply-context-"]'), ru = rc && rc.querySelector('[id^="message-username-"],[class*="username"]');
      if (author && tm) out.push({ id: li.id.split('-').pop(), a: author, t: tm.getAttribute('datetime'), x: txt.slice(0, 400) || (acc && acc.children.length ? '[attachment]' : ''), b: !!li.querySelector('[class*="botTag"],[class*="appTag"]'), r: ru ? ru.innerText.replace(/^@/, '').trim() : null,
        // me = Ty (the logged-in account) reacted to this message: Discord marks his own reactions as pressed
        me: !!li.querySelector('[id^="message-reactions-"] [aria-pressed="true"], [class*="reactionMe"], [class*="reaction_"][class*="selected"]') });
    }
    return out;
  }
  // Channels made in the last 10 days whose loaded messages don't reach back to their creation: scroll up for the first messages.
  const born = id => Number((BigInt(id) >> 22n) + 1420070400000n);
  const needStart = id => { const b = born(id); if (Date.now() - b > 10 * 864e5) return null; return ms => { const o = ms.find(m => m.t); return !!o && +new Date(o.t) - b > 2 * 36e5; }; };
  const clean = a => a.split('\n')[0].replace(/,\s*$/, '').trim(), isBot = m => m.b || /\bAPP\b/.test(m.a);
  // Coach check-in windows, ET: start 5am-noon, mid noon-5pm, end 5pm-2am. Midnight to 2am counts as the previous day's end check-in.
  const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const win = t => { const p = Object.fromEntries(ET.formatToParts(new Date(t)).map(x => [x.type, x.value])), h = +p.hour; const w = h >= 5 && h < 12 ? 'a' : h >= 12 && h < 17 ? 'b' : h >= 17 || h < 2 ? 'c' : null; if (!w) return null;
    const d = h < 2 ? new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - 864e5).toISOString().slice(0, 10) : `${p.year}-${p.month}-${p.day}`; return `${d}:${w}`; };
  const WARM = /warm(ing)?[\s-]?up|warming|warmup|warm(ed)? (my|the|up)?\s*(acc|account|feed|page)/i;
  const ACK = /^(ok(ay)?|k+|bet|thanks?( you)?|thank u|ty|got it|sounds good|will do|perfect|awesome|cool|great|yes+|yep|yup|👍|🙏|❤️|🔥|lol|np|done|on it)[\s!.,a-z👍🙏❤️🔥]*$/i;
  // A question or a problem always needs a reply, even if it starts with "ok" or "thanks".
  const QUESTION = /\?|\b(what|whats|what's|when|where|why|how|who|which|wdym|hbu)\b|^\s*(can|could|should|shall|do|does|did|is|are|am|was|were|would|have|has|any|anyone)\b/im;
  const PROBLEM = /\b(help|need|issue|problem|wrong|error|stuck|confused|can'?t|won'?t|not|banned|flagged|shadow ?banned|pay|paid|payment|money|invoice|link)\b/i;
  // No reply needed: a short acknowledgment ("ok", "thanks!", "🔥") with no question or problem in it. Attachments need a look.
  const noReply = x => { x = String(x || '').trim(); return !x || (x.length <= 60 && x !== '[attachment]' && ACK.test(x) && !QUESTION.test(x) && !PROBLEM.test(x)); };
  // When the reply clock starts for a run of creator messages: at the first message that needs a reply (null = none does).
  // Ty reacting to a message counts as acknowledging it and everything before it in the run; only later messages can start it.
  const clockStart = r => { let k = -1; r.ms.forEach((m, i) => { if (m.me) k = i; }); const m = r.ms.slice(k + 1).find(m => !noReply(m.x)); return m ? m.t : null; };
  const COACHES = { id: '1552479657566142566', own: '1567608337720152285',
    cats: /capcut|artlist|creatify|melius|yri|ugc op|\bops\b|admin/i,
    skip: /polymarket/i, // Ty no longer oversees Polymarket: never read its categories (even ones like "Polymarket Admin")
    skipCh: /hotline/i, skipIds: ['1555005292360630333'], // the Launchpoint Hotline channel: never notify Ty about it
    lead: /^(Rich Lin|Andrew Shin|Henry Pan|RichBot|Robo-?Pan|benlemwomper|andrewcshin|henrypandisc)/i };
  const isTyName = a => /^Ty\b/i.test(a || '') || /^tym0559/i.test(a || '');
  const MENTION = /@Ty\b|@tym0559|@UGC Op/i, ALLPING = /@everyone|@here/i;
  // One item per channel, or null when nothing there needs Ty. Ty replying in the channel clears it.
  function coachItem(ch, name, ms, now) {
    let lastTy = -1; ms.forEach((m, i) => { if (isTyName(m.a) || m.me) lastTy = i; }); // a reaction from Ty counts as his answer
    const after = ms.slice(lastTy + 1).filter(m => now - m.t < 7 * 864e5); if (!after.length) return null;
    const own = ch.id === COACHES.own || /ty-?mcguire/i.test(name), announce = /announce/i.test(name);
    const kindOf = m => MENTION.test(m.x) || isTyName(m.r) ? 'mention' : own && !noReply(m.x) ? 'your channel'
      : COACHES.lead.test(m.a) && (ALLPING.test(m.x) || QUESTION.test(m.x) || PROBLEM.test(m.x)) ? 'leadership' : null;
    let first = after.findIndex(kindOf), kind = first >= 0 ? kindOf(after[first]) : null;
    if (first < 0 && !announce) { // a question nobody has answered yet: the last run in the channel, waiting an hour or more
      let j = ms.length - 1; while (j > 0 && ms[j - 1].a === ms[j].a) j--;
      const run = ms.slice(j);
      if (j > lastTy && run.length && !isTyName(run[0].a) && run.some(m => QUESTION.test(m.x) || PROBLEM.test(m.x)) && now - run[0].t > 36e5 && now - run[0].t < 3 * 864e5) {
        first = after.indexOf(run.find(m => QUESTION.test(m.x) || PROBLEM.test(m.x))); kind = 'question'; }
    }
    if (first < 0) return null;
    const rest = after.slice(first), m0 = rest[0], cat = ch.catName || '';
    return { id: ch.id + '-' + m0.t, channelId: ch.id, messageId: m0.id || null, channel: '#' + name, category: cat, kind, from: m0.a,
      people: [...new Set(rest.filter(m => !isTyName(m.a)).map(m => m.a))].slice(0, 4), startAt: new Date(m0.t).toISOString(), lastAt: new Date(rest[rest.length - 1].t).toISOString(),
      waitingMin: Math.round((now - m0.t) / 6e4), text: rest.map(m => (rest.length > 1 ? m.a + ': ' : '') + m.x).join('\n').slice(0, 700),
      context: (ms.slice(0, lastTy + 1).filter(m => isTyName(m.a)).pop() || { x: '' }).x.slice(-200) };
  }
  function analyze(chans, staffRe, opt) {
    opt = opt || {};
    const seenIn = {}; chans.forEach(c => new Set(c.msgs.filter(m => !isBot(m)).map(m => clean(m.a))).forEach(a => seenIn[a] = (seenIn[a] || 0) + 1));
    const staff = new Set(Object.keys(seenIn).filter(a => seenIn[a] >= 3)), now = Date.now(), wk = now - 7 * 864e5, mo = now - 31 * 864e5, un = [], tagged = [], channels = {}, rt = {}, wins = {}, winsBy = {}, posts = {}, resp = {}, acks = {};
    for (const c of chans) {
      const key = c.cat.replace(/['’]s Creators.*$/i, '').trim(), coach = opt.coach || COACH[key] || key, general = /announcement|general/i.test(c.name);
      const hs = c.msgs.filter(m => !isBot(m)).map(m => ({ id: m.id, a: clean(m.a), t: +new Date(m.t), x: m.x, me: m.me, r: m.r, st: staffRe ? staffRe.test(clean(m.a)) || (opt.freq && staff.has(clean(m.a))) : staff.has(clean(m.a)) })), runs = [];
      for (const m of hs) { const L = runs[runs.length - 1]; if (L && L.st === m.st) { L.x += '\n' + m.x; L.end = m.t; L.n++; L.ms.push(m); } else runs.push({ st: m.st, a: m.a, t: m.t, end: m.t, x: m.x, n: 1, id: m.id, ms: [m] }); }
      // check-in windows per staff author; only the coach's own messages count (decided after all channels are read)
      hs.forEach(m => { if (m.st && m.t > mo) { const w = win(m.t), by = (winsBy[coach] = winsBy[coach] || {}); posts[coach] = posts[coach] || {}; posts[coach][m.a] = (posts[coach][m.a] || 0) + 1; if (w) (by[m.a] = by[m.a] || new Set()).add(w); } });
      // Someone wrote @Ty in this channel since Ty last spoke or reacted here: it's waiting on Ty himself, whoever the coach is.
      let lastTyI = -1; hs.forEach((m, i) => { if (isTyName(m.a) || m.me) lastTyI = i; });
      const tagI = hs.findIndex((m, i) => i > lastTyI && !isTyName(m.a) && /@Ty\b|@tym0559/i.test(m.x) && now - m.t < 7 * 864e5);
      if (tagI >= 0) { const tm = hs[tagI], rest = hs.slice(tagI);
        tagged.push({ id: c.id + '-t' + tm.t, channelId: c.id, messageId: tm.id || null, startAt: new Date(tm.t).toISOString(), lastAt: new Date(rest[rest.length - 1].t).toISOString(), channel: '#' + c.name, coach, creator: tm.a,
          waitingMin: Math.round((now - tm.t) / 6e4), message: rest.map(m => (rest.length > 1 ? m.a + ': ' : '') + m.x).join('\n').slice(0, 600), context: (hs.slice(0, tagI).filter(m => m.st).pop() || { x: '' }).x.slice(-300), tagged: true }); }
      if (general) { channels[c.id] = { name: c.name, cat: c.cat, coach, general: true }; continue; }
      let asked = 0, answered = 0;
      // Response time: from the first creator message that needs a reply to the next coach message. Runs that are only
      // acknowledgments start no clock (counted in acks so the audit can say how many were left out).
      // resp entries: [clock start minute, minutes to reply, channel id, minute of the creator's last message in the run]
      runs.forEach((r, i) => { const nx = runs[i + 1], s0 = r.st ? null : clockStart(r);
        if (!r.st && s0 == null && r.t > mo) (acks[coach] = acks[coach] || []).push(Math.round(r.t / 6e4));
        if (s0 != null && nx && s0 > mo) (resp[coach] = resp[coach] || []).push([Math.round(s0 / 6e4), Math.round((nx.t - s0) / 6e4), c.id, Math.round(r.end / 6e4)]);
        if (s0 != null && nx && s0 > wk) (rt[coach] = rt[coach] || []).push((nx.t - s0) / 6e4); if (r.st) { if (nx) { asked++; answered++; } else if (now - r.end > 864e5) asked++; } });
      const L = runs[runs.length - 1], lastC = [...runs].reverse().find(r => !r.st), lastS = [...runs].reverse().find(r => r.st), firstS = hs.find(m => m.st);
      const warm = [...hs].reverse().find(m => !m.st && WARM.test(m.x)), iso = t => t ? new Date(t).toISOString() : null;
      channels[c.id] = { name: c.name, cat: c.cat, coach, msgs: hs.length, responseRate: asked ? Math.round(answered / asked * 100) : null,
        lastCreatorMsgAt: iso(lastC && lastC.end), lastStaffMsgAt: iso(lastS && lastS.end), firstStaffAt: iso(firstS && firstS.t), startLoaded: c.startLoaded ?? null, oldestMsgAt: iso(hs[0] && hs[0].t),
        warmAt: iso(warm && warm.t), warmText: warm ? warm.x.slice(0, 160) : null };
      const ls = L && !L.st ? clockStart(L) : null;
      if (L && !L.st) un.push({ id: c.id + '-' + L.t, channelId: c.id, messageId: L.id || null, startAt: iso(ls || L.t), lastAt: iso(L.end), channel: '#' + c.name, coach, creator: L.a, waitingMin: Math.round((now - (ls || L.t)) / 6e4), message: L.x.slice(0, 600),
        context: (runs[runs.length - 2] || { x: '' }).x.slice(-300), ack: ls == null });
    }
    const med = a => { a = a.slice().sort((x, y) => x - y); return a.length ? Math.round(a[Math.floor(a.length / 2)]) : null; }, coachStats = {};
    Object.keys(rt).forEach(k => coachStats[k] = { medianResponseMin: med(rt[k]), replies7d: rt[k].length, over15h7d: rt[k].filter(m => m > 900).length });
    // resp = every creator message -> next staff reply in the last 31 days, as [minute timestamp, minutes to reply], for any timeframe
    Object.keys(resp).forEach(k => (coachStats[k] = coachStats[k] || { medianResponseMin: null, replies7d: 0, over15h7d: 0 }).resp = resp[k].sort((a, b) => a[0] - b[0]).slice(-3000));
    Object.keys(acks).forEach(k => (coachStats[k] = coachStats[k] || { medianResponseMin: null, replies7d: 0, over15h7d: 0 }).acks = acks[k].slice(-3000));
    // The coach's own Discord name(s): matched by name or alias; if none match, the staff member posting most in that category.
    const checkinBy = {};
    Object.keys(winsBy).forEach(k => { const authors = Object.keys(posts[k] || {}); let who = authors.filter(a => isCoach(k, a));
      if (!who.length) { const top = authors.filter(a => !isTyName(a) || isCoach(k, 'Ty')).sort((a, b) => posts[k][b] - posts[k][a])[0]; who = top ? [top] : []; }
      checkinBy[k] = who; wins[k] = new Set(who.flatMap(a => [...(winsBy[k][a] || [])])); });
    Object.keys(checkinBy).forEach(k => (coachStats[k] = coachStats[k] || { medianResponseMin: null, replies7d: 0, over15h7d: 0 }).checkinBy = checkinBy[k]);
    Object.keys(wins).forEach(k => (coachStats[k] = coachStats[k] || { medianResponseMin: null, replies7d: 0, over15h7d: 0 }).checkins = [...wins[k]].sort());
    return { coachStats, channels, unanswered: un, tagged };
  }
  (async () => {
    if (SC.mode === 'channel') {
      try {
        const G = GUILDS.find(x => x[0] === SC.key); if (!G || !/^\d+$/.test(String(SC.channelId))) throw new Error('bad channel scope');
        if (!G[1]) { go('/channels/@me'); await sleep(2500); }
        const gid = await guildOf(G);
        go(`/channels/${gid}`); await sleep(3000);
        const msgs = await read(`/channels/${gid}/${SC.channelId}`, SC.channelId), name = ((document.title.match(/#([^ |]+)/) || [])[1] || 'channel');
        const r = analyze([{ id: SC.channelId, name, cat: '', msgs }], STAFF, G[3]);
        D.channelUpdates = [{ campaign: SC.key, guildId: gid, channelId: SC.channelId, item: r.unanswered[0] || null, tagged: r.tagged[0] || null, info: r.channels[SC.channelId] || null }];
      } catch (e) { D.errors.push('channel: ' + e); }
    }
    for (const G of GUILDS.filter(x => SC.mode === 'all' || (SC.mode === 'campaign' && x[0] === SC.key) || (SC.mode === 'parts' && (SC.keys || []).includes(x[0])))) {
      const [key, , re, opt] = G;
      try {
        if (!G[1]) { go('/channels/@me'); await sleep(2500); }
        const g = await guildOf(G);
        go(`/channels/${g}`); await sleep(3500);
        const sb = await sidebar();
        let cats = [...new Set(sb.filter(x => !x.isCat && x.catName && re.test(x.catName)).map(x => x.catName))];
        if (opt && opt.section && cats.length > 1) { // several "Team Ty" categories: keep the YRI one(s)
          const heads = sb.filter(x => x.isCat).map(x => x.name.replace(/ \(category\)$/, ''));
          const yri = cats.filter(c => opt.section.test(c) || opt.section.test(heads[heads.indexOf(c) - 1] || ''));
          if (yri.length) cats = yri; else D.errors.push(key + ': several categories match, using all: ' + cats.join(', '));
        }
        if (!cats.length) throw new Error('no matching category found');
        const list = sb.filter(x => !x.isCat && cats.includes(x.catName) && !/voice channel|stage channel/i.test(x.name)), chans = [];
        for (const ch of list) { D.progress = `${key} ${chans.length}/${list.length}`; const msgs = await read(`/channels/${g}/${ch.id}`, ch.id, needStart(ch.id)).catch(() => []); chans.push({ id: ch.id, name: ch.name.replace(/ \(.*$/, '').replace(/^unread, /, ''), cat: ch.catName, msgs, startLoaded: read.top }); }
        const r = opt ? analyze(chans, STAFF, { ...opt, freq: true }) : analyze(chans);
        D.campaigns.push({ id: key, guildId: g, ...(opt ? { name: opt.name, role: opt.role, discordCategories: cats } : {}), discordScannedAt: new Date().toISOString(), discord: { coachStats: r.coachStats, channels: r.channels }, unanswered: r.unanswered, tagged: r.tagged });
      } catch (e) { D.errors.push(key + ': ' + e); }
    }
    if (SC.mode === 'all' || SC.mode === 'dms' || (SC.mode === 'parts' && SC.dms)) try {
      D.progress = 'dms'; go('/channels/@me'); await sleep(3000);
      const links = [...document.querySelectorAll('a[href^="/channels/@me/"]')].map(a => ({ id: a.getAttribute('href').split('/').pop(), label: (a.getAttribute('aria-label') || a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80) })).filter(x => /^\d+$/.test(x.id)).slice(0, 20);
      const res = []; for (const l of links) res.push({ ...l, ms: (await read(`/channels/@me/${l.id}`, l.id).catch(() => [])).map(m => ({ id: m.id, a: clean(m.a), t: m.t, x: m.x, me: m.me })).slice(-8) });
      const cnt = {}; res.forEach(r => new Set(r.ms.map(m => m.a)).forEach(a => cnt[a] = (cnt[a] || 0) + 1));
      const me = (Object.entries(cnt).sort((a, b) => b[1] - a[1])[0] || [''])[0], now = Date.now();
      D.dms = res.map(r => { const L = r.ms[r.ms.length - 1]; if (!L || L.a === me || L.me) return null; /* Ty answered, or reacted to their last message */ let i = r.ms.length - 1; while (i > 0 && r.ms[i - 1].a !== me) i--; const run = r.ms.slice(i);
        return { id: r.id, messageId: run[0].id || null, lastAt: run[run.length - 1].t || null, from: r.label.replace(/^unread, /, '').replace(/ \((direct message|group message)\).*$/, ''), channel: 'Discord DM', unread: /^unread/.test(r.label), waitingMin: Math.round((now - new Date(run[0].t)) / 6e4), text: run.map(m => m.x).join('\n').slice(0, 500) }; }).filter(x => x && x.waitingMin < 14 * 1440);
    } catch (e) { D.errors.push('dms: ' + e); }
    // Launchpoint Coaches server: what the CMs, coaches and leadership need from Ty. Same rules as Ty's campaign-report skill:
    // @mentions of Ty (or his UGC Operations role) and replies to him, anything in his own #ty-mcguire channel, leadership asks,
    // and questions left unanswered in his campaign and ops channels. Read-only.
    if (SC.mode === 'all' || SC.mode === 'coaches' || (SC.mode === 'parts' && SC.coaches)) try {
      const G = COACHES; D.progress = 'coaches'; go(`/channels/${G.id}`); await sleep(3500);
      const sb = await sidebar(), list = sb.filter(x => !x.isCat && x.catName && G.cats.test(x.catName) && !G.skip.test(x.catName) && !G.skipIds.includes(x.id) && !G.skipCh.test(x.name) && !/voice channel|stage channel/i.test(x.name));
      if (!list.length) throw new Error('no matching categories (is the Launchpoint Coaches server in the server list?)');
      const now = Date.now(), items = [];
      for (const [i, ch] of list.entries()) {
        D.progress = `coaches ${i}/${list.length}`;
        const name = ch.name.replace(/ \(.*$/, '').replace(/^unread, /, '').replace(/^\d+ mentions?, /, ''), unread = /unread|mention/i.test(ch.name);
        const ms = (await read(`/channels/${G.id}/${ch.id}`, ch.id).catch(() => [])).map(m => ({ ...m, a: clean(m.a), t: +new Date(m.t) })).filter(m => !isBot(m) || G.lead.test(m.a));
        const item = coachItem(ch, name, ms, now); if (item) items.push({ ...item, unread });
      }
      D.coaches = { guildId: G.id, scannedAt: new Date().toISOString(), channels: list.length, items: items.sort((a, b) => b.waitingMin - a.waitingMin) };
    } catch (e) { D.errors.push('coaches: ' + e); }
    // Ty's own waiting creators (CapCut + YRI), keyed "#channel" for CapCut and "yri #channel" for YRI.
    const line = (cid, u) => `${dkey(cid, u.channel)} | ${Math.round(u.waitingMin / 60)}h | COACH SAID: ${u.context.replace(/\n/g, ' ').slice(-160)} | CREATOR: ${u.message.replace(/\n/g, ' / ').slice(0, 360)}`;
    const one = D.channelUpdates && MINE.includes(SC.key) && D.channelUpdates[0] && D.channelUpdates[0].item;
    D.mine = one ? [one].filter(u => !u.ack).map(u => line(SC.key, u))
      : D.campaigns.filter(c => MINE.includes(c.id)).flatMap(c => c.unanswered.filter(u => !u.ack && /^Ty\b/.test(u.coach)).sort((a, b) => b.waitingMin - a.waitingMin).map(u => line(c.id, u)));
    // @Ty tags in any campaign's creator channels, keyed "tag <campaign> #channel"
    D.mine = D.mine.concat(D.campaigns.flatMap(c => (c.tagged || []).map(t => `tag ${c.id} ${t.channel} | ${Math.round(t.waitingMin / 60)}h | TAGGED TY (coach ${t.coach}) | LAST STAFF MSG: ${t.context.replace(/\n/g, ' ').slice(-160)} | MESSAGES: ${t.message.replace(/\n/g, ' / ').slice(0, 360)}`)));
    // Coaches server items, keyed "coaches #channel": who | why it needs Ty | what they said
    D.coachLines = (D.coaches ? D.coaches.items : []).map(it => `coaches ${it.channel} (${it.category}) | ${Math.round(it.waitingMin / 60)}h | ${it.kind} | TY LAST SAID: ${it.context.replace(/\n/g, ' ').slice(-120)} | THEY SAID: ${it.text.replace(/\n/g, ' / ').slice(0, 400)}`);
    D.progress = 'done'; D.done = true;
  })();
  window.discSubmit = (drafts, acks, token) => {
    const D = window.__disc; drafts = drafts || {}; acks = acks || [];
    for (const c of D.campaigns) { c.unanswered.forEach(u => { const k = dkey(c.id, u.channel); if (acks.includes(k)) u.ack = true; if (MINE.includes(c.id) && drafts[k]) u.draft = drafts[k]; }); c.unanswered = c.unanswered.filter(u => !u.ack).map(({ ack, ...u }) => u); }
    for (const cu of D.channelUpdates || []) if (cu.item) { const k = dkey(cu.campaign, cu.item.channel); if (acks.includes(k)) cu.item = null; else { if (drafts[k]) cu.item.draft = drafts[k]; delete cu.item.ack; } }
    for (const c of D.campaigns) c.tagged = (c.tagged || []).filter(t => !acks.includes(`tag ${c.id} ${t.channel}`)).map(t => drafts[`tag ${c.id} ${t.channel}`] ? { ...t, draft: drafts[`tag ${c.id} ${t.channel}`] } : t);
    for (const cu of D.channelUpdates || []) if (cu.tagged) { const k = `tag ${cu.campaign} ${cu.tagged.channel}`; if (acks.includes(k)) cu.tagged = null; else if (drafts[k]) cu.tagged.draft = drafts[k]; }
    if (D.coaches) D.coaches.items = D.coaches.items.filter(it => !acks.includes('coaches ' + it.channel)).map(it => drafts['coaches ' + it.channel] ? { ...it, draft: drafts['coaches ' + it.channel] } : it);
    const payload = { campaigns: D.campaigns, ...(D.dms ? { dms: D.dms } : {}), ...(D.coaches ? { coaches: D.coaches } : {}), ...(D.channelUpdates ? { channelUpdates: D.channelUpdates } : {}), ...(D.scope.mode !== 'all' ? { completeRescans: true } : {}), scanStatus: { discord: D.errors.length ? 'partial: ' + D.errors.join('; ') : 'ok', discordAt: new Date().toISOString() } };
    const f = document.createElement('form'); f.method = 'POST'; f.action = 'https://gigca-cm-portal-production.up.railway.app/api/runner/ingest-form'; f.style.display = 'none';
    for (const [k, v] of [['token', token], ['payload', JSON.stringify(payload)]]) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); }
    document.body.appendChild(f); setTimeout(() => f.submit(), 300); return 'submitting ' + JSON.stringify(payload).length + ' bytes';
  };
})();
