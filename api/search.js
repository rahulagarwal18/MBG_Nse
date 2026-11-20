// Search every NSE-listed stock (NIFTY 500 + all others incl. SME) by name or symbol.
import { INFO } from '../lib/universe.js';
import { nseCall, NSE_HIST } from '../lib/nse.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

export default async function handler(req, res) {
  const q = String(req.query.q || '').trim().slice(0, 40);
  if (q.length < 2) return res.status(200).json([]);
  const k = q.toLowerCase();
  const out = new Map();
  const add = (s, n, i, px) => { if (!s) return; const cur = out.get(s) || {}; out.set(s, { s, n: cur.n || n || null, i: cur.i || i || null, px: cur.px ?? px ?? null }); };
  for (const [s, [n, i]] of Object.entries(INFO)) if (s.toLowerCase().includes(k) || n.toLowerCase().includes(k)) add(s, n, i);
  const [nse, yh] = await Promise.allSettled([
    nseCall(NSE_HIST, 'search_symbols', { query: q }, 6000),
    fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0`, { headers: UA }).then(r => r.json()),
  ]);
  const names = {};
  if (yh.status === 'fulfilled') for (const x of yh.value.quotes || []) {
    if (x.quoteType !== 'EQUITY' || !/\.NS$/.test(x.symbol || '')) continue;
    const s = x.symbol.replace(/\.NS$/, '').replace(/-SM$/, '');
    names[s] = x.longname || x.shortname; add(s, names[s], x.sector);
  }
  if (nse.status === 'fulfilled') for (const r of nse.value.results || []) add(r.symbol, names[r.symbol], null, r.last_close);
  const list = [...out.values()].sort((a, b) => {
    const sa = a.s.toLowerCase().startsWith(k) ? 0 : 1, sb = b.s.toLowerCase().startsWith(k) ? 0 : 1;
    return sa - sb || (INFO[a.s] ? 0 : 1) - (INFO[b.s] ? 0 : 1) || a.s.localeCompare(b.s);
  }).slice(0, 12);
  res.setHeader('Cache-Control', 'public, s-maxage=3600');
  return res.status(200).json(list);
}
