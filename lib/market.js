// NSE market data: multi-source live quotes, exchange clock (holidays/special sessions aware), history.
import { nseEquitySnapshot, nseCall, istToEpoch, NSE_LIVE } from './nse.js';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
export const TZ = 'Asia/Kolkata';
export const INDEX = '^NSEI';

export const ysym = s => (s.startsWith('^') || s.endsWith('.NS') ? s : `${s}.NS`);
export const plain = s => s.replace(/\.NS$/, '');

async function getJSON(path, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(HOSTS[i % HOSTS.length] + path, { headers: UA, cache: 'no-store' });
      if (r.ok) return await r.json();
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
    await new Promise(res => setTimeout(res, 300 * (i + 1)));
  }
  throw lastErr;
}

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i]); } catch { out[i] = null; }
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Multi-source quotes: NSE official feed is primary; the secondary feed fills gaps and cross-checks.
// Each quote carries `source` ('NSE' | 'backup') and `check` (secondary price + % difference).
const TOLERANCE_PCT = 0.5;
const STALE_SEC = 15 * 60;
let lastQuality = null;
export const getDataQuality = () => lastQuality;

export async function getQuotes(symbols) {
  const list = [...new Set(symbols.map(plain))];
  const t0 = Date.now();
  const [nseRes, yRes] = await Promise.allSettled([nseEquitySnapshot(list), yahooQuotes(list)]);
  const nse = nseRes.status === 'fulfilled' ? nseRes.value.stocks : {};
  const yh = yRes.status === 'fulfilled' ? yRes.value : {};
  const now = Math.floor(Date.now() / 1000);
  const out = {};
  let fromNse = 0, fromBackup = 0, checked = 0, agree = 0, newestNse = 0, newerTicks = 0;
  const mismatches = [];
  for (const s of list) {
    const n = nse[s], y = yh[s];
    const nt = n ? istToEpoch(n.latestTimestamp) : null;
    const nseOk = n && n.lastTradedPrice > 0 && n.preClosePrice > 0;
    const nseFresh = nseOk && (!y || !nt || !y.time || nt >= y.time - STALE_SEC);
    if (nseOk && nseFresh) {
      // Reference fields (open, high, low, previous close) always come from NSE.
      // Last price: NSE's, unless the second feed has a newer tick that agrees with it (sanity band 2%).
      let price = n.lastTradedPrice, time = nt || now, priceFrom = 'NSE';
      let diff = null;
      if (y?.price) {
        diff = Math.abs(y.price - n.lastTradedPrice) / n.lastTradedPrice * 100;
        checked++;
        if (diff <= TOLERANCE_PCT) agree++; else mismatches.push({ symbol: s, nse: n.lastTradedPrice, backup: y.price, diffPct: Math.round(diff * 1000) / 1000 });
        if (y.time && nt && y.time > nt + 5 && diff <= 2) { price = y.price; time = y.time; priceFrom = 'newer tick'; newerTicks++; }
      }
      const q = {
        price, prevClose: n.preClosePrice,
        open: n.openPrice > 0 ? n.openPrice : price,
        high: Math.max(n.highPrice > 0 ? n.highPrice : price, price), low: Math.min(n.lowPrice > 0 ? n.lowPrice : price, price),
        volume: n.volume ?? 0, changePct: (price / n.preClosePrice - 1) * 100, time,
        w52h: n.fiftyTwoWeekHigh, w52l: n.fiftyTwoWeekLow, chg30d: n.perChange30d, source: 'NSE', priceFrom,
      };
      if (diff != null) q.check = { nse: n.lastTradedPrice, backup: y.price, diffPct: Math.round(diff * 1000) / 1000, ok: diff <= TOLERANCE_PCT };
      out[s] = q; fromNse++; newestNse = Math.max(newestNse, nt || 0);
    } else if (y) {
      out[s] = { ...y, source: 'backup', ...(nseOk ? { check: { nse: n.lastTradedPrice, note: 'NSE value older than backup' } } : {}) };
      fromBackup++;
    }
  }
  if (list.length >= 50) {
    lastQuality = {
      at: now, requested: list.length, received: Object.keys(out).length, primary: fromNse, backup: fromBackup, newerTicks,
      crossChecked: checked, agreePct: checked ? Math.round(agree / checked * 1000) / 10 : null, tolerancePct: TOLERANCE_PCT,
      nseAsOf: newestNse || null, nseStatus: nseRes.status === 'fulfilled' ? 'ok' : `unavailable: ${String(nseRes.reason?.message || nseRes.reason).slice(0, 80)}`,
      backupStatus: yRes.status === 'fulfilled' ? 'ok' : 'unavailable', mismatches: mismatches.sort((a, b) => b.diffPct - a.diffPct).slice(0, 10),
      ms: Date.now() - t0,
    };
  }
  return out;
}

