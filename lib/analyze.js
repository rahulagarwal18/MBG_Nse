// Stock report: last 30 trading days + a statistical 5-day projection, its measured past accuracy,
// and a plain-language write-up from the AI analyst (numbers are computed here, never by the AI).
import { aiWrite } from './ai.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
const r2 = n => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const r1 = n => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10);
const cache = new Map();

async function chart(ysym, range = '1y') {
  let last;
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${host}/v8/finance/chart/${encodeURIComponent(ysym)}?range=${range}&interval=1d`, { headers: UA, cache: 'no-store' });
      if (!r.ok) { last = new Error('HTTP ' + r.status); continue; }
      const j = await r.json();
      const res = j.chart?.result?.[0];
      if (!res) { last = new Error('no data'); continue; }
      const q = res.indicators.quote[0];
      const bars = (res.timestamp || []).map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] }))
        .filter(b => b.c != null && b.h != null && b.l != null);
      return { bars, meta: res.meta };
    } catch (e) { last = e; }
  }
  throw last || new Error('history unavailable');
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const stdev = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const sma = (c, n) => (c.length >= n ? mean(c.slice(-n)) : null);
// Standard normal CDF (Abramowitz–Stegun)
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
// RSI with Wilder's smoothing (the standard definition used by charting platforms)
function rsi(c, n = 14) {
  if (c.length <= n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function nextWeekdays(fromTs, tz, n) {
  const out = [];
  let d = new Date(fromTs * 1000);
  while (out.length < n) {
    d = new Date(d.getTime() + 86400000);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
    if (wd !== 'Sat' && wd !== 'Sun') out.push(d.toLocaleDateString('en-CA', { timeZone: tz }));
  }
  return out;
}

const SHRINK = 0.5;        // pull the recent trend halfway toward zero (trends rarely persist in full)
const WINDOW = 30;         // trading days used for trend and volatility
const HORIZON = 5;         // days projected

export async function analyzeStock({ symbol, ysym, name, sector, currency, tz, live }) {
  const key = `${ysym}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;

  const { bars, meta } = await chart(ysym, '1y');
  if (bars.length < WINDOW + 20) throw new Error('Not enough price history for this stock.');
  // Use the verified live price for today's close when available.
  if (live?.price > 0) {
    const lastDay = new Date(bars[bars.length - 1].t * 1000).toLocaleDateString('en-CA', { timeZone: tz });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    if (lastDay === today) bars[bars.length - 1].c = live.price;
  }
  const closes = bars.map(b => b.c);
  const n = closes.length;
  const price = closes[n - 1];
  const win = bars.slice(-WINDOW);
  const base = closes[n - WINDOW - 1];
  const logr = [];
  for (let i = n - WINDOW; i < n; i++) logr.push(Math.log(closes[i] / closes[i - 1]));
  const mu = mean(logr), sigma = stdev(logr);
  const muS = mu * SHRINK;

  // Last 30 days
  const high30 = Math.max(...win.map(b => b.h)), low30 = Math.min(...win.map(b => b.l));
  const vols = win.map(b => b.v || 0);
  const avgVol = mean(vols.slice(0, -1).length ? vols.slice(0, -1) : vols);
  let peak = -Infinity, maxDD = 0;
  for (const b of win) { peak = Math.max(peak, b.c); maxDD = Math.max(maxDD, (peak - b.c) / peak); }
  const s5 = sma(closes, 5), s20 = sma(closes, 20), s50 = sma(closes, 50);
  const y52h = Math.max(...bars.map(b => b.h)), y52l = Math.min(...bars.map(b => b.l));
  const trend = s5 && s20 ? (s5 > s20 * 1.005 ? 'up' : s5 < s20 * 0.995 ? 'down' : 'sideways') : 'n/a';
  const metrics = {
    return30Pct: r2((price / base - 1) * 100),
    high30: r2(high30), low30: r2(low30),
    upDays: logr.filter(x => x > 0).length, downDays: logr.filter(x => x < 0).length,
    dailyVolatilityPct: r2(sigma * 100), annualVolatilityPct: r1(sigma * Math.sqrt(252) * 100),
    maxDrawdown30Pct: r2(maxDD * 100),
    sma5: r2(s5), sma20: r2(s20), sma50: r2(s50),
    priceVsSma20Pct: s20 ? r2((price / s20 - 1) * 100) : null,
    rsi14: r1(rsi(closes)), trend,
    avgVolume30: Math.round(avgVol), lastVolume: win[win.length - 1].v || 0,
    volumeVsAvg: avgVol ? r2((win[win.length - 1].v || 0) / avgVol) : null,
    week52High: r2(y52h), week52Low: r2(y52l),
    positionIn52wPct: y52h > y52l ? r1((price - y52l) / (y52h - y52l) * 100) : null,
  };

  // 5-day statistical projection
  const days = nextWeekdays(bars[n - 1].t, tz, HORIZON);
  const forecast = days.map((d, i) => {
    const k = i + 1, c = Math.log(price) + muS * k, s = sigma * Math.sqrt(k);
    return { date: d, expected: r2(Math.exp(c)), low68: r2(Math.exp(c - s)), high68: r2(Math.exp(c + s)), low95: r2(Math.exp(c - 1.96 * s)), high95: r2(Math.exp(c + 1.96 * s)) };
  });
  const probUp = phi((muS * HORIZON) / (sigma * Math.sqrt(HORIZON)));
  const outlook = probUp >= 0.55 ? 'leaning up' : probUp <= 0.45 ? 'leaning down' : 'no clear direction';

  // Honesty check: replay the exact same method over the past year
  let tests = 0, dirHits = 0, in68 = 0, in95 = 0, upPeriods = 0, signalled = 0;
  for (let t = WINDOW; t + HORIZON < n; t++) {
    const lr = [];
    for (let i = t - WINDOW + 1; i <= t; i++) lr.push(Math.log(closes[i] / closes[i - 1]));
    const m = mean(lr) * SHRINK, s = stdev(lr);
    const actual = Math.log(closes[t + HORIZON] / closes[t]);
    const exp = m * HORIZON, band = s * Math.sqrt(HORIZON);
    tests++;
    if (actual > 0) upPeriods++;
    if (Math.abs(actual - exp) <= band) in68++;
    if (Math.abs(actual - exp) <= 1.96 * band) in95++;
    const p = phi(exp / band);
    if (p >= 0.55 || p <= 0.45) { signalled++; if ((p >= 0.55) === (actual > 0)) dirHits++; }
  }
  const accuracy = {
    periodsTested: tests,
    directionCalls: signalled,
    directionHitPct: signalled ? r1(dirHits / signalled * 100) : null,
    alwaysUpBaselinePct: tests ? r1(upPeriods / tests * 100) : null,
    within68BandPct: tests ? r1(in68 / tests * 100) : null,
    within95BandPct: tests ? r1(in95 / tests * 100) : null,
  };

  const out = {
    symbol, name: name || meta?.longName || meta?.shortName || symbol, sector: sector || null, currency,
    asOf: new Date().toISOString(), price: r2(price),
    changePct: live?.changePct != null ? r2(live.changePct) : r2((price / closes[n - 2] - 1) * 100),
    priceSource: live?.source === 'NSE' ? 'NSE official' : 'market feed',
    metrics, probUpPct: r1(probUp * 100), outlook, forecast, accuracy,
    history: win.map(b => ({ date: new Date(b.t * 1000).toLocaleDateString('en-CA', { timeZone: tz }), open: r2(b.o), high: r2(b.h), low: r2(b.l), close: r2(b.c), volume: b.v || 0 })),
    method: `Trend = average daily change over the last ${WINDOW} trading days, pulled ${Math.round((1 - SHRINK) * 100)}% toward zero; ranges from the same period's volatility (68% = ±1σ, 95% = ±1.96σ). Accuracy = the same method replayed on every day of the past year.`,
  };

  const facts = {
    stock: `${out.name} (${symbol})`, sector: out.sector, currency, price: out.price, todayChangePct: out.changePct,
    last30Days: metrics, projection5Days: { outlook, probabilityHigherPct: out.probUpPct, day5Expected: forecast[4].expected, day5Likely68: [forecast[4].low68, forecast[4].high68], day5Wide95: [forecast[4].low95, forecast[4].high95] },
    measuredAccuracyPastYear: accuracy,
  };
  const ai = await aiWrite({
    system: 'You are a careful equity research assistant writing for someone with no finance background. Use ONLY the numbers in the JSON you are given; never invent news, events, targets, earnings or facts. Do not recommend buying, selling or holding. Explain jargon in a few words when you use it. Be honest that the 5-day projection is statistical and uncertain, and quote its measured past accuracy versus the simple baseline. Write plain text with exactly three short sections, each starting with its title on its own line: "Last 30 days", "Next 5 days (projection)", "Risks to watch". Maximum 170 words in total. No markdown symbols.',
    user: JSON.stringify(facts),
  });
  out.analysis = ai?.text || [
    'Last 30 days',
    `${out.name} moved ${metrics.return30Pct >= 0 ? 'up' : 'down'} ${Math.abs(metrics.return30Pct)}%, trading between ${metrics.low30} and ${metrics.high30}. The short-term trend is ${trend}, RSI is ${metrics.rsi14}.`,
    'Next 5 days (projection)',
    `Statistically ${outlook} (${out.probUpPct}% chance of being higher). Likely range on day 5: ${forecast[4].low68} to ${forecast[4].high68}.`,
    'Risks to watch',
    `Typical daily move is about ${metrics.dailyVolatilityPct}%. In the past year this method called direction right ${accuracy.directionHitPct ?? '–'}% of the time.`,
  ].join('\n');
  out.analysisBy = ai ? 'ai' : 'rules';

  cache.set(key, { at: Date.now(), data: out });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return out;
}
