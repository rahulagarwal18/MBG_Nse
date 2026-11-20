// NSE market data: batched live quotes, exchange clock (holidays/special sessions aware), history.
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

// { SYMBOL: {price, prevClose, open, high, low, volume, changePct, time} } keyed by plain NSE symbol
export async function getQuotes(symbols) {
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
  const d = await getJSON(`/v8/finance/chart/${encodeURIComponent(INDEX)}?range=1d&interval=5m`);
  const m = d.chart.result[0].meta;
  const p = m.currentTradingPeriod.regular;
  const now = Math.floor(Date.now() / 1000);
  return {
    now, isOpen: now >= p.start && now < p.end,
    openTs: p.start, closeTs: p.end,
    minutesSinceOpen: (now - p.start) / 60,
    minutesToClose: (p.end - now) / 60,
    sessionDate: istDate(p.start),
    index: { name: 'NIFTY 50', price: m.regularMarketPrice, prevClose: m.chartPreviousClose,
      changePct: m.chartPreviousClose ? (m.regularMarketPrice / m.chartPreviousClose - 1) * 100 : 0 },
  };
}

export async function getHistory(symbol, range = '6mo', interval = '1d') {
  const d = await getJSON(`/v8/finance/chart/${encodeURIComponent(ysym(symbol))}?range=${range}&interval=${interval}`, 2);
  const r = d.chart.result[0];
  const q = r.indicators.quote[0];
  return (r.timestamp || []).map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] }))
    .filter(b => b.o != null && b.c != null);
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
