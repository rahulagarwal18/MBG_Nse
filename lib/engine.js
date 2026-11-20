// Autonomous NSE intraday loop:
// 1. Scan NIFTY 500  2. Pull live quotes  3. Filter gappers  4. Execute w/ stop & target  5. Repeat
import { SYMBOLS } from './universe.js';
import { getQuotes, getClock, istTime, istDate } from './market.js';
import { readJSON, writeJSON } from './store.js';
import { notify } from './notify.js';
import { intradayCharges } from './charges.js';

export const CONFIG = {
  startCash: 1000000,      // ₹10,00,000 paper capital
  riskPct: 1,              // % of equity risked per trade
  maxPositions: 5,
  maxPositionPct: 20,      // max % of equity in one position
  minGapPct: 2.5,          // keep stocks up >= 2.5% on the day
  minOpenGapPct: 1.5,      // ...that opened >= 1.5% above previous close
  minPrice: 50,            // ₹
  stopMinPct: 2,           // stop distance bounds
  stopMaxPct: 5,
  targetR: 3,
  firstScanMin: 25,        // first scan 09:40 IST (after the opening auction & first volatility)
  scanEveryMin: 30,
  noEntriesLastMin: 60,    // no new entries after 14:30 IST
  flattenLastMin: 10,      // square-off by 15:20 IST (before broker auto square-off)
  slippagePct: 0.05,
};

const STATE = 'state.json';
const r2 = n => Math.round(n * 100) / 100;
export const inr = n => (n < 0 ? '-₹' : '₹') + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = n => (n < 0 ? '-₹' : '₹') + Math.round(Math.abs(n)).toLocaleString('en-IN');

export function filterGappers(quotes, cfg = CONFIG) {
  return Object.entries(quotes)
    .filter(([, q]) => q.changePct >= cfg.minGapPct && q.price >= cfg.minPrice &&
      q.open >= q.prevClose * (1 + cfg.minOpenGapPct / 100) && q.price >= q.open * 0.995)
    .map(([sym, q]) => ({ sym, chg: r2(q.changePct), price: r2(q.price) }))
    .sort((a, b) => b.chg - a.chg);
}

export function freshState() {
  const now = Math.floor(Date.now() / 1000);
  return {
    version: 1, market: 'NSE', currency: 'INR', createdAt: now,
    startCash: CONFIG.startCash, cash: CONFIG.startCash,
    positions: [], trades: [], scans: [],
    events: [{ t: now, type: 'system', text: `Desk online · ${inr0(CONFIG.startCash)} paper capital · NIFTY 500 universe` }],
    equity: [{ t: now, v: CONFIG.startCash }],
    charges: 0, lastScanSlot: null, lastTick: null, lastTickInfo: null,
  };
}

export async function loadState() { return (await readJSON(STATE)) || freshState(); }
export async function saveState(s) { return writeJSON(STATE, s); }

function log(state, type, text, alerts) {
  state.events.unshift({ t: Math.floor(Date.now() / 1000), type, text });
  state.events = state.events.slice(0, 400);
  if (alerts) alerts.push(text);
}

function equityOf(state, quotes) {
  let v = state.cash;
  for (const p of state.positions) v += p.qty * (quotes[p.sym]?.price ?? p.last ?? p.entry);
  return r2(v);
}

export function sizePosition({ price, low, equity, cash, cfg = CONFIG }) {
  const entry = r2(price * (1 + cfg.slippagePct / 100));
  let stop = Math.min((low ?? price) * 0.998, entry * (1 - cfg.stopMinPct / 100));
  stop = r2(Math.max(stop, entry * (1 - cfg.stopMaxPct / 100)));
  const R = r2(entry - stop);
  if (R <= 0) return null;
  let qty = Math.floor(equity * cfg.riskPct / 100 / R);
  qty = Math.min(qty, Math.floor(equity * cfg.maxPositionPct / 100 / entry), Math.floor((cash ?? equity) / entry));
  if (qty < 1) return null;
  return { entry, stop, R, qty, be: r2(entry + R), target: r2(entry + cfg.targetR * R), risk: r2(R * qty), value: r2(entry * qty) };
}

function closePosition(state, p, rawPrice, reason, alerts) {
  const px = r2(rawPrice * (1 - CONFIG.slippagePct / 100));
  const ch = intradayCharges(p.entry, px, p.qty);
  const gross = r2((px - p.entry) * p.qty);
  const pnl = r2(gross - ch.total);
  state.cash = r2(state.cash + px * p.qty - ch.total);
  state.charges = r2((state.charges || 0) + ch.total);
  state.positions = state.positions.filter(x => x.id !== p.id);
  const now = Math.floor(Date.now() / 1000);
  state.trades.unshift({
    id: p.id, sym: p.sym, qty: p.qty, entry: p.entry, exit: px, gross, charges: ch.total, pnl,
    pnlPct: r2((px / p.entry - 1) * 100), r: r2((px - p.entry) / p.R), reason,
    openedAt: p.openedAt, closedAt: now, date: istDate(now),
  });
  state.trades = state.trades.slice(0, 1000);
  log(state, 'exit', `${pnl >= 0 ? '🟢' : '🔴'} ${p.sym} ${reason} · ${p.qty} @ ${inr(px)} | Net ${pnl >= 0 ? '+' : ''}${inr(pnl)} (${r2((px - p.entry) / p.R)}R, charges ${inr(ch.total)})`, alerts);
}

