// Automated NSE intraday loop with human approval:
// 1. Scan NIFTY 500  2. Pull live quotes  3. Filter gappers  4. Propose → human approves → execute  5. Repeat
// Exits (stop, breakeven, trailing stop, target, 15:20 square-off) are automatic risk controls.
import { SYMBOLS } from './universe.js';
import { getQuotes, getClock, istTime, istDate, getFx } from './market.js';
import { readJSON, writeJSON } from './store.js';
import { notify } from './notify.js';
import { intradayCharges } from './charges.js';
import { INFO } from './universe.js';

export const CONFIG = {
  startUsd: 10000,         // $10,000 demo account, held in INR at the live USD/INR rate
  startCash: 880000,       // fallback INR capital (replaced by $10,000 × live rate on reset)
  riskPct: 1,              // % of equity risked per trade
  maxPositions: 5,
  maxPositionPct: 20,      // max % of equity in one position
  minGapPct: 2,            // keep stocks up >= 2% on the day
  minOpenGapPct: 1,        // ...that opened >= 1% above previous close
  maxGapPct: 6,            // skip gaps above 6% (they faded most often in the replay)
  pullbackPct: 1,          // buy the dip: only once the price is >= 1% below today's high (don't chase the top)
  minPrice: 50,            // ₹
  stopMinPct: 2,
  stopMaxPct: 5,
  targetR: 3,
  firstScanMin: 25,        // first scan 09:40 IST
  scanEveryMin: 30,
  noEntriesLastMin: 60,    // no new entries after 14:30 IST
  flattenLastMin: 10,      // square-off by 15:20 IST
  slippagePct: 0.05,
  approval: true,          // every entry needs a human approval
  approvalDriftPct: 1,     // refuse if price ran > 1% above the proposal
};

const STATE = 'state.json';
const r2 = n => Math.round(n * 100) / 100;
const now = () => Math.floor(Date.now() / 1000);
export const inr = n => (n < 0 ? '-₹' : '₹') + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = n => (n < 0 ? '-₹' : '₹') + Math.round(Math.abs(n)).toLocaleString('en-IN');

export function filterGappers(quotes, cfg = CONFIG) {
  return Object.entries(quotes)
    .filter(([, q]) => q.changePct >= cfg.minGapPct && q.price >= cfg.minPrice &&
      q.open >= q.prevClose * (1 + cfg.minOpenGapPct / 100) && q.price >= q.open * 0.995 &&
      (!cfg.maxGapPct || q.changePct <= cfg.maxGapPct) &&
      (!cfg.pullbackPct || (q.high > 0 && q.price <= q.high * (1 - cfg.pullbackPct / 100))))
    .map(([sym, q]) => ({ sym, chg: r2(q.changePct), price: r2(q.price) }))
    .sort((a, b) => b.chg - a.chg);
}

export async function freshState() {
  const t = now();
  const fx = await getFx();
  const cash = Math.round(CONFIG.startUsd * fx);
  return {
    version: 2, market: 'NSE', currency: 'INR', createdAt: t,
    fx, startUsd: CONFIG.startUsd, startCash: cash, cash,
    positions: [], trades: [], scans: [], pending: [], decisions: [],
    events: [{ t, type: 'system', text: `Desk online · $${CONFIG.startUsd.toLocaleString()} demo account (${inr0(cash)} at ₹${fx}/$) · NIFTY 500 · human approval on` }],
    equity: [{ t, v: cash }],
    charges: 0, lastScanSlot: null, lastTick: null, lastTickInfo: null,
  };
}

// Approver names stay in private storage (audit trail) but are never published:
// every public output (dashboard API, MCP tools) goes through this.
export function publicState(s) {
  const c = structuredClone(s);
  for (const x of [...(c.positions || []), ...(c.trades || [])]) if (x.approvedBy) x.approvedBy = 'Approver';
  for (const x of c.decisions || []) if (x.by) x.by = 'Approver';
  for (const e of c.events || []) e.text = String(e.text).replace(/\b(approved|rejected) by [^·\n]+?(?= ·|\n|$)/g, '$1');
  return c;
}

export async function loadState() {
  const s = (await readJSON(STATE)) || (await freshState());
  s.pending ||= []; s.decisions ||= [];
  s.fx ||= s.startCash / CONFIG.startUsd; s.startUsd ||= CONFIG.startUsd;
  return s;
}
export async function saveState(s) { return writeJSON(STATE, s); }

