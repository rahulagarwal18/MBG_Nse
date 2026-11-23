// Strategy report: replays the live rules on 5-minute data for the NIFTY 500 over the last ~60 sessions,
// including Indian intraday charges on every trade.
import { SYMBOLS } from './universe.js';
import { pool, istDate, getIntraday60d, plain } from './market.js';
import { CONFIG, sizePosition } from './engine.js';
import { intradayCharges } from './charges.js';

const r2 = n => Math.round(n * 100) / 100;
function idxAt(ts, t) {
  let lo = 0, hi = ts.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

export async function runBacktest({ startCash = CONFIG.startCash, fx = null } = {}) {
  const t0 = Date.now();
  const groups = [];
  for (let i = 0; i < SYMBOLS.length; i += 20) groups.push(SYMBOLS.slice(i, i + 20));
  const results = await pool(groups, 6, async g => { try { return await getIntraday60d(g); } catch { return null; } });

  const days = new Map(), sessions = new Map();
  let loaded = 0;
  for (const res of results) {
    for (const item of res?.spark?.result || []) {
      const x = item.response?.[0];
      const ts = x?.timestamp, cl = x?.indicators?.quote?.[0]?.close;
      if (!ts || !cl) continue;
      loaded++;
      const sym = plain(item.symbol);
      for (let i = 0; i < ts.length; i++) {
        if (cl[i] == null) continue;
        const d = istDate(ts[i]);
        if (!days.has(d)) days.set(d, new Map());
        const m = days.get(d);
        if (!m.has(sym)) m.set(sym, { ts: [], c: [] });
        const b = m.get(sym); b.ts.push(ts[i]); b.c.push(cl[i]);
        const s = sessions.get(d) || { open: Infinity, close: 0 };
        s.open = Math.min(s.open, ts[i]); s.close = Math.max(s.close, ts[i] + 300);
        sessions.set(d, s);
      }
    }
  }
  const dates = [...days.keys()].sort();
  let cash = startCash, peak = cash, maxDD = 0, maxDDPct = 0, totalCharges = 0;
  const curve = [], trades = [];
  const slip = CONFIG.slippagePct / 100;

  for (let di = 1; di < dates.length; di++) {
    const date = dates[di], bars = days.get(date), prevBars = days.get(dates[di - 1]);
    const { open, close } = sessions.get(date);
    if ((close - open) / 60 < 300) continue; // skip special/partial sessions
    let positions = [];
    const traded = new Set();
    const priceAt = (sym, t) => { const b = bars.get(sym); if (!b) return null; const i = idxAt(b.ts, t - 300); return i < 0 ? null : b.c[i]; };
    const equityAt = t => positions.reduce((a, p) => a + p.qty * (priceAt(p.sym, t) ?? p.entry), cash);
    const exit = (p, px, reason, t) => {
      const fill = px * (1 - slip);
      const ch = intradayCharges(p.entry, fill, p.qty);
      const pnl = (fill - p.entry) * p.qty - ch.total;
      cash += fill * p.qty - ch.total; totalCharges += ch.total;
      positions = positions.filter(x => x !== p);
      trades.push({ date, time: t, inTime: p.inTime, sym: p.sym, gap: p.gap, qty: p.qty, entry: r2(p.entry), exit: r2(fill), stop: r2(p.stop0),
        be: r2(p.be), target: r2(p.target), charges: ch.total, pnl: r2(pnl), r: r2((fill - p.entry) / p.R), reason });
    };
    const flatAt = close - (CONFIG.flattenLastMin + 1) * 60;
    for (let t = open + 600; t <= flatAt; t += 600) {
      for (const p of [...positions]) {
        const px = priceAt(p.sym, t); if (px == null) continue;
        if (px <= p.stop) { exit(p, Math.min(px, p.stop), p.stage === 'open' ? 'stopped out' : 'stop hit', t); continue; }
        if (px >= p.target) { exit(p, px, 'target hit', t); continue; }
        if (p.stage === 'open' && px >= p.be) { p.stop = p.entry; p.stage = 'breakeven'; }
        if (px >= p.entry + 2 * p.R && px - p.R > p.stop) { p.stop = px - p.R; p.stage = 'trailing'; }
      }
      const since = (t - open) / 60, toClose = (close - t) / 60;
      if (since >= CONFIG.firstScanMin && ((since - CONFIG.firstScanMin) % CONFIG.scanEveryMin) < 10 && toClose > CONFIG.noEntriesLastMin) {
        const surv = [];
        for (const [sym, b] of bars) {
          const pb = prevBars?.get(sym); if (!pb) continue;
          const prev = pb.c[pb.c.length - 1];
          const i = idxAt(b.ts, t - 300); if (i < 0) continue;
          const price = b.c[i], o = b.c[0];
          let low = Infinity, high = -Infinity;
          for (let k = 0; k <= i; k++) { if (b.c[k] < low) low = b.c[k]; if (b.c[k] > high) high = b.c[k]; }
          const chg = (price / prev - 1) * 100;
          if (chg >= CONFIG.minGapPct && price >= CONFIG.minPrice && o >= prev * (1 + CONFIG.minOpenGapPct / 100) && price >= o * 0.995 &&
            (!CONFIG.maxGapPct || chg <= CONFIG.maxGapPct) && (!CONFIG.pullbackPct || price <= high * (1 - CONFIG.pullbackPct / 100)))
            surv.push({ sym, chg, price, low });
        }
        surv.sort((a, b) => b.chg - a.chg);
        for (const s of surv) {
          if (positions.length >= CONFIG.maxPositions) break;
          if (traded.has(s.sym)) continue;
          const plan = sizePosition({ price: s.price, low: s.low, equity: equityAt(t), cash });
          if (!plan) continue;
          cash -= plan.entry * plan.qty;
          positions.push({ sym: s.sym, gap: r2(s.chg), qty: plan.qty, entry: plan.entry, stop: plan.stop, stop0: plan.stop, R: plan.R,
            be: plan.be, target: plan.target, stage: 'open', inTime: t });
          traded.add(s.sym);
        }
      }
    }
    for (const p of [...positions]) exit(p, priceAt(p.sym, flatAt + 60) ?? p.entry, 'squared off 15:20', flatAt);
    peak = Math.max(peak, cash);
    if (peak - cash > maxDD) { maxDD = peak - cash; maxDDPct = (peak - cash) / peak * 100; }
    curve.push({ date, v: r2(cash) });
  }
  const wins = trades.filter(t => t.pnl > 0).length;
  const gw = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const gl = -trades.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  return {
    v: 4, fx, startUsd: fx ? CONFIG.startUsd : null, computedAt: Math.floor(Date.now() / 1000), method: '5-minute replay of live rules incl. charges',
    from: curve[0]?.date, to: curve[curve.length - 1]?.date, sessions: curve.length, universe: loaded,
    startCash, totalPnl: r2(cash - startCash), totalPct: r2((cash / startCash - 1) * 100),
    trades: trades.length, wins, winRate: trades.length ? r2(wins / trades.length * 100) : 0,
    avgWin: wins ? r2(gw / wins) : 0, avgLoss: trades.length - wins ? r2(-gl / (trades.length - wins)) : 0,
    profitFactor: gl ? r2(gw / gl) : null, charges: r2(totalCharges),
    maxDD: r2(maxDD), maxDDPct: r2(maxDDPct), curve, recent: trades.slice(-80).reverse(),
    secs: r2((Date.now() - t0) / 1000),
  };
}
