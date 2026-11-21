// Slack scan. Run in an app.slack.com tab (Launchpoint workspace). Opens each sidebar conversation, reads the last messages,
// then posts "waiting on Ty" items to the portal. Call with the token replaced; poll window.__slack.done.
(() => {
  const TOKEN = '__TOKEN__', sleep = ms => new Promise(r => setTimeout(r, ms));
  const SKIP = /^(Threads|Huddles|Drafts|Directories|Add channels|Invite people|More|Activity|Later|capcut-devin|dev-bugs|Devin|launchpoint-liquidtrade)/i;
  const S = window.__slack = { done: false, items: [], error: null };
  (async () => {
    try {
      const els = [...document.querySelectorAll('.p-channel_sidebar__channel, .p-channel_sidebar__link')].filter(e => { const t = (e.innerText || '').trim().replace(/\s+/g, ' '); return t && !SKIP.test(t) && !/you(guest)?$/.test(t); });
      const res = [];
      for (const e of els) {
        const name = (e.innerText || '').trim().replace(/\s+/g, ' ').replace(/\s*\d+$/, ''); e.click(); await sleep(2200);
        let sender = null; const ms = [];
        for (const m of document.querySelectorAll('[data-qa="message_container"]')) {
          const s = m.querySelector('[data-qa="message_sender_name"]'); if (s) sender = s.innerText.trim();
          const t = m.querySelector('[data-qa="message-text"], .c-message_kit__blocks'), ts = m.querySelector('a.c-timestamp'), tsv = ts && ts.getAttribute('data-ts');
          if (sender && tsv) ms.push({ a: sender, t: Math.round(parseFloat(tsv) * 1000), x: (t ? t.innerText : '').trim().slice(0, 500) });
        }
        res.push({ name, ms: ms.slice(-10) });
      }
      const now = Date.now();
      for (const r of res) {
        const isDm = !/^(brand-|launchpoint-)/.test(r.name), lastTy = Math.max(-1, ...r.ms.map((m, i) => /^Ty McGuire/.test(m.a) ? i : -1)), after = r.ms.slice(lastTy + 1);
        const pick = isDm ? after : after.filter(m => /@Ty\b|@Ty McGuire|@channel|@here/.test(m.x)); if (!pick.length) continue;
        const w = Math.round((now - pick[0].t) / 6e4); if (w > 7 * 1440) continue;
        S.items.push({ id: 's-' + r.name + '-' + pick[0].t, channel: isDm ? 'Slack DM: ' + r.name : '#' + r.name, from: pick[pick.length - 1].a, text: pick.map(m => m.x).join('\n').slice(0, 500), waitingMin: w });
      }
    } catch (e) { S.error = String(e); }
    const payload = { completeRescans: true, slack: S.items, scanStatus: { slack: S.error ? 'failed: ' + S.error : 'ok', at: new Date().toISOString() } };
    const f = document.createElement('form'); f.method = 'POST'; f.action = 'https://gigca-cm-portal-production.up.railway.app/api/runner/ingest-form'; f.style.display = 'none';
    for (const [k, v] of [['token', TOKEN], ['payload', JSON.stringify(payload)]]) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); }
    document.body.appendChild(f); S.done = true; setTimeout(() => f.submit(), 1500);
  })();
})();
