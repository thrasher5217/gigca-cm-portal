// Send replies Ty wrote on the portal. Run in a discord.com tab on the Mac Mini (Claude in Chrome), logged in as Ty.
// Set window.__sends = [{id, guildId, channelId, text}, ...] first, then run this. Poll window.__send.done;
// window.__send.lines then holds one line per message: "SENT <id>" or "FAILED <id> - <reason>".
// Each message is typed into that channel's box, checked, then sent with Enter, and the script waits until it shows up
// in the channel. It never retypes over a draft already in the box, and it skips a message that is already there.
(() => {
  const S = window.__send = { done: false, progress: 'starting', lines: [] };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const go = p => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); };
  // Loose fingerprint: Discord renders <#id> as #name and applies markdown, so compare letters and digits only.
  const key = t => String(t || '').replace(/<[#@][!&]?\d+>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  const box = () => document.querySelector('[role="textbox"][data-slate-editor="true"]');
  const msgs = ch => [...document.querySelectorAll(`li[id^="chat-messages-${ch}-"]`)].map(li => {
    const ct = [...li.querySelectorAll('[id^="message-content-"]')].find(e => !e.closest('[id^="message-reply-context-"]'));
    const tm = li.querySelector('time[datetime]');
    return { id: li.id, k: key(ct ? ct.innerText : ''), t: tm ? +new Date(tm.getAttribute('datetime')) : 0, failed: !!li.querySelector('[class*="isFailed"],[class*="failed"]') };
  });
  // Does a shown message match the text? Channel/user links show as names, so match the pieces between them, in order.
  const has = (m, text) => { if (!m.k) return false; let at = 0;
    for (const part of String(text).split(/<[#@][!&]?\d+>/).map(key).filter(Boolean)) { const i = m.k.indexOf(part, at); if (i < 0) return false; at = i + part.length; }
    return at > 0; };

  async function sendOne(s) {
    if (!/^\d+$/.test(String(s.guildId)) || !/^\d+$/.test(String(s.channelId))) return 'bad channel';
    const k = key(s.text); if (!k) return 'empty message';
    go(`/channels/${s.guildId}/${s.channelId}`);
    let el = null;
    for (let i = 0; i < 60; i++) { await sleep(250); el = box(); if (el && location.pathname.endsWith(s.channelId) && document.querySelector(`li[id^="chat-messages-${s.channelId}-"]`)) break; }
    if (!location.pathname.endsWith(s.channelId)) return 'could not open the channel';
    if (!el) return "can't post in this channel (no message box)";
    await sleep(800);
    // Already sent (e.g. an earlier run sent it but could not report back)? Then don't send it twice.
    if (msgs(s.channelId).slice(-6).some(m => has(m, s.text) && Date.now() - m.t < 60 * 60000)) return null;
    if (key(el.innerText)) return 'something is already typed in that channel on the Mac Mini; left it alone';
    const before = new Set(msgs(s.channelId).map(m => m.id));
    el.focus(); await sleep(150);
    const dt = new DataTransfer(); dt.setData('text/plain', s.text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(500);
    if (!key(el.innerText).startsWith(k.slice(0, 40))) {
      el.focus(); document.execCommand('selectAll'); document.execCommand('delete');
      return 'could not type the message into the box';
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const n = msgs(s.channelId).filter(m => !before.has(m.id) && has(m, s.text));
      if (n.length) return n.some(m => m.failed) ? 'Discord said the message failed to send' : null;
    }
    return key(box() && box().innerText) ? 'pressed Enter but the message is still in the box (not sent)' : 'sent, but could not see it in the channel afterwards. Check before sending again';
  }

  (async () => {
    const list = Array.isArray(window.__sends) ? window.__sends : [];
    for (const [i, s] of list.entries()) {
      S.progress = `${i + 1}/${list.length}`;
      let err; try { err = await sendOne(s); } catch (e) { err = 'error: ' + e; }
      S.lines.push(err ? `FAILED ${s.id} - ${String(err).replace(/\s+/g, ' ').slice(0, 200)}` : `SENT ${s.id}`);
      await sleep(1500); // pace messages like a person would
    }
    S.progress = 'done'; S.done = true;
  })();
})();
