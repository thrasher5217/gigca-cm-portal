// Generates clearly fake sample data so the layout can be reviewed before real scans exist.
const fs = require('fs'), path = require('path');
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = a => a[Math.floor(rnd() * a.length)], int = (a, b) => Math.floor(a + rnd() * (b - a + 1));
const first = ['Mia','Jon','Lena','Omar','Tess','Kai','Rosa','Dev','Nina','Cole','Ava','Theo','Iris','Sam','Zoe','Finn','Lux','Remy','Jade','Milo','Noor','Beau','Wren','Ezra'];
const msgs = ['is the hook ok if I skip the intro line?','my IG won\'t connect in LaunchPoint, keeps erroring','posted 2 today, 3rd going up tonight','can I reuse yesterday\'s b-roll for format 4?','do I need the paid partnership label?','views tanked on my last 3, any idea why?','which workflow goes with the non-talking demo?'];
const drafts = ['Yes, you can skip it as long as the hook lands in the first 2 seconds. Send me the draft before you post and I\'ll take a look.','Try disconnecting and reconnecting from Settings, then re-auth in an incognito window. If it still errors, send me a screenshot and I\'ll open a hotline ticket.','Love it. Drop the links here once the third is live.','Yes for b-roll, but change the hook and first 3 seconds so it doesn\'t read as a repost.','No label needed. Just make sure #capcut #capcutpioneer #1mincapcut are in the caption or the video isn\'t eligible for payment.','Let\'s look together. Send the 3 links and book a 20-min slot on the call sheet; my guess is the hook, but I want to see them.','Use the link inside the format brief; non-talking formats only pair with the non-talking workflows.'];
const camps = [
  { id: 'capcut', name: 'CapCut', role: 'cm', targetCpm: 4.0, expectedPerDay: 3, coaches: ['Coach A (you)', 'Coach B', 'Coach C'], n: 18 },
  { id: 'artlist', name: 'Artlist', role: 'oversight', targetCpm: 4.0, expectedPerDay: 3, coaches: ['Coach D', 'Coach E', 'Coach F'], n: 14 },
  { id: 'creatify', name: 'Creatify', role: 'oversight', targetCpm: 4.0, expectedPerDay: 3, coaches: ['Coach G', 'Coach H'], n: 12 },
  { id: 'melius', name: 'Melius', role: 'oversight', targetCpm: 4.0, expectedPerDay: 3, coaches: ['Coach I', 'Coach J'], n: 10 },
];
let uid = 0;
const campaigns = camps.map(c => {
  const creators = Array.from({ length: c.n }, (_, i) => {
    const name = first[(i * 5 + c.id.length * 3) % first.length] + ' ' + String.fromCharCode(65 + (i * 7) % 26) + '.';
    const tier = rnd(), good = tier > 0.6, bad = tier < 0.18;
    const postsY = bad ? int(0, 1) : good ? int(3, 5) : int(0, 3), postsT = bad ? 0 : int(0, good ? 4 : 2);
    const posts7d = Math.min(35, postsY * int(4, 7) + postsT), views7d = posts7d * int(bad ? 300 : 1500, good ? 30000 : 9000);
    const pay = posts7d * int(12, 22);
    return { id: c.id + '-' + i, name, handle: '@' + name.toLowerCase().replace(/[^a-z]/g, '') + int(1, 99), coach: c.coaches[i % c.coaches.length],
      channel: '#' + name.split(' ')[0].toLowerCase() + '-' + c.id, postsToday: postsT, postsYesterday: postsY, posts7d, views7d,
      cpm: views7d ? +(pay / views7d * 1000).toFixed(2) : null, expectedPerDay: c.expectedPerDay,
      accounts: ['Instagram','TikTok','YouTube','Facebook'].filter(() => rnd() > 0.35).concat(['Instagram']).filter((v, i, a) => a.indexOf(v) === i).map(pf => ({ platform: pf, handle: '@' + name.toLowerCase().replace(/[^a-z]/g, '') + '.' + pf.slice(0, 2).toLowerCase(), posts7d: int(3, 14), avgViews: rnd() < 0.14 ? int(40, 195) : int(260, good ? 22000 : 6000) })),
      inDiscord: rnd() > 0.08, responseRate: bad ? int(20, 55) : int(60, 100), daysOnCampaign: int(2, 21) };
  });
  const unanswered = creators.filter(x => x.inDiscord && rnd() < (c.role === 'cm' ? 0.38 : 0.22)).map(x => {
    const k = int(0, msgs.length - 1);
    return { id: 'u' + (++uid), creatorId: x.id, creator: x.name, channel: x.channel, coach: x.coach, waitingMin: int(12, 900), message: msgs[k], draft: c.role === 'cm' ? drafts[k] : null };
  });
  const coaches = c.coaches.map(n => {
    const mine = creators.filter(x => x.coach === n), un = unanswered.filter(u => u.coach === n);
    return { name: n, creators: mine.length, medianResponseMin: int(18, 420), unanswered: un.length,
      oldestUnansweredMin: un.reduce((m, u) => Math.max(m, u.waitingMin), 0), missedCheckins7d: int(0, 9), strikes: int(0, 2) };
  });
  const views = creators.reduce((s, x) => s + x.views7d, 0), spend = creators.reduce((s, x) => s + (x.cpm || 0) * x.views7d / 1000, 0);
  const hourly = Array.from({ length: 24 }, (_, h) => h < 6 ? 0 : h > 18 ? null : int(0, Math.ceil(c.n / 4)));
  return { id: c.id, name: c.name, role: c.role, targetCpm: c.targetCpm, expectedPerDay: c.expectedPerDay, cpm: +(spend / views * 1000).toFixed(2),
    views7d: views, spend7d: Math.round(spend), postsByHourToday: hourly, scannedAt: new Date(Date.now() - int(4, 55) * 60000).toISOString(), coaches, creators, unanswered };
});
const slack = [
  { id: 's1', channel: '#capcut-client', from: 'Client PM', text: 'Can we get the top 5 formats by CPM before Monday\'s sync?', waitingMin: 95 },
  { id: 's2', channel: 'DM', from: 'Ops lead', text: 'Need your strike tallies for the Artlist coaches by Sunday night.', waitingMin: 310 },
  { id: 's3', channel: '#artlist-internal', from: 'Coach D', text: '@Ty two creators asking about the pay threshold change, what do I tell them?', waitingMin: 42 },
];
const audits = campaigns.flatMap(c => c.coaches.map(k => ({ campaign: c.id, coach: k.name, week: 'Nov 9–15', score: int(58, 96), strikes: k.strikes,
  summary: pick(['Median response over 5h on 3 days; check-ins consistent.', 'CPM under target all week; one creator warming up past 7 days.', 'Missed 7+ check-ins; two creators with 5 straight sub-1k videos.', 'Strong week: viral format approved in Relay, fast replies.']) })));
const out = { sample: true, accountsCheckedAt: new Date(Date.now() - 9 * 3600000).toISOString(), generatedAt: new Date().toISOString(), campaigns, slack, audits };
fs.writeFileSync(path.join(__dirname, '..', 'public', 'state.json'), JSON.stringify(out));
console.log('wrote sample', campaigns.map(c => c.name + ':' + c.creators.length + '/' + c.unanswered.length).join(' '));
