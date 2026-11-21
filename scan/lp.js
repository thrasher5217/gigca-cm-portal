// LaunchPoint scan. Run in a dashboard.launchpointhq.com tab (Claude in Chrome, Mac Mini).
// Reads the dashboard's own same-origin API, then posts results to the portal through a hidden form.
// Replace __TOKEN__ with the runner token before injecting. Result summary lands in window.__lpSummary.
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
  const end = fmt(new Date()), start = fmt(new Date(Date.now() - 6 * 864e5));
  const cpm = (cents, views) => views && cents ? +(cents / 100 / views * 1000).toFixed(2) : null;
  async function scan(id, name, cid, role) {
    let rows = [], cursor = '', guard = 0;
    do {
      const j = await g(`/api/buy/campaigns/${id}/creator-rows?limit=100&cursor=${encodeURIComponent(cursor)}&status=active&sortBy=views&sortDir=desc&startDate=${start}&endDate=${end}`);
      rows = rows.concat(j.rows); cursor = j.hasMore ? j.nextCursor : '';
    } while (cursor && ++guard < 20);
    const ent = {}, health = {}, apc = {}; let dates = [];
    for (let i = 0; i < rows.length; i += 25) {
      const ids = rows.slice(i, i + 25).map(r => r.uid).join(',');
      const [e, h, a] = await Promise.all([
        g(`/api/buy/analytics/stats/entities?startDate=${start}&endDate=${end}&offerIds=${id}&ids=${ids}`),
        g(`/api/buy/creators/account-health?ids=${ids}`).catch(() => ({ byCreatorId: {} })),
        g(`/api/buy/campaigns/${id}/account-post-counts?ids=${ids}`).catch(() => ({ byCreatorId: {} }))]);
      Object.assign(ent, e.byCreatorId); Object.assign(health, h.byCreatorId); Object.assign(apc, a.byCreatorId); dates = e.consistencyDates || dates;
    }
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
      postsByDay: dates.map((dt, i) => ({ date: dt, posts: creators.reduce((a, x) => a + (((ent[x.id] || {}).consistency || [])[i] || 0), 0) })),
      scannedAt: new Date().toISOString(), guildId: mem ? mem.guildId : null, creators,
    };
  }
  const out = [], errs = {};
  for (const [id, name, cid, role] of CAMPAIGNS) { try { out.push(await scan(id, name, cid, role)); } catch (e) { errs[cid] = String(e); } }
  window.__lpSummary = { errs, campaigns: out.map(c => ({ name: c.name, creators: c.creators.length, cpm: c.cpm, cpmAllTime: c.cpmAllTime, viewsAllTime: c.viewsAllTime, spendAllTime: c.spendAllTime })) };
  if (out.length) {
    let fr = document.getElementById('__pf'); if (!fr) { fr = document.createElement('iframe'); fr.name = '__pf'; fr.id = '__pf'; fr.style.display = 'none'; document.body.appendChild(fr); }
    const f = document.createElement('form'); f.method = 'POST'; f.action = PORTAL; f.target = '__pf'; f.style.display = 'none';
    const payload = { campaigns: out, scanStatus: { lp: Object.keys(errs).length ? 'partial' : 'ok', lpAt: new Date().toISOString() } };
    for (const [k, v] of [['token', TOKEN], ['payload', JSON.stringify(payload)]]) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); }
    document.body.appendChild(f); f.submit(); f.remove();
  }
  window.__lpDone = true;
})();
