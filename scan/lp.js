// LaunchPoint scan. Run in a dashboard.launchpointhq.com tab (Claude in Chrome, Mac Mini).
// Reads the dashboard's own same-origin API, then posts results to the portal through a hidden form.
// Replace __TOKEN__ with the runner token before injecting. Optional: window.__lpScope = ['capcut', ...] scans only those. Result summary lands in window.__lpSummary.
(async () => {
  const PORTAL = 'https://gigca-cm-portal-production.up.railway.app/api/runner/ingest-form', TOKEN = '__TOKEN__';
  const CAMPAIGNS = [
    ['ad9ce1e9-4ec7-470a-a8f0-5ff9f415cdf6', 'CapCut', 'capcut', 'cm'],
    ['4caad8fb-2d1d-4207-86c6-0386a84418bc', 'Artlist', 'artlist', 'oversight'],
    ['a54e33c7-1fef-48bb-8afd-f7e7212225ab', 'Creatify', 'creatify', 'oversight'],
    ['82b90bac-8d38-4d08-b101-39702efb9b1c', 'Melius', 'melius', 'oversight'],
  ];
  const g = async u => { const x = await fetch(u); if (!x.ok) throw new Error(u.split('?')[0] + ' ' + x.status); return x.json(); };
  const fmt = d => d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const end = fmt(new Date()), start = fmt(new Date(Date.now() - 6 * 864e5)), start30 = fmt(new Date(Date.now() - 29 * 864e5)), yday = fmt(new Date(Date.now() - 864e5));
  // Last calendar week, Monday to Sunday (Chicago dates), for "Last week" in the coach checks and the campaign audit.
  const addD = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const lwEnd = addD(end, -(((new Date(end + 'T12:00:00Z').getUTCDay() + 6) % 7) + 1)), lwStart = addD(lwEnd, -6);
  const cpm = (cents, views) => views && cents ? +(cents / 100 / views * 1000).toFixed(2) : null;
  async function scan(id, name, cid, role) {
    let rows = [], cursor = '', guard = 0;
    do {
      const j = await g(`/api/buy/campaigns/${id}/creator-rows?limit=100&cursor=${encodeURIComponent(cursor)}&status=active&sortBy=views&sortDir=desc&startDate=${start}&endDate=${end}`);
      rows = rows.concat(j.rows); cursor = j.hasMore ? j.nextCursor : '';
    } while (cursor && ++guard < 20);
    const ent = {}, health = {}, apc = {}, e30 = {}, eT = {}, eY = {}, eW = {}; let dates = [], dates30 = null;
    const stats = (a, b, ids) => g(`/api/buy/analytics/stats/entities?startDate=${a}&endDate=${b}&offerIds=${id}&ids=${ids}`);
    for (let i = 0; i < rows.length; i += 25) {
      const ids = rows.slice(i, i + 25).map(r => r.uid).join(',');
      // 30 days, today and yesterday feed the coach audit timeframes; failures there never block the scan
      const [m, t, y, w] = await Promise.all([stats(start30, end, ids), stats(end, end, ids), stats(yday, yday, ids), stats(lwStart, lwEnd, ids)].map(p => p.catch(() => null)));
      if (m) { Object.assign(e30, m.byCreatorId); if (Array.isArray(m.consistencyDates) && m.consistencyDates.length >= 28) dates30 = m.consistencyDates; }
      if (t) Object.assign(eT, t.byCreatorId); if (y) Object.assign(eY, y.byCreatorId); if (w) Object.assign(eW, w.byCreatorId);
      const [e, h, a] = await Promise.all([
        stats(start, end, ids),
        g(`/api/buy/creators/account-health?ids=${ids}`).catch(() => ({ byCreatorId: {} })),
        g(`/api/buy/campaigns/${id}/account-post-counts?ids=${ids}`).catch(() => ({ byCreatorId: {} }))]);
      Object.assign(ent, e.byCreatorId); Object.assign(health, h.byCreatorId); Object.assign(apc, a.byCreatorId); dates = e.consistencyDates || dates;
    }
    // Campaign totals for last week and the week before it (LaunchPoint's "previous" = the prior window of the same length)
    const lw = await g(`/api/buy/analytics/stats?offerIds=${id}&startDate=${lwStart}&endDate=${lwEnd}`).catch(() => null);
    const [mem, st, all] = await Promise.all([
      g(`/api/buy/offers/${id}/discord/members`).catch(() => null),
      g(`/api/buy/analytics/stats?offerIds=${id}&startDate=${start}&endDate=${end}`),
      g(`/api/buy/analytics/stats?offerIds=${id}&startDate=2024-01-01&endDate=${end}`).catch(() => null)]);
    const inD = mem ? new Set(mem.uids) : null, dest = {}; (mem ? mem.destinations : []).forEach(d => dest[d.uid] = d);
    const creators = rows.map(r => {
      const e = ent[r.uid] || {}, c = e.consistency || [], s = r.summary, d = dest[r.uid], at = e.allTime || {};
      const atCents = (at.paidCents || 0) + (at.paidOffPlatformCents || 0) + (at.trackingCents || 0) + (at.awaitingCents || 0);
      return {
        id: r.uid, name: ((r.firstName || '') + ' ' + (r.lastName || '')).trim() || 'Unknown', handle: (r.accounts[0] || { account: {} }).account.label || '',
        coach: 'Unassigned', channel: d ? '#' + d.channelName : '', channelId: d ? d.channelId : null,
        postsToday: c[6] || 0, postsYesterday: c[5] || 0, posts7d: c.reduce((a, b) => a + b, 0), views7d: e.views || 0, cpm: cpm(e.earningsCents || 0, e.views || 0),
        viewsAllTime: at.views || 0, postsAllTime: at.posts || 0, cpmAllTime: cpm(atCents, at.views || 0),
        daily: c.length === 7 ? c : null, // posts per day, last 7 days ending today (LaunchPoint's strip is always 7 days)
        // posts per day for the last 30 days (oldest first, matching the campaign's days30), for custom date ranges
        d30: Array.isArray((e30[r.uid] || {}).consistency) && e30[r.uid].consistency.length >= 28 ? e30[r.uid].consistency : null,
        rng: Object.fromEntries([['t', eT], ['y', eY], ['m', e30], ['w', eW]].map(([k, src]) => { const z = src[r.uid] || {}; return [k, { v: z.views || 0, posts: z.posts || 0, cpm: cpm(z.earningsCents || 0, z.views || 0) }]; })),
        expectedPerDay: s.weeklyWindow && s.weeklyWindow.postsRequired ? Math.round(s.weeklyWindow.postsRequired / 7) : 3,
        inDiscord: inD ? inD.has(r.uid) : true, responseRate: null,
        daysOnCampaign: Math.max(1, Math.round((Date.now() - new Date(s.joinedAt)) / 864e5)), step: s.step && s.step.name,
        everPosted: !!s.latestTrackedPostAt, lastPostAt: s.latestTrackedPostAt || null,
        accounts: r.accounts.map(a => ({ platform: a.platform[0].toUpperCase() + a.platform.slice(1), handle: a.account.label,
          health: ((health[r.uid] || {}).byAccountId || {})[a.socialAccountId] || null, posts: (apc[r.uid] || {})[a.socialAccountId] ?? null })),
      };
    });
    const S = st.summary, A = all && all.summary;
    return {
      id: cid, lpId: id, name, role, targetCpm: 4, expectedPerDay: 3,
      cpm: cpm(S.spendCents.current, S.views.current), views7d: S.views.current, spend7d: Math.round(S.spendCents.current / 100),
      cpmAllTime: A ? cpm(A.spendCents.current, A.views.current) : null, viewsAllTime: A ? A.views.current : null, spendAllTime: A ? Math.round(A.spendCents.current / 100) : null,
      days7: dates.length === 7 ? dates : null, days30: dates30,
      lastWeek: lw && lw.summary ? { start: lwStart, end: lwEnd, views: lw.summary.views.current, prevViews: lw.summary.views.previous, posts: (lw.summary.posts || {}).current ?? null, prevPosts: (lw.summary.posts || {}).previous ?? null,
        cpm: cpm(lw.summary.spendCents.current, lw.summary.views.current), prevCpm: cpm(lw.summary.spendCents.previous, lw.summary.views.previous), creators: lw.uniqueCreators ?? null,
        top: (lw.topContent || []).slice(0, 5).map(v => ({ creator: v.creatorName, platform: v.platform, views: v.views, url: v.permalinkUrl })) } : null, postsByDay: dates.map((dt, i) => ({ date: dt, posts: creators.reduce((a, x) => a + (((ent[x.id] || {}).consistency || [])[i] || 0), 0) })),
      scannedAt: new Date().toISOString(), guildId: mem ? mem.guildId : null, creators,
    };
  }
  // YRI has no fixed id here: look it up by name in the campaign list. If it isn't on LaunchPoint, it is skipped quietly
  // (the portal still shows its Discord side) and the reason lands in window.__lpSummary.notes.
  const notes = {};
  async function findByName(re) {
    for (const u of ['/api/buy/campaigns?limit=200', '/api/buy/campaigns', '/api/buy/offers?limit=200', '/api/buy/offers']) {
      const j = await g(u).catch(() => null); if (!j) continue; const hits = [];
      (function walk(o, d) { if (!o || typeof o !== 'object' || d > 6) return; if (Array.isArray(o)) return o.forEach(x => walk(x, d + 1));
        const nm = o.name || o.title || o.offerName || o.campaignName, id = o.id || o.offerId || o.campaignId;
        if (typeof nm === 'string' && re.test(nm) && /^[0-9a-f-]{36}$/i.test(String(id || ''))) hits.push(String(id));
        Object.values(o).forEach(v => walk(v, d + 1)); })(j, 0);
      if (hits.length) return hits[0];
    }
    return null;
  }
  if (!CAMPAIGNS.some(x => x[2] === 'yri')) {
    const id = await findByName(/\bYRI\b/i).catch(() => null);
    if (id) CAMPAIGNS.push([id, 'YRI', 'yri', 'cm']); else notes.yri = 'YRI not found in the LaunchPoint campaign list';
  }
  const out = [], errs = {};
  const only = Array.isArray(window.__lpScope) && window.__lpScope.length ? window.__lpScope : null; // optional: just these campaigns
  for (const [id, name, cid, role] of CAMPAIGNS.filter(x => !only || only.includes(x[2]))) { try { out.push(await scan(id, name, cid, role)); } catch (e) { errs[cid] = String(e); } }
  window.__lpSummary = { errs, notes, campaigns: out.map(c => ({ name: c.name, creators: c.creators.length, cpm: c.cpm, cpmAllTime: c.cpmAllTime, viewsAllTime: c.viewsAllTime, spendAllTime: c.spendAllTime })) };
  if (out.length) {
    let fr = document.getElementById('__pf'); if (!fr) { fr = document.createElement('iframe'); fr.name = '__pf'; fr.id = '__pf'; fr.style.display = 'none'; document.body.appendChild(fr); }
    const f = document.createElement('form'); f.method = 'POST'; f.action = PORTAL; f.target = '__pf'; f.style.display = 'none';
    const payload = { campaigns: out, scanStatus: { lp: Object.keys(errs).length ? 'partial' : 'ok', lpAt: new Date().toISOString() } };
    for (const [k, v] of [['token', TOKEN], ['payload', JSON.stringify(payload)]]) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); }
    document.body.appendChild(f); f.submit(); f.remove();
  }
  window.__lpDone = true;
})();
