// Visual overview for the desk dashboards (shared by the US and NSE desks; keep both copies identical).
// Draws theme-aware SVG charts from data the page already loads: /api/state, /api/report and /api/scan.
// Usage: Viz.render(containerEl, { state, clock, config, report, snap, marks, money, tz, tzLabel, market, universe })
(function () {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const C = { g: 'var(--green)', r: 'var(--red)', a: 'var(--accent)', a2: 'var(--accent2)', am: 'var(--amber)', m: 'var(--mute)', l: 'var(--line)', ink: 'var(--ink)', ink2: 'var(--ink2)' };
  const F = 'font-family="JetBrains Mono, monospace"';
  const pct = (n, d = 1) => (n > 0 ? '+' : '') + Number(n).toFixed(d) + '%';
  const sum = a => a.reduce((x, y) => x + y, 0);

  // ---------- primitives (all return SVG strings with a fixed viewBox; CSS scales them to the card) ----------
  function empty(msg, h = 180) { return `<div class="vz-empty" style="height:${h}px">${esc(msg)}</div>`; }

  function area(points, { W = 640, H = 220, base = null, fmtV = v => v, fmtX = p => '', neg = false } = {}) {
    if (!points || points.length < 2) return empty('Not enough data points yet.', H);
    const pl = 6, pr = 70, pt = 12, pb = 24;
    const vs = points.map(p => p.v);
    let lo = Math.min(...vs, base ?? Infinity), hi = Math.max(...vs, base ?? -Infinity);
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.01 || 1; lo -= pad; hi += pad;
    const x = i => pl + i / (points.length - 1) * (W - pl - pr), y = v => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    const last = vs[vs.length - 1];
    const col = neg ? C.r : last >= (base ?? vs[0]) ? C.g : C.r;
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const yb = base != null ? y(base) : H - pb;
    let grid = '';
    for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * i / 3; grid += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="${C.l}" stroke-dasharray="2 4"/><text x="${W - pr + 6}" y="${y(v) + 4}" fill="${C.m}" font-size="10.5" ${F}>${esc(fmtV(v))}</text>`; }
    let xl = ''; const n = Math.min(4, points.length);
    for (let i = 0; i < n; i++) { const k = Math.round(i * (points.length - 1) / Math.max(1, n - 1)); xl += `<text x="${x(k)}" y="${H - 6}" fill="${C.m}" font-size="10.5" ${F} text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(fmtX(points[k]))}</text>`; }
    const dots = points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="7" fill="transparent"><title>${esc(fmtX(p) + ' · ' + fmtV(p.v))}</title></circle>`).join('');
    return `<svg class="vz" viewBox="0 0 ${W} ${H}" role="img">${grid}
      ${base != null ? `<line x1="${pl}" x2="${W - pr}" y1="${yb}" y2="${yb}" stroke="${C.m}" opacity=".7"/>` : ''}
      <path d="${d}L${x(points.length - 1)},${yb}L${x(0)},${yb}Z" style="fill:${col}" opacity=".14"/>
      <path d="${d}" fill="none" style="stroke:${col}" stroke-width="2.4" stroke-linejoin="round"/>
      <circle cx="${x(points.length - 1)}" cy="${y(last)}" r="4.5" style="fill:${col}"/>
      <rect x="${W - pr + 2}" y="${y(last) - 10}" width="${pr - 4}" height="20" rx="4" style="fill:${col}"/>
      <text x="${W - pr + 6}" y="${y(last) + 4}" fill="#fff" font-size="10.5" font-weight="700" ${F}>${esc(fmtV(last))}</text>${xl}${dots}</svg>`;
  }

  function bars(items, { W = 640, H = 200, fmtV = v => v, label = true, colorOf = null } = {}) {
    if (!items.length) return empty('Nothing to show yet.', H);
    const pl = 6, pr = 6, pt = 14, pb = label ? 30 : 10;
    const vs = items.map(i => i.v), hi = Math.max(0, ...vs), lo = Math.min(0, ...vs), span = (hi - lo) || 1;
    const y = v => pt + (1 - (v - lo) / span) * (H - pt - pb), y0 = y(0);
    const bw = (W - pl - pr) / items.length, gap = Math.min(6, bw * 0.25);
    const barW = Math.min(bw - gap, 56); // a lone trade must not become one giant block
    const step = Math.ceil(items.length / 12);
    const out = items.map((it, i) => {
      const x = pl + i * bw + (bw - barW) / 2, top = Math.min(y(it.v), y0), h = Math.max(1.5, Math.abs(y(it.v) - y0));
      const col = colorOf ? colorOf(it) : it.v >= 0 ? C.g : C.r;
      const lab = label && i % step === 0 ? `<text x="${x + barW / 2}" y="${H - 10}" fill="${C.m}" font-size="10" ${F} text-anchor="middle">${esc(it.label)}</text>` : '';
      return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" style="fill:${col}"><title>${esc((it.title || it.label) + ' · ' + fmtV(it.v))}</title></rect>${lab}`;
    }).join('');
    return `<svg class="vz" viewBox="0 0 ${W} ${H}" role="img"><line x1="${pl}" x2="${W - pr}" y1="${y0}" y2="${y0}" stroke="${C.m}" opacity=".6"/>${out}</svg>`;
  }

  function hbars(items, { W = 640, rowH = 24, fmtV = v => v, labelW = 190, colorOf = null } = {}) {
    if (!items.length) return empty('Nothing to show yet.', 120);
    const H = items.length * rowH + 8, maxAbs = Math.max(...items.map(i => Math.abs(i.v)), 0.0001);
    const hasNeg = items.some(i => i.v < 0);
    const x0 = hasNeg ? labelW + (W - labelW - 60) / 2 : labelW, span = hasNeg ? (W - labelW - 60) / 2 : W - labelW - 60;
    const rows = items.map((it, i) => {
      const yy = 4 + i * rowH, w = Math.abs(it.v) / maxAbs * span, x = it.v >= 0 ? x0 : x0 - w;
      const col = colorOf ? colorOf(it) : it.v >= 0 ? C.g : C.r;
      // With negative bars, values sit in their own right-hand column so they never collide with the labels.
      const tx = hasNeg ? W - 2 : x0 + w + 6, anchor = hasNeg ? 'end' : 'start';
      return `<text x="${labelW - 8}" y="${yy + rowH / 2 + 4}" fill="${C.ink2}" font-size="12" text-anchor="end">${esc(it.label)}</text>
        <rect x="${x.toFixed(1)}" y="${yy + 4}" width="${Math.max(2, w).toFixed(1)}" height="${rowH - 9}" rx="3" style="fill:${col}"><title>${esc(it.label + ' · ' + fmtV(it.v))}</title></rect>
        <text x="${tx.toFixed(1)}" y="${yy + rowH / 2 + 4}" style="fill:${it.v >= 0 ? C.g : C.r}" font-size="11" font-weight="700" ${F} text-anchor="${anchor}">${esc(fmtV(it.v))}</text>`;
    }).join('');
    return `<svg class="vz" viewBox="0 0 ${W} ${H}" role="img">${hasNeg ? `<line x1="${x0}" x2="${x0}" y1="0" y2="${H}" stroke="${C.m}" opacity=".5"/>` : ''}${rows}</svg>`;
  }

  function donut(segs, { center = '', sub = '' } = {}) {
    const tot = sum(segs.map(s => s.v));
    if (!tot) return empty('No data yet.', 170);
    // Ring drawn as stroked circles (pathLength 100), so a single 100% segment still shows its hole.
    let off = 0, paths = '';
    for (const s of segs) {
      if (!s.v) continue;
      const frac = s.v / tot, len = frac * 100;
      paths += `<circle cx="80" cy="80" r="51" fill="none" stroke-width="22" pathLength="100" style="stroke:${s.color}" stroke-dasharray="${len.toFixed(3)} ${(100 - len).toFixed(3)}" stroke-dashoffset="${(25 - off).toFixed(3)}"><title>${esc(s.label)} · ${s.v} (${Math.round(frac * 100)}%)</title></circle>`;
      off += len;
    }
    const legend = segs.filter(s => s.v).map(s => `<div class="vz-leg"><i style="background:${s.color}"></i><span>${esc(s.label)}</span><b>${s.v}</b><em>${Math.round(s.v / tot * 100)}%</em></div>`).join('');
    return `<div class="vz-donut"><svg viewBox="0 0 160 160" class="vz-d" role="img">${paths}
      <text x="80" y="80" text-anchor="middle" font-size="22" font-weight="800" fill="${C.ink}">${esc(center)}</text>
      <text x="80" y="98" text-anchor="middle" font-size="10" fill="${C.m}" ${F}>${esc(sub)}</text></svg><div class="vz-legs">${legend}</div></div>`;
  }

  function funnel(stages) {
    const max = Math.max(...stages.map(s => s.v), 1);
    return `<div class="vz-funnel">${stages.map((s, i) => {
      const w = Math.max(6, Math.sqrt(s.v / max) * 100);
      return `<div class="vz-fs"><div class="vz-fl"><b>${esc(s.label)}</b><span>${esc(s.note || '')}</span></div>
        <div class="vz-ft"><div class="vz-fb" style="width:${w}%;background:${s.color || C.a};opacity:${1 - i * 0.1}"></div><strong>${s.v.toLocaleString()}</strong></div></div>`;
    }).join('')}</div>`;
  }

  function ladder(positions, marks, money) {
    if (!positions.length) return empty('No open trades right now. Each open trade appears here as a bar from its stop (left) to its target (right), with a dot for the live price.', 150);
    return `<div class="vz-ladder">${positions.map(p => {
      const px = marks[p.sym]?.price ?? p.last ?? p.entry, lo = p.initStop ?? p.stop, hi = p.target, f = v => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
      const qty = p.shares ?? p.qty, pnl = (px - p.entry) * qty, up = px >= p.entry;
      return `<div class="vz-lr"><div class="vz-ll"><b>${esc(p.sym)}</b><span class="${up ? 'pos' : 'neg'}">${pnl >= 0 ? '+' : ''}${money(pnl)}</span></div>
        <div class="vz-lt"><div class="vz-lz" style="left:0;width:${f(p.entry)}%;background:color-mix(in srgb,var(--red) 22%,transparent)"></div>
          <div class="vz-lz" style="left:${f(p.entry)}%;right:0;background:color-mix(in srgb,var(--green) 18%,transparent)"></div>
          <div class="vz-lm" style="left:${f(p.entry)}%" title="Entry ${money(p.entry)}"></div>
          ${p.stop > lo ? `<div class="vz-lm s" style="left:${f(p.stop)}%" title="Current stop ${money(p.stop)}"></div>` : ''}
          <div class="vz-ld ${up ? 'up' : 'dn'}" style="left:${f(px)}%" title="Live ${money(px)}"></div></div>
        <div class="vz-lx"><span>stop ${money(lo)}</span><span>entry ${money(p.entry)}</span><span>target ${money(hi)}</span></div></div>`;
    }).join('')}</div>`;
  }

  // ---------- page ----------
  const card = (title, sub, body, cls = '') => `<div class="card vz-card ${cls}"><div class="hd"><h3>${title}</h3>${sub ? `<span class="eyebrow">${sub}</span>` : ''}</div><div class="bd">${body}</div></div>`;
  const reasonColor = r => /target/.test(r) ? C.g : /stop/.test(r) ? C.r : /square|close|bell/.test(r) ? C.a : C.am;
  const decColor = { approved: C.g, rejected: C.r, expired: C.am };

  function render(el, o) {
    if (!el) return;
    const { state, clock, config, report, snap, marks = {}, money, tz, tzLabel = '', market = 'market', universe = 'stocks' } = o;
    if (!state) return;
    const dayOf = ts => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts * 1000);
    const hm = ts => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(ts * 1000);
    const md = ts => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(ts * 1000);
    const today = clock?.sessionDate || dayOf(Date.now() / 1000);
    const m0 = n => money(n, 0);

    // live numbers
    let eq = state.cash, unreal = 0;
    for (const p of state.positions) { const px = marks[p.sym]?.price ?? p.last ?? p.entry, q = p.shares ?? p.qty; eq += q * px; unreal += (px - p.entry) * q; }
    const tot = eq - state.startCash;
    const trades = state.trades || [];
    const wins = trades.filter(t => t.pnl > 0).length, losses = trades.length - wins;
    const decs = state.decisions || [];
    const decToday = decs.filter(d => dayOf(d.proposedAt || d.decidedAt) === today);
    const pendToday = (state.pending || []).filter(p => dayOf(p.createdAt) === today);
    const scanToday = (state.scans || []).find(s => dayOf(s.t) === today);
    const tradesToday = trades.filter(t => t.date === today);

    const S = [];

    // 1. Headline tiles
    const eqPts = [...(state.equity || [])]; if (state.positions.length) eqPts.push({ t: Date.now() / 1000, v: eq });
    const rep = report && report.curve?.length ? report : null;
    S.push(`<div class="vz-tiles">
      <div class="vz-tile"><div class="l">Account value</div><div class="v">${m0(eq)}</div><div class="s ${tot >= 0 ? 'pos' : 'neg'}">${tot >= 0 ? '+' : ''}${money(tot)} · ${pct(tot / state.startCash * 100, 2)} since start</div></div>
      <div class="vz-tile"><div class="l">Closed trades</div><div class="v">${trades.length}</div><div class="s">${wins} won · ${losses} lost${trades.length ? ' · ' + Math.round(wins / trades.length * 100) + '% win rate' : ''}</div></div>
      <div class="vz-tile"><div class="l">Today</div><div class="v">${tradesToday.length + state.positions.length}</div><div class="s">${state.positions.length} open · ${tradesToday.length} closed · ${pendToday.length} waiting for approval</div></div>
      <div class="vz-tile ${rep && rep.totalPct < 0 ? 'warn' : ''}"><div class="l">Strategy replay</div><div class="v ${rep ? (rep.totalPct >= 0 ? 'pos' : 'neg') : ''}">${rep ? pct(rep.totalPct, 2) : '—'}</div><div class="s">${rep ? `${rep.sessions} sessions · ${rep.trades} trades · ${Math.round(rep.winRate)}% won` : 'loading…'}</div></div>
    </div>`);

    // 2. Funnel + human decisions
    const scansToday = (state.scans || []).filter(s => dayOf(s.t) === today);
    const proposed = decToday.length + pendToday.length, approved = decToday.filter(d => d.status === 'approved').length;
    const total = scanToday?.total ?? snap?.total ?? 0;
    // "Passed" = distinct stocks that passed any scan today (each scan lists its top survivors), never fewer than were proposed.
    const passedSet = new Set(); for (const s of scansToday) for (const x of s.survivors || []) passedSet.add(x.sym);
    const passed = scansToday.length ? Math.max(passedSet.size, ...scansToday.map(s => s.count || 0), proposed) : snap?.count ?? 0;
    const funnelBody = funnel([
      { label: `Scanned`, note: `every ${universe} stock`, v: total, color: C.a },
      { label: 'Passed the filter', note: scansToday.length ? `gap-up rules · ${scansToday.length} scan${scansToday.length > 1 ? 's' : ''} today` : 'latest market snapshot', v: passed, color: C.a2 },
      { label: 'Proposed to a human', note: 'today', v: proposed, color: C.am },
      { label: 'Approved & bought', note: 'today', v: approved, color: C.g },
    ]) + `<div class="vz-cap">From ${total.toLocaleString()} stocks to a handful of trades. Nothing is bought until a person approves it.</div>`;
    const dc = { approved: 0, rejected: 0, expired: 0 }; for (const d of decs) if (dc[d.status] != null) dc[d.status]++;
    const decBody = donut([
      { label: 'Approved', v: dc.approved, color: decColor.approved },
      { label: 'Rejected', v: dc.rejected, color: decColor.rejected },
      { label: 'Expired (no decision / price moved)', v: dc.expired, color: decColor.expired },
    ], { center: String(decs.length), sub: 'proposals' });
    S.push(`<div class="vz-g2">${card('How the desk picks trades today', 'scan funnel', funnelBody)}${card('Human decisions', 'all proposals so far', decBody)}</div>`);

    // 3. Market today
    if (snap) {
      const mk = [];
      if (snap.dist?.counts) {
        const e = snap.dist.edges, labs = e.map((v, i) => i === 0 ? `< ${v}%` : `${e[i - 1]}…${v}%`).concat(`≥ ${e[e.length - 1]}%`);
        const items = snap.dist.counts.map((c, i) => ({ label: labs[i], v: c, title: `${labs[i]} on the day`, neg: i < e.indexOf(0) + 1 }));
        mk.push(card(`How ${market} stocks moved`, `${snap.label || ''} · number of stocks`, bars(items, { H: 210, fmtV: v => `${v} stocks`, colorOf: it => it.neg ? C.r : C.g }) +
          (snap.breadth ? `<div class="vz-split"><div style="flex:${snap.breadth.adv}" class="g">${snap.breadth.adv} up</div><div style="flex:${snap.breadth.dec}" class="r">${snap.breadth.dec} down</div></div>` : '')));
      }
      if (snap.sectors?.length) {
        const sec = snap.sectors.filter(s => s.n >= 3).slice(0, 14);
        const short = k => k.replace('Automobile and Auto Components', 'Auto').replace('Fast Moving Consumer Goods', 'FMCG').replace('Oil Gas & Consumable Fuels', 'Oil & Gas').replace('Media Entertainment & Publication', 'Media').replace('Information Technology', 'IT').replace('Construction Materials', 'Cement').replace('Financial Services', 'Financials').replace('Consumer Durables', 'Durables').replace('Consumer Services', 'Cons. services').replace('Metals & Mining', 'Metals').replace('Capital Goods', 'Cap. goods');
        mk.push(card('Sectors today', 'average move', hbars(sec.map(s => ({ label: short(s.k), v: s.c })), { W: 430, rowH: 22, fmtV: v => pct(v, 2), labelW: 120 })));
      } else if (snap.movers?.length || snap.gainers?.length) {
        const mv = (snap.movers || snap.gainers).slice(0, 10);
        mk.push(card('Biggest movers today', 'top gainers', hbars(mv.map(s => ({ label: s.sym, v: s.chg })), { W: 430, rowH: 24, fmtV: v => pct(v, 2), labelW: 70 })));
      }
      if (mk.length) S.push(`<div class="vz-g2">${mk.join('')}</div>`);
    }

    // 4. Live trading
    const pnlItems = [...trades].reverse().slice(-40).map(t => ({ label: t.sym, v: t.pnl, title: `${t.sym} · ${t.date} · ${t.reason}` }));
    const reasons = {}; for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
    S.push(`<div class="vz-g2">${card('Open trades · stop → target', state.positions.length ? `${state.positions.length} open · live` : 'none open', ladder(state.positions, marks, money))}
      ${card('Win / loss', 'closed live trades', donut([{ label: 'Won', v: wins, color: C.g }, { label: 'Lost or flat', v: losses, color: C.r }], { center: trades.length ? Math.round(wins / trades.length * 100) + '%' : '—', sub: 'win rate' }))}</div>`);
    S.push(`<div class="vz-g2">${card('Profit / loss of every closed trade', trades.length ? `last ${pnlItems.length} · green = profit` : '', trades.length ? bars(pnlItems, { fmtV: v => (v >= 0 ? '+' : '') + money(v), H: 210 }) : empty('Closed trades will appear here as green (profit) and red (loss) bars.'))}
      ${card('Why trades closed', 'exit reasons', donut(Object.entries(reasons).map(([k, v]) => ({ label: k, v, color: reasonColor(k) })), { center: String(trades.length), sub: 'trades' }))}</div>`);
    if (eqPts.length > 1) S.push(card('Live account value', `since ${md(eqPts[0].t)}`, area(eqPts, { base: state.startCash, fmtV: m0, fmtX: p => md(p.t) + ' ' + hm(p.t) })));

    // 5. Strategy replay (honest backtest)
    if (rep) {
      const curve = rep.curve, start = rep.startCash;
      const daily = curve.map((c, i) => ({ label: c.date.slice(5), v: c.v - (i ? curve[i - 1].v : start), title: c.date }));
      let peak = start; const dd = curve.map(c => { peak = Math.max(peak, c.v); return { v: -(peak - c.v) / peak * 100, d: c.date }; });
      const recent = rep.recent || [];
      const rEdges = [-1, -0.5, 0, 0.5, 1, 2], rLabs = ['≤ −1R', '−1…−0.5R', '−0.5…0R', '0…0.5R', '0.5…1R', '1…2R', '≥ 2R'], rc = new Array(7).fill(0);
      for (const t of recent) { let i = 0; while (i < rEdges.length && t.r >= rEdges[i]) i++; rc[i]++; }
      const rr = {}; for (const t of recent) rr[t.reason] = (rr[t.reason] || 0) + 1;
      const upDays = daily.filter(d => d.v > 0).length;
      S.push(`<div class="vz-sec"><div class="eyebrow">Strategy replay · the same rules re-run on real 5-minute prices · ${rep.from} → ${rep.to}</div>
        <div class="vz-honest ${rep.totalPct < 0 ? 'neg' : 'pos'}"><b>${rep.totalPct < 0 ? 'The replay loses money.' : 'The replay is profitable.'}</b> ${pct(rep.totalPct, 2)} over ${rep.sessions} sessions (${money(rep.totalPnl, 0)} net of all charges) · ${Math.round(rep.winRate)}% of ${rep.trades} trades won · profit factor ${rep.profitFactor} · worst drop ${pct(-rep.maxDDPct, 1)}. Shown as is, not tuned.</div></div>`);
      S.push(card('Replay: account value over time', `${upDays} of ${daily.length} days ended up`, area(curve.map(c => ({ v: c.v, d: c.date })), { base: start, fmtV: m0, fmtX: p => p.d.slice(5) })));
      S.push(`<div class="vz-g2">${card('Replay: profit / loss per day', 'green = up day', bars(daily, { fmtV: v => (v >= 0 ? '+' : '') + money(v, 0), H: 210 }))}
        ${card('Replay: drawdown', 'distance below the previous high', area(dd, { W: 430, H: 230, fmtV: v => v.toFixed(1) + '%', fmtX: p => p.d.slice(5), neg: true, base: 0 }))}</div>`);
      S.push(`<div class="vz-g2">${card('Replay: trade outcomes', `last ${recent.length} trades · in units of risk (R)`, bars(rLabs.map((l, i) => ({ label: l, v: rc[i], neg: i < 3 })), { fmtV: v => `${v} trades`, colorOf: it => it.neg ? C.r : C.g, H: 210 }) + '<div class="vz-cap">1R = the amount risked on a trade. −1R is a full stop-out; +3R is the profit target.</div>')}
        ${card('Replay: why trades closed', `last ${recent.length} trades`, donut(Object.entries(rr).map(([k, v]) => ({ label: k, v, color: reasonColor(k) })), { center: String(recent.length), sub: 'trades' }))}</div>`);
    }

    el.innerHTML = S.join('');
  }

  // styles (uses the dashboard's own theme tokens)
  const css = `
  .vz{width:100%;height:auto;display:block}
  .vz-empty{display:grid;place-items:center;color:var(--mute);font-size:13.5px;text-align:center;padding:0 20px}
  .vz-card{margin-bottom:16px}
  .vz-g2{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}
  .vz-g2 > *{min-width:0}
  .vz-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
  .vz-tile{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow);min-width:0}
  .vz-tile .l{font-family:"JetBrains Mono",monospace;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
  .vz-tile .v{font-size:32px;font-weight:900;letter-spacing:-.03em;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .vz-tile .s{font-size:12.5px;color:var(--mute);margin-top:2px}
  .vz-tile.warn{border-color:color-mix(in srgb,var(--red) 45%,var(--line))}
  .vz-funnel{display:grid;gap:10px}
  .vz-fs{display:grid;grid-template-columns:190px 1fr;gap:12px;align-items:center}
  .vz-fl b{display:block;font-size:13.5px}.vz-fl span{font-size:11.5px;color:var(--mute)}
  .vz-ft{display:flex;align-items:center;gap:10px;min-width:0}
  .vz-fb{height:30px;border-radius:8px;min-width:8px;transition:width .6s ease}
  .vz-ft strong{font:800 18px "JetBrains Mono",monospace}
  .vz-cap{font-size:12px;color:var(--mute);margin-top:10px}
  .vz-donut{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
  .vz-d{width:160px;height:160px;flex:none}
  .vz-legs{display:grid;gap:6px;min-width:0;flex:1}
  .vz-leg{display:grid;grid-template-columns:12px 1fr auto auto;gap:8px;align-items:center;font-size:13px}
  .vz-leg i{width:12px;height:12px;border-radius:3px}.vz-leg b{font-family:"JetBrains Mono",monospace}.vz-leg em{font-style:normal;color:var(--mute);font-size:12px;width:38px;text-align:right}
  .vz-split{display:flex;height:26px;border-radius:8px;overflow:hidden;margin-top:12px;font:700 12px "JetBrains Mono",monospace;color:#fff}
  .vz-split div{display:flex;align-items:center;padding:0 10px;min-width:max-content}.vz-split .g{background:var(--green)}.vz-split .r{background:var(--red);justify-content:flex-end}
  .vz-ladder{display:grid;gap:16px}
  .vz-ll{display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:6px}.vz-ll span{font-family:"JetBrains Mono",monospace;font-weight:700}
  .vz-lt{position:relative;height:18px;border-radius:9px;background:var(--chip);overflow:visible}
  .vz-lz{position:absolute;top:0;bottom:0;border-radius:9px}
  .vz-lm{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--ink2)}.vz-lm.s{background:var(--amber)}
  .vz-ld{position:absolute;top:50%;width:16px;height:16px;border-radius:50%;transform:translate(-50%,-50%);border:3px solid var(--paper);box-shadow:0 0 0 1px var(--line)}
  .vz-ld.up{background:var(--green)}.vz-ld.dn{background:var(--red)}
  .vz-lx{display:flex;justify-content:space-between;font:11px "JetBrains Mono",monospace;color:var(--mute);margin-top:6px;gap:6px;flex-wrap:wrap}
  .vz-sec{margin:10px 0 14px}
  .vz-honest{margin-top:8px;padding:12px 14px;border-radius:12px;font-size:14px;border:1px solid var(--line);background:var(--paper)}
  .vz-honest.neg{border-left:4px solid var(--red)}.vz-honest.pos{border-left:4px solid var(--green)}
  @media (max-width:900px){.vz-g2{grid-template-columns:1fr}.vz-tiles{grid-template-columns:repeat(2,1fr)}.vz-fs{grid-template-columns:1fr}}
  @media (max-width:480px){.vz-tiles{grid-template-columns:1fr}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  window.Viz = { render };
})();