export async function tick({ force = false } = {}) {
  const t0 = Date.now();
  const state = await loadState();
  const alerts = [];
  const clock = await getClock();
  const info = { at: clock.now, open: clock.isOpen, actions: [] };
  let changed = false;

  if (!clock.isOpen) {
    if (state.positions.length) {
      const q = await getQuotes(state.positions.map(p => p.sym));
      for (const p of [...state.positions]) closePosition(state, p, q[p.sym]?.price ?? p.last ?? p.entry, 'squared off at close', alerts);
      log(state, 'system', `🏁 Session closed · flat · equity ${inr(state.cash)}`, alerts);
      state.equity.push({ t: clock.now, v: state.cash });
      info.actions.push('flattened after close');
      changed = true;
    }
    state.lastTick = clock.now; state.lastTickInfo = info;
    if (changed || force) await saveState(state);
    for (const a of alerts) await notify(a);
    return { state, info, clock };
  }

  // Manage open positions
  if (state.positions.length) {
    const q = await getQuotes(state.positions.map(p => p.sym));
    for (const p of [...state.positions]) {
      const quote = q[p.sym];
      if (!quote) continue;
      const px = quote.price;
      p.last = px;
      if (px <= p.stop) { closePosition(state, p, Math.min(px, p.stop), p.stage === 'open' ? 'stopped out' : 'stop hit', alerts); continue; }
      if (px >= p.target) { closePosition(state, p, px, 'target hit', alerts); continue; }
      if (p.stage === 'open' && px >= p.be) {
        p.stop = p.entry; p.stage = 'breakeven';
        log(state, 'stop', `🔵 ${p.sym} stop → breakeven ${inr(p.entry)}`, alerts);
      }
      if (px >= p.entry + 2 * p.R) {
        const trail = r2(px - p.R);
        if (trail > p.stop) { p.stop = trail; p.stage = 'trailing'; log(state, 'stop', `🟣 ${p.sym} trailing stop raised → ${inr(trail)}`, alerts); }
      }
    }
    changed = true;
  }

  // Square-off window
  if (clock.minutesToClose <= CONFIG.flattenLastMin + 1 && state.positions.length) {
    const q = await getQuotes(state.positions.map(p => p.sym));
    for (const p of [...state.positions]) closePosition(state, p, q[p.sym]?.price ?? p.last, 'squared off 15:20', alerts);
    const today = state.trades.filter(t => t.date === clock.sessionDate);
    const day = r2(today.reduce((a, t) => a + t.pnl, 0));
    log(state, 'system', `🏁 Squared off before close · ${today.length} trades today · day net ${day >= 0 ? '+' : ''}${inr(day)}`, alerts);
    info.actions.push('flattened');
    changed = true;
  }

  // Scan → filter → execute
  const slot = Math.floor((clock.minutesSinceOpen - CONFIG.firstScanMin) / CONFIG.scanEveryMin);
  const slotKey = `${clock.sessionDate}#${slot}`;
  if (slot >= 0 && clock.minutesToClose > CONFIG.flattenLastMin + 1 && (state.lastScanSlot !== slotKey || force)) {
    const s0 = Date.now();
    const quotes = await getQuotes(SYMBOLS);
    const universe = Object.keys(quotes).length;
    const survivors = filterGappers(quotes);
    const secs = ((Date.now() - s0) / 1000).toFixed(1);
    const label = `${istTime(clock.now)} IST`;
    state.scans.unshift({ t: clock.now, label, total: universe, secs: Number(secs), survivors: survivors.slice(0, 15), count: survivors.length });
    state.scans = state.scans.slice(0, 40);
    state.lastScanSlot = slotKey;
    const lines = survivors.slice(0, 12).map(s => `• ${s.sym} +${s.chg.toFixed(2)}%`).join('\n');
    log(state, 'scan', `📊 Prefilter ${label}\n${survivors.length}/${universe} survivors • ${secs}s${lines ? '\n' + lines : ''}`, alerts);
    info.actions.push(`scan ${survivors.length}/${universe}`);
    changed = true;

    if (clock.minutesToClose > CONFIG.noEntriesLastMin) {
      const tradedToday = new Set(state.trades.filter(t => t.date === clock.sessionDate).map(t => t.sym));
      const held = new Set(state.positions.map(p => p.sym));
      for (const s of survivors) {
        if (state.positions.length >= CONFIG.maxPositions) break;
        if (held.has(s.sym) || tradedToday.has(s.sym)) continue;
        const q = quotes[s.sym];
        const plan = sizePosition({ price: q.price, low: q.low, equity: equityOf(state, quotes), cash: state.cash });
        if (!plan) continue;
        const pos = { id: `${s.sym}-${clock.now}`, sym: s.sym, qty: plan.qty, entry: plan.entry, stop: plan.stop, initStop: plan.stop,
          R: plan.R, be: plan.be, target: plan.target, stage: 'open', openedAt: clock.now, last: q.price, gap: s.chg };
        state.cash = r2(state.cash - plan.entry * plan.qty);
        state.positions.push(pos);
        held.add(s.sym);
        log(state, 'entry', `🟢 ${s.sym} entry filled\n${plan.qty} shares @ ${inr(plan.entry)} | Stop ${inr(plan.stop)} | Risk ${inr0(plan.risk)} | BE at ${inr(plan.be)} | Target ${inr(plan.target)}`, alerts);
        info.actions.push(`buy ${s.sym}`);
      }
    }
  }

  if (changed) {
    const marks = {};
    for (const p of state.positions) marks[p.sym] = { price: p.last ?? p.entry };
    state.equity.push({ t: clock.now, v: equityOf(state, marks) });
    if (state.equity.length > 4000) state.equity = state.equity.filter((_, i) => i % 2 === 0 || i > state.equity.length - 500);
  }
  state.lastTick = clock.now;
  info.ms = Date.now() - t0;
  state.lastTickInfo = info;
  if (changed || force) await saveState(state);
  for (const a of alerts) await notify(a);
  return { state, info, clock };
}