// Secondary feed (also used for intraday history and the exchange calendar).
export async function yahooQuotes(symbols) {
  const list = [...new Set(symbols.map(ysym))];
  const groups = [];
  for (let i = 0; i < list.length; i += 20) groups.push(list.slice(i, i + 20));
  const res = await pool(groups, 8, g => getJSON(`/v7/finance/spark?symbols=${encodeURIComponent(g.join(','))}&range=1d&interval=5m`));
  const quotes = {};
  for (const r of res) {
    for (const item of r?.spark?.result || []) {
      const resp = item.response?.[0];
      const m = resp?.meta;
      if (!m || m.regularMarketPrice == null) continue;
      const closes = resp.indicators?.quote?.[0]?.close || [];
      const firstBar = closes.find(v => v != null);
      const prevClose = m.chartPreviousClose ?? m.previousClose;
      const price = m.regularMarketPrice;
      quotes[plain(item.symbol)] = {
        price, prevClose,
        open: firstBar ?? price,
        high: m.regularMarketDayHigh ?? price,
        low: m.regularMarketDayLow ?? price,
        volume: m.regularMarketVolume ?? 0,
        changePct: prevClose ? (price / prevClose - 1) * 100 : 0,
        time: m.regularMarketTime,
        w52h: m.fiftyTwoWeekHigh, w52l: m.fiftyTwoWeekLow,
      };
    }
  }
  return quotes;
}

export async function getClock() {
  const [yd, nx] = await Promise.allSettled([
    getJSON(`/v8/finance/chart/${encodeURIComponent(INDEX)}?range=1d&interval=5m`),
    nseCall(NSE_LIVE, 'cm_get_index_quote', { indexName: 'NIFTY 50' }, 8000),
  ]);
  if (yd.status !== 'fulfilled') throw yd.reason;
  const m = yd.value.chart.result[0].meta;
  const p = m.currentTradingPeriod.regular;
  const now = Math.floor(Date.now() / 1000);
  const ni = nx.status === 'fulfilled' ? nx.value.index : null;
  const index = ni && ni.last > 0
    ? { name: 'NIFTY 50', price: ni.last, prevClose: ni.previousClose, changePct: ni.percChange, high: ni.high, low: ni.low, source: 'NSE' }
    : { name: 'NIFTY 50', price: m.regularMarketPrice, prevClose: m.chartPreviousClose,
        changePct: m.chartPreviousClose ? (m.regularMarketPrice / m.chartPreviousClose - 1) * 100 : 0, source: 'backup' };
  return {
    now, isOpen: now >= p.start && now < p.end,
    openTs: p.start, closeTs: p.end,
    minutesSinceOpen: (now - p.start) / 60,
    minutesToClose: (p.end - now) / 60,
    sessionDate: istDate(p.start),
    index,
  };
}

export async function getHistory(symbol, range = '6mo', interval = '1d') {
  const d = await getJSON(`/v8/finance/chart/${encodeURIComponent(ysym(symbol))}?range=${range}&interval=${interval}`, 2);
  const r = d.chart.result[0];
  const q = r.indicators.quote[0];
  return (r.timestamp || []).map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] }))
    .filter(b => b.o != null && b.c != null);
}

// Live USD/INR rate (used to size the $10,000 demo account in rupees).
export async function getFx() {
  try {
    const d = await getJSON(`/v8/finance/chart/${encodeURIComponent('INR=X')}?range=1d&interval=1d`, 2);
    const v = d.chart.result[0].meta.regularMarketPrice;
    if (v > 50 && v < 200) return Math.round(v * 100) / 100;
  } catch { /* fall through */ }
  return 88;
}

export async function getIntraday60d(group) {
  return getJSON(`/v7/finance/spark?symbols=${encodeURIComponent(group.map(ysym).join(','))}&range=60d&interval=5m`);
}

const _dc = new Map();
export function istDate(ts) {
  const h = Math.floor(ts / 1800);
  let d = _dc.get(h);
  if (!d) { d = new Date(h * 1800 * 1000).toLocaleDateString('en-CA', { timeZone: TZ }); _dc.set(h, d); }
  return d;
}
export function istTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}
