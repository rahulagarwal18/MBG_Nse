// NSE MCP tool catalogue: definitions + handlers (shared by the MCP endpoint).
import { INFO, SYMBOLS } from './universe.js';
import { getQuotes, getClock, getHistory, istTime, getDataQuality } from './market.js';
import { nseCall, NSE_LIVE, NSE_HIST } from './nse.js';
import { CONFIG, filterGappers, loadState } from './engine.js';
import { intradayCharges, RATES } from './charges.js';
import { readJSON, writeJSON } from './store.js';
import { runBacktest } from './backtest.js';

const r2 = n => Math.round(n * 100) / 100;
const clean = s => String(s || '').trim().toUpperCase().replace(/\.NS$/, '');
const meta = s => ({ company: INFO[s]?.[0] ?? null, industry: INFO[s]?.[1] ?? null });
const quoteRow = (s, q) => ({ symbol: s, ...meta(s), price: r2(q.price), change_pct: r2(q.changePct), prev_close: r2(q.prevClose),
  open: r2(q.open), day_high: r2(q.high), day_low: r2(q.low), volume: q.volume, week52_high: q.w52h ?? null, week52_low: q.w52l ?? null,
  change_30d_pct: q.chg30d ?? null, as_of_ist: q.time ? istTime(q.time) : null, source: q.source === 'NSE' ? 'NSE official' : 'backup feed', last_price_from: q.priceFrom === 'newer tick' ? 'newer tick (verified vs NSE)' : (q.source === 'NSE' ? 'NSE' : 'backup'),
  cross_check: q.check ? (q.check.backup != null ? { backup_price: q.check.backup, diff_pct: q.check.diffPct, verified: q.check.ok } : q.check) : null });

let cache = { at: 0, quotes: null };
async function universeQuotes() {
  if (cache.quotes && Date.now() - cache.at < 60000) return cache.quotes;
  const q = await getQuotes(SYMBOLS);
  cache = { at: Date.now(), quotes: q };
  return q;
}

const RO = { readOnlyHint: true, openWorldHint: true };

