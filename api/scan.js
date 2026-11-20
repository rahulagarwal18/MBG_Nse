// Read-only market snapshot: the gap filter on the latest NIFTY 500 quotes, plus movers and sector breadth.
import { SYMBOLS, INFO } from '../lib/universe.js';
import { getQuotes, istTime, istDate } from '../lib/market.js';
import { filterGappers } from '../lib/engine.js';

const r2 = n => Math.round(n * 100) / 100;

export default async function handler(req, res) {
  try {
    const t0 = Date.now();
    const quotes = await getQuotes(SYMBOLS);
    const survivors = filterGappers(quotes);
    const asOf = Math.max(...Object.values(quotes).map(q => q.time || 0));
    const sorted = Object.entries(quotes).sort((a, b) => b[1].changePct - a[1].changePct);
    const by = {};
    for (const [s, q] of Object.entries(quotes)) { const k = INFO[s]?.[1] || 'Other'; (by[k] ||= []).push(q.changePct); }
    const sectors = Object.entries(by).map(([k, l]) => ({ k, n: l.length, c: r2(l.reduce((a, b) => a + b, 0) / l.length) })).sort((a, b) => b.c - a.c);
    const all = Object.values(quotes);
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      asOf, date: istDate(asOf), label: `${istTime(asOf)} IST`, total: all.length,
      count: survivors.length, survivors: survivors.slice(0, 15),
      gainers: sorted.slice(0, 8).map(([sym, q]) => ({ sym, chg: r2(q.changePct) })),
      losers: sorted.slice(-8).reverse().map(([sym, q]) => ({ sym, chg: r2(q.changePct) })),
      breadth: { adv: all.filter(q => q.changePct > 0).length, dec: all.filter(q => q.changePct < 0).length },
      sectors, secs: Math.round((Date.now() - t0) / 100) / 10,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