function log(state, type, text, alerts) {
  state.events.unshift({ t: now(), type, text });
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

function openPosition(state, sym, plan, gap, price, approvedBy) {
  const t = now();
  const pos = { id: `${sym}-${t}`, sym, qty: plan.qty, entry: plan.entry, stop: plan.stop, initStop: plan.stop,
    R: plan.R, be: plan.be, target: plan.target, stage: 'open', openedAt: t, last: price, gap, approvedBy: approvedBy || null };
  state.cash = r2(state.cash - plan.entry * plan.qty);
  state.positions.push(pos);
  return pos;
}

function closePosition(state, p, rawPrice, reason, alerts) {
  const px = r2(rawPrice * (1 - CONFIG.slippagePct / 100));
  const ch = intradayCharges(p.entry, px, p.qty);
  const gross = r2((px - p.entry) * p.qty);
  const pnl = r2(gross - ch.total);
  state.cash = r2(state.cash + px * p.qty - ch.total);
  state.charges = r2((state.charges || 0) + ch.total);
  state.positions = state.positions.filter(x => x.id !== p.id);
  const t = now();
  state.trades.unshift({
    id: p.id, sym: p.sym, qty: p.qty, entry: p.entry, exit: px, gross, charges: ch.total, pnl,
    pnlPct: r2((px / p.entry - 1) * 100), r: r2((px - p.entry) / p.R), reason,
    openedAt: p.openedAt, closedAt: t, date: istDate(t), approvedBy: p.approvedBy || null,
  });
  state.trades = state.trades.slice(0, 1000);
  log(state, 'exit', `${pnl >= 0 ? '🟢' : '🔴'} ${p.sym} ${reason} · ${p.qty} @ ${inr(px)} | Net ${pnl >= 0 ? '+' : ''}${inr(pnl)} (${r2((px - p.entry) / p.R)}R, charges ${inr(ch.total)})`, alerts);
}

function settle(state, p, status, extra = {}) {
  state.pending = state.pending.filter(x => x.id !== p.id);
  state.decisions.unshift({ id: p.id, sym: p.sym, price: p.price, qty: p.qty, stop: p.stop, target: p.target, risk: p.risk,
    proposedAt: p.createdAt, decidedAt: now(), status, ...extra });
  state.decisions = state.decisions.slice(0, 200);
}

function expirePending(state, reason, alerts, onlyDue = false) {
  let n = 0;
  for (const p of [...state.pending]) {
    if (onlyDue && now() < p.expiresAt) continue;
    settle(state, p, 'expired', { note: reason });
    log(state, 'decision', `⌛ ${p.sym} proposal expired · ${reason}`, alerts);
    n++;
  }
  return n;
}


// Plain-language reasons shown with every recommendation.
function buildReasons(sym, chg, q, plan, rank, count, universe, equity) {
  const M = inr;
  const openGap = (q.open / q.prevClose - 1) * 100;
  const aboveOpen = (q.price / q.open - 1) * 100;
  const fromHigh = q.high ? Math.max(0, (1 - q.price / q.high) * 100) : 0;
  const stopPct = (1 - plan.stop / plan.entry) * 100;
  const out = [
    count === 1 ? `Up ${chg.toFixed(2)}% today: the only stock out of ${universe} checked that passed every scan rule.` : `Up ${chg.toFixed(2)}% today: #${rank} strongest of the ${count} stocks that passed the scan (out of ${universe} checked).`,
    `Opened ${openGap.toFixed(2)}% above yesterday's close (${M(q.prevClose)} → ${M(q.open)}) and is still ${aboveOpen >= 0.05 ? aboveOpen.toFixed(2) + '% above' : 'holding'} the open, so the morning jump is holding.`,
    CONFIG.pullbackPct ? `Buying the dip: ${fromHigh.toFixed(2)}% below today's high of ${M(q.high)}, instead of chasing the top.`
      : fromHigh < 1.5 ? `Trading close to today's high of ${M(q.high)} (${fromHigh.toFixed(2)}% below it): buyers are still in control.` : `Trading ${fromHigh.toFixed(2)}% below today's high of ${M(q.high)}.`,
    `Safety stop at ${M(plan.stop)}, just under today's low of ${M(q.low)} (${stopPct.toFixed(1)}% below entry). If it is hit, the loss is about ${M(plan.risk)} (${(plan.risk / equity * 100).toFixed(1)}% of the account).`,
    `Target ${M(plan.target)} is 3× the risk (reward-to-risk 3 : 1). Once the price reaches ${M(plan.be)}, the stop moves up to the entry price so the trade can no longer lose.`,
  ];
  const info = INFO[sym];
  if (info) out.splice(1, 0, `${info[0]} · sector: ${info[1]}.`);
  if (q.w52h) { const d = (1 - q.price / q.w52h) * 100; out.push(d < 3 ? `Within ${d.toFixed(1)}% of its 52-week high (${M(q.w52h)}): strong longer-term trend.` : `${d.toFixed(1)}% below its 52-week high of ${M(q.w52h)}.`); }
  out.push(`Estimated Indian charges for the full round trip at target: ${M(intradayCharges(plan.entry, plan.target, plan.qty).total)} (already counted in every P&L shown).`);
  return out;
}

export async function tick({ force = false } = {}) {
  const t0 = Date.now();
  const state = await loadState();
  const alerts = [];
  const clock = await getClock();
  const info = { at: clock.now, open: clock.isOpen, actions: [] };
  let changed = false;

  if (!clock.isOpen) {
    if (state.pending.length) { expirePending(state, 'market closed', alerts); changed = true; }
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

  if (expirePending(state, 'no decision before the next scan', alerts, true)) changed = true;

  // Manage open positions (automatic risk controls)
  if (state.positions.length) {
    const q = await getQuotes(state.positions.map(p => p.sym));
    for (const p of [...state.positions]) {
      const quote = q[p.sym];
      if (!quote) continue;
      const px = quote.price;
      p.last = px;
      if (px <= p.stop) { closePosition(state, p, Math.min(px, p.stop), p.stage === 'open' ? 'stopped out' : 'stop hit', alerts); continue; }
      if (px >= p.target) { closePosition(state, p, px, 'target hit', alerts); continue; }
      if (p.stage === 'open' && px >= p.be) { p.stop = p.entry; p.stage = 'breakeven'; log(state, 'stop', `🔵 ${p.sym} stop → breakeven ${inr(p.entry)}`, alerts); }
      if (px >= p.entry + 2 * p.R) {
        const trail = r2(px - p.R);
        if (trail > p.stop) { p.stop = trail; p.stage = 'trailing'; log(state, 'stop', `🟣 ${p.sym} trailing stop raised → ${inr(trail)}`, alerts); }
      }
    }
    changed = true;
  }

  // Square-off window
  if (clock.minutesToClose <= CONFIG.flattenLastMin + 1) {
    if (state.pending.length) { expirePending(state, 'square-off window', alerts); changed = true; }
    if (state.positions.length) {
      const q = await getQuotes(state.positions.map(p => p.sym));
      for (const p of [...state.positions]) closePosition(state, p, q[p.sym]?.price ?? p.last, 'squared off 15:20', alerts);
      const today = state.trades.filter(t => t.date === clock.sessionDate);
      const day = r2(today.reduce((a, t) => a + t.pnl, 0));
      log(state, 'system', `🏁 Squared off before close · ${today.length} trades today · day net ${day >= 0 ? '+' : ''}${inr(day)}`, alerts);
      info.actions.push('flattened');
      changed = true;
    }
  }

  // Scan → filter → propose
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

    if (state.pending.length) expirePending(state, 'replaced by a newer scan', alerts);

    if (clock.minutesToClose > CONFIG.noEntriesLastMin) {
      const tradedToday = new Set(state.trades.filter(t => t.date === clock.sessionDate).map(t => t.sym));
      const held = new Set(state.positions.map(p => p.sym));
      const nextScan = clock.openTs + (CONFIG.firstScanMin + CONFIG.scanEveryMin * (slot + 1)) * 60;
      const expiresAt = Math.min(nextScan - 30, clock.closeTs - (CONFIG.flattenLastMin + 1) * 60);
      let slots = CONFIG.maxPositions - state.positions.length;
      let cash = state.cash;
      for (const s of survivors) {
        if (slots <= 0) break;
        if (held.has(s.sym) || tradedToday.has(s.sym)) continue;
        const q = quotes[s.sym];
        const plan = sizePosition({ price: q.price, low: q.low, equity: equityOf(state, quotes), cash });
        if (!plan) continue;
        if (CONFIG.approval) {
          const reasons = buildReasons(s.sym, s.chg, q, plan, survivors.indexOf(s) + 1, survivors.length, universe, equityOf(state, quotes));
          state.pending.push({ id: `${s.sym}-${clock.now}`, sym: s.sym, gap: s.chg, price: r2(q.price), ...plan, reasons, createdAt: clock.now, expiresAt });
          log(state, 'proposal', `🟡 ${s.sym} trade proposed · awaiting approval\n${plan.qty} shares @ ~${inr(plan.entry)} | Stop ${inr(plan.stop)} | Target ${inr(plan.target)} | Risk ${inr0(plan.risk)}`, alerts);
          info.actions.push(`propose ${s.sym}`);
        } else {
          const pos = openPosition(state, s.sym, plan, s.chg, q.price, null);
          log(state, 'entry', `🟢 ${s.sym} entry filled\n${pos.qty} shares @ ${inr(pos.entry)} | Stop ${inr(pos.stop)} | Risk ${inr0(plan.risk)} | BE at ${inr(pos.be)} | Target ${inr(pos.target)}`, alerts);
          info.actions.push(`buy ${s.sym}`);
        }
        cash -= plan.value;
        held.add(s.sym);
        slots--;
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

// Human decision on a proposed trade. Approval re-checks the live price before executing.
export async function decide({ id, action, by }) {
  const who = String(by || '').trim().slice(0, 40) || 'Approver';
  const state = await loadState();
  const alerts = [];
  const p = state.pending.find(x => x.id === id);
  if (!p) return { ok: false, error: 'This trade is no longer waiting (already decided or expired).' };

  if (action === 'reject') {
    settle(state, p, 'rejected', { by: who });
    log(state, 'decision', `⛔ ${p.sym} proposal rejected by ${who}`, alerts);
    await saveState(state);
    for (const a of alerts) await notify(a);
    return { ok: true, status: 'rejected', message: `${p.sym} rejected by ${who}. No trade placed.` };
  }
  if (action !== 'approve') return { ok: false, error: 'Unknown action.' };

  const clock = await getClock();
  const finish = async (status, note, message) => {
    settle(state, p, status, { note, by: who });
    log(state, 'decision', `⌛ ${p.sym} approval not executed · ${note}`, alerts);
    await saveState(state);
    for (const a of alerts) await notify(a);
    return { ok: false, status, error: message };
  };
  if (!clock.isOpen || clock.minutesToClose <= CONFIG.flattenLastMin + 1) return finish('expired', 'market closed', 'The market is closed, so this trade expired.');
  if (state.positions.length >= CONFIG.maxPositions) return finish('expired', 'no free position slot', `Already holding ${CONFIG.maxPositions} positions.`);
  const q = (await getQuotes([p.sym]))[p.sym];
  if (!q) return { ok: false, error: 'No live price right now. Please try again in a moment.' };
  const drift = (q.price / p.price - 1) * 100;
  if (drift > CONFIG.approvalDriftPct) return finish('expired', `price ran +${drift.toFixed(2)}% since the proposal`, `Price moved up ${drift.toFixed(2)}% since the proposal, too far to chase. Not executed.`);
  if (q.price <= p.stop) return finish('expired', 'price fell to the stop', 'Price already fell to the stop level. Not executed.');
  const plan = sizePosition({ price: q.price, low: q.low, equity: equityOf(state, { [p.sym]: q }), cash: state.cash });
  if (!plan) return finish('expired', 'could not size the trade', 'The trade could not be sized at the current price.');
  const pos = openPosition(state, p.sym, plan, p.gap, q.price, who);
  settle(state, p, 'approved', { fill: pos.entry, qty: pos.qty, by: who });
  log(state, 'entry', `✅ ${p.sym} approved by ${who} · filled\n${pos.qty} shares @ ${inr(pos.entry)} | Stop ${inr(pos.stop)} | Risk ${inr0(plan.risk)} | BE at ${inr(pos.be)} | Target ${inr(pos.target)}`, alerts);
  const marks = {}; for (const x of state.positions) marks[x.sym] = { price: x.last ?? x.entry };
  state.equity.push({ t: now(), v: equityOf(state, marks) });
  await saveState(state);
  for (const a of alerts) await notify(a);
  return { ok: true, status: 'approved', message: `Approved by ${who}. ${p.sym} bought: ${pos.qty} shares @ ${inr(pos.entry)}, stop ${inr(pos.stop)}, target ${inr(pos.target)}.` };
}