export const TOOLS = [
  {
    name: 'market_status',
    title: 'NSE market status',
    description: 'Whether the NSE cash market is open now, today\'s session times (IST), minutes to open/close, and the NIFTY 50 level and change.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    async run() {
      const c = await getClock();
      return {
        exchange: 'NSE', is_open: c.isOpen, session_date: c.sessionDate,
        session_open_ist: istTime(c.openTs), session_close_ist: istTime(c.closeTs),
        minutes_since_open: r2(c.minutesSinceOpen), minutes_to_close: r2(c.minutesToClose),
        nifty50: { level: r2(c.index.price), prev_close: r2(c.index.prevClose), change_pct: r2(c.index.changePct) },
      };
    },
  },
  {
    name: 'get_quotes',
    title: 'Live NSE quotes',
    description: 'Live quotes for up to 50 NSE symbols (e.g. RELIANCE, TCS, HDFCBANK): price, % change, open/high/low, volume, 52-week range, company and industry.',
    inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50, description: 'NSE trading symbols' } }, required: ['symbols'], additionalProperties: false },
    annotations: RO,
    async run({ symbols }) {
      const list = [...new Set((symbols || []).map(clean))].slice(0, 50);
      const q = await getQuotes(list);
      return { quotes: list.filter(s => q[s]).map(s => quoteRow(s, q[s])), not_found: list.filter(s => !q[s]) };
    },
  },
  {
    name: 'scan_gappers',
    title: 'Gap-up scanner (NIFTY 500)',
    description: 'Runs the desk\'s gap-up momentum filter across all NIFTY 500 stocks right now: up at least min_change_pct on the day, opened above the previous close, and still holding above the open.',
    inputSchema: { type: 'object', properties: {
      min_change_pct: { type: 'number', minimum: 0, maximum: 20, description: `Default ${CONFIG.minGapPct}` },
      min_open_gap_pct: { type: 'number', minimum: 0, maximum: 20, description: `Default ${CONFIG.minOpenGapPct}` },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 25' } }, additionalProperties: false },
    annotations: RO,
    async run({ min_change_pct, min_open_gap_pct, limit = 25 } = {}) {
      const q = await universeQuotes();
      const cfg = { ...CONFIG, minGapPct: min_change_pct ?? CONFIG.minGapPct, minOpenGapPct: min_open_gap_pct ?? CONFIG.minOpenGapPct };
      const s = filterGappers(q, cfg);
      return { universe: Object.keys(q).length, survivors: s.length, filter: { min_change_pct: cfg.minGapPct, min_open_gap_pct: cfg.minOpenGapPct, min_price_inr: cfg.minPrice },
        results: s.slice(0, limit).map(x => quoteRow(x.sym, q[x.sym])) };
    },
  },
  {
    name: 'top_movers',
    title: 'Top gainers / losers',
    description: 'Top gainers or losers in the NIFTY 500 right now, optionally within one industry (e.g. "Information Technology", "Healthcare", "Financial Services").',
    inputSchema: { type: 'object', properties: {
      direction: { type: 'string', enum: ['gainers', 'losers'], description: 'Default gainers' },
      industry: { type: 'string', description: 'Optional industry filter (case-insensitive substring)' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10' } }, additionalProperties: false },
    annotations: RO,
    async run({ direction = 'gainers', industry, limit = 10 } = {}) {
      const q = await universeQuotes();
      let rows = Object.entries(q);
      if (industry) rows = rows.filter(([s]) => (INFO[s]?.[1] || '').toLowerCase().includes(String(industry).toLowerCase()));
      rows.sort((a, b) => direction === 'losers' ? a[1].changePct - b[1].changePct : b[1].changePct - a[1].changePct);
      return { direction, industry: industry || 'all', results: rows.slice(0, limit).map(([s, x]) => quoteRow(s, x)) };
    },
  },
  {
    name: 'sector_performance',
    title: 'Sector performance',
    description: 'Average % change, advancers/decliners and best/worst stock for every industry in the NIFTY 500, right now.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    async run() {
      const q = await universeQuotes();
      const by = {};
      for (const [s, x] of Object.entries(q)) {
        const ind = INFO[s]?.[1] || 'Other';
        (by[ind] ||= []).push({ s, c: x.changePct });
      }
      const rows = Object.entries(by).map(([ind, l]) => {
        l.sort((a, b) => b.c - a.c);
        return { industry: ind, stocks: l.length, avg_change_pct: r2(l.reduce((a, x) => a + x.c, 0) / l.length),
          advancers: l.filter(x => x.c > 0).length, decliners: l.filter(x => x.c < 0).length,
          best: { symbol: l[0].s, change_pct: r2(l[0].c) }, worst: { symbol: l[l.length - 1].s, change_pct: r2(l[l.length - 1].c) } };
      }).sort((a, b) => b.avg_change_pct - a.avg_change_pct);
      const all = Object.values(q);
      return { breadth: { advancers: all.filter(x => x.changePct > 0).length, decliners: all.filter(x => x.changePct < 0).length }, industries: rows };
    },
  },
  {
    name: 'get_history',
    title: 'Price history (OHLCV)',
    description: 'Historical OHLCV candles for an NSE symbol or index (^NSEI = NIFTY 50, ^NSEBANK = BANK NIFTY). Intraday intervals are limited to recent ranges.',
    inputSchema: { type: 'object', properties: {
      symbol: { type: 'string' },
      range: { type: 'string', enum: ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y'], description: 'Default 3mo' },
      interval: { type: 'string', enum: ['5m', '15m', '1h', '1d', '1wk'], description: 'Default 1d' } }, required: ['symbol'], additionalProperties: false },
    annotations: RO,
    async run({ symbol, range = '3mo', interval = '1d' }) {
      const s = String(symbol).trim().toUpperCase();
      const bars = await getHistory(s.startsWith('^') ? s : clean(s), range, interval);
      const rows = bars.slice(-500).map(b => ({ time: new Date(b.t * 1000).toISOString(), open: r2(b.o), high: r2(b.h), low: r2(b.l), close: r2(b.c), volume: b.v }));
      const first = rows[0]?.close, last = rows[rows.length - 1]?.close;
      return { symbol: s, ...meta(clean(s)), range, interval, bars: rows.length, change_pct: first ? r2((last / first - 1) * 100) : null, candles: rows };
    },
  },
  {
    name: 'search_symbol',
    title: 'Find NSE symbol',
    description: 'Search the NIFTY 500 by company name, symbol or industry (e.g. "tata", "bank", "pharma").',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run({ query, limit = 15 }) {
      const k = String(query).toLowerCase();
      const hits = SYMBOLS.filter(s => s.toLowerCase().includes(k) || INFO[s][0].toLowerCase().includes(k) || INFO[s][1].toLowerCase().includes(k));
      return { matches: hits.length, results: hits.slice(0, limit).map(s => ({ symbol: s, ...meta(s) })) };
    },
  },
  {
    name: 'intraday_charges',
    title: 'Intraday charges calculator',
    description: 'Full breakdown of Indian intraday equity charges for a round trip: brokerage, STT, exchange fee, SEBI fee, stamp duty, GST, net P&L and breakeven move per share.',
    inputSchema: { type: 'object', properties: { buy_price: { type: 'number', exclusiveMinimum: 0 }, sell_price: { type: 'number', exclusiveMinimum: 0 }, quantity: { type: 'integer', minimum: 1 } }, required: ['buy_price', 'sell_price', 'quantity'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run({ buy_price, sell_price, quantity }) {
      return { ...intradayCharges(buy_price, sell_price, quantity), rates: RATES };
    },
  },
  {
    name: 'position_size',
    title: 'Risk-based position size',
    description: 'How many shares to buy so that a stop-out loses exactly risk_pct of capital, capped by max position size. Returns quantity, capital used, ₹ at risk, breakeven and 3R target.',
    inputSchema: { type: 'object', properties: {
      entry: { type: 'number', exclusiveMinimum: 0 }, stop: { type: 'number', exclusiveMinimum: 0 },
      capital: { type: 'number', exclusiveMinimum: 0, description: `Default ₹${CONFIG.startCash.toLocaleString('en-IN')}` },
      risk_pct: { type: 'number', exclusiveMinimum: 0, maximum: 10, description: `Default ${CONFIG.riskPct}` },
      max_position_pct: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: `Default ${CONFIG.maxPositionPct}` } }, required: ['entry', 'stop'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run({ entry, stop, capital = CONFIG.startCash, risk_pct = CONFIG.riskPct, max_position_pct = CONFIG.maxPositionPct }) {
      if (stop >= entry) return { error: 'stop must be below entry for a long position' };
      const R = entry - stop;
      const byRisk = Math.floor(capital * risk_pct / 100 / R), byCap = Math.floor(capital * max_position_pct / 100 / entry);
      const qty = Math.max(0, Math.min(byRisk, byCap));
      return { quantity: qty, limited_by: byCap < byRisk ? 'max position size' : 'risk', capital_used: r2(qty * entry),
        risk_inr: r2(qty * R), risk_pct_of_capital: r2(qty * R / capital * 100), stop_distance_pct: r2(R / entry * 100),
        breakeven_stop_at: r2(entry + R), target_3r: r2(entry + 3 * R),
        round_trip_charges_at_target: qty ? intradayCharges(entry, entry + 3 * R, qty).total : 0 };
    },
  },
  {
    name: 'index_quote',
    title: 'Live index quote (NSE official)',
    description: 'Live value of any NSE index straight from NSE: last, previous close, change, open/high/low, 52-week range and 1-week/1-month/1-year comparisons. Examples: "NIFTY 50", "NIFTY BANK", "NIFTY IT", "INDIA VIX".',
    inputSchema: { type: 'object', properties: { index: { type: 'string', description: 'Exact NSE index name (case-insensitive). Default NIFTY 50' } }, additionalProperties: false },
    annotations: RO,
    async run({ index = 'NIFTY 50' } = {}) {
      const r = await nseCall(NSE_LIVE, 'cm_get_index_quote', { indexName: String(index) });
      return { source: 'NSE official', nse_time: r.nseTimestamp, ...r.index };
    },
  },
  {
    name: 'market_mood',
    title: 'Market mood & India VIX (NSE official)',
    description: 'Factual NSE market mood for a day: benchmark index moves, index and stock breadth, India VIX level and its 1-week/1-month trend and percentile.',
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'yyyy-MM-dd; omit for the latest available day' } }, additionalProperties: false },
    annotations: RO,
    async run({ date } = {}) {
      return { source: 'NSE official', ...(await nseCall(NSE_HIST, 'get_market_mood', date ? { date } : {})) };
    },
  },
  {
    name: 'corporate_actions',
    title: 'Corporate actions (NSE official)',
    description: 'Dividends, splits, bonuses, buybacks and other corporate actions for an NSE stock, from NSE, over a date range (default last 5 years).',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, from_date: { type: 'string', description: 'yyyy-MM-dd' }, to_date: { type: 'string', description: 'yyyy-MM-dd' } }, required: ['symbol'], additionalProperties: false },
    annotations: RO,
    async run({ symbol, from_date, to_date }) {
      const args = { symbol: clean(symbol) };
      if (from_date) args.fromDate = from_date;
      if (to_date) args.toDate = to_date;
      return { source: 'NSE official', ...meta(clean(symbol)), ...(await nseCall(NSE_HIST, 'get_corporate_actions', args)) };
    },
  },
  {
    name: 'week52_range',
    title: '52-week high / low (NSE official)',
    description: '52-week high and low with dates for an NSE stock, where the last close sits in that range, and distance from the high and low.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'], additionalProperties: false },
    annotations: RO,
    async run({ symbol }) {
      return { source: 'NSE official', ...meta(clean(symbol)), ...(await nseCall(NSE_HIST, 'get_52_week_high_low', { symbol: clean(symbol) })) };
    },
  },
  {
    name: 'index_valuation',
    title: 'Index valuation P/E, P/B, yield (NSE official)',
    description: 'P/E, P/B and dividend yield of an NSE index as published by NSE, with where today sits versus the look-back window. Examples: "Nifty 50", "Nifty Bank", "Nifty IT".',
    inputSchema: { type: 'object', properties: { index: { type: 'string', description: 'Default Nifty 50' }, months: { type: 'integer', minimum: 1, maximum: 60, description: 'Look-back window, default 24' } }, additionalProperties: false },
    annotations: RO,
    async run({ index = 'Nifty 50', months = 24 } = {}) {
      return { source: 'NSE official', ...(await nseCall(NSE_HIST, 'get_index_valuation', { indexName: String(index), months: Number(months) || 24 })) };
    },
  },
  {
    name: 'data_quality',
    title: 'Data quality & cross-check',
    description: 'How the latest NIFTY 500 prices were sourced: how many came from NSE official vs the backup feed, how many were cross-checked, the % that agree within tolerance, the largest mismatches, and data freshness.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    async run() {
      if (!getDataQuality() || Date.now() / 1000 - getDataQuality().at > 120) await universeQuotes();
      const q = getDataQuality();
      return { ...q, nse_as_of_ist: q?.nseAsOf ? istTime(q.nseAsOf) : null };
    },
  },
  {
    name: 'desk_state',
    title: 'Autonomous desk: live state',
    description: 'The autonomous paper-trading desk: equity, cash, open positions with stops/targets, today\'s and recent trades (net of charges), and the latest scan.',
    inputSchema: { type: 'object', properties: { trades: { type: 'integer', minimum: 0, maximum: 100, description: 'Recent trades to include (default 20)' } }, additionalProperties: false },
    annotations: RO,
    async run({ trades = 20 } = {}) {
      const s = await loadState();
      const marks = s.positions.length ? await getQuotes(s.positions.map(p => p.sym)) : {};
      let eq = s.cash; for (const p of s.positions) eq += p.qty * (marks[p.sym]?.price ?? p.last ?? p.entry);
      const wins = s.trades.filter(t => t.pnl > 0).length;
      return {
        paper_capital: s.startCash, equity: r2(eq), cash: s.cash, total_pnl: r2(eq - s.startCash), total_pnl_pct: r2((eq / s.startCash - 1) * 100),
        charges_paid: s.charges || 0, closed_trades: s.trades.length, win_rate_pct: s.trades.length ? r2(wins / s.trades.length * 100) : null,
        open_positions: s.positions.map(p => ({ symbol: p.sym, qty: p.qty, entry: p.entry, last: r2(marks[p.sym]?.price ?? p.last), stop: p.stop, target: p.target, stage: p.stage,
          unrealized: r2(((marks[p.sym]?.price ?? p.last) - p.entry) * p.qty) })),
        recent_trades: s.trades.slice(0, trades), last_scan: s.scans[0] || null, last_heartbeat: s.lastTick ? new Date(s.lastTick * 1000).toISOString() : null,
      };
    },
  },
  {
    name: 'strategy_report',
    title: 'Strategy replay report',
    description: 'The desk\'s rules replayed on 5-minute data for the whole NIFTY 500 over the last ~60 sessions, net of all Indian charges: P&L, win rate, profit factor, drawdown, daily equity.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    async run() {
      const rep = await getReport();
      const { recent, ...rest } = rep;
      return { ...rest, recent_trades: recent.slice(0, 20) };
    },
  },
];

export async function getReport() {
  let rep = await readJSON('report.json');
  if (!rep || rep.v !== 1 || Date.now() / 1000 - rep.computedAt > 20 * 3600) {
    rep = await runBacktest();
    await writeJSON('report.json', rep);
  }
  return rep;
}
