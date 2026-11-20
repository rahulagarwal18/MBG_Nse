// Client for NSE's official MCP servers (live cash market + bhavcopy history).
export const NSE_LIVE = 'https://mcp.nseindia.in/cmmkt/mcp';
export const NSE_HIST = 'https://mcp.nseindia.in/bhavcopy/cm/mcp';
const PROTO = '2025-06-18';
const HDR = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const sessions = new Map();
let rid = 1;

async function post(url, body, sid, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { ...HDR };
    if (sid) { headers['Mcp-Session-Id'] = sid; headers['Mcp-Protocol-Version'] = PROTO; }
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal, cache: 'no-store' });
    const text = await r.text();
    let payload = text.trim();
    if (payload.startsWith('event:') || payload.startsWith('data:')) {
      const data = payload.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
      payload = data[data.length - 1] || '';
    }
    return { status: r.status, sid: r.headers.get('mcp-session-id'), json: payload ? JSON.parse(payload) : null };
  } finally {
    clearTimeout(timer);
  }
}

async function session(url, fresh = false) {
  if (!fresh && sessions.has(url)) return sessions.get(url);
  const init = await post(url, { jsonrpc: '2.0', id: rid++, method: 'initialize',
    params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'desk', version: '1.0' } } }, null, 12000);
  if (init.status !== 200) throw new Error(`NSE init HTTP ${init.status}`);
  const sid = init.sid || null;
  await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid, 8000).catch(() => {});
  sessions.set(url, sid);
  return sid;
}

// Calls one NSE MCP tool and returns its parsed JSON result. Throws on failure.
export async function nseCall(url, name, args = {}, timeoutMs = 15000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sid = await session(url, attempt > 0);
    const r = await post(url, { jsonrpc: '2.0', id: rid++, method: 'tools/call', params: { name, arguments: args } }, sid, timeoutMs);
    if (r.status === 200 && r.json?.result) {
      const res = r.json.result;
      const text = res.content?.find(c => c.type === 'text')?.text ?? '';
      if (res.isError) throw new Error(`NSE ${name}: ${text.slice(0, 160)}`);
      if (res.structuredContent) return res.structuredContent;
      try { return JSON.parse(text); } catch { return { text }; }
    }
    sessions.delete(url); // expired or rejected session: retry once with a new one
    if (attempt === 1) throw new Error(`NSE ${name}: HTTP ${r.status} ${r.json?.error?.message || ''}`.trim());
  }
}

// "2026-11-20 12:27:56" (IST) -> epoch seconds
export function istToEpoch(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000) - 19800;
}

// Live snapshot for a set of NSE symbols from the official all-equity feed.
let snapCache = { at: 0, key: '', data: null };
export async function nseEquitySnapshot(symbols) {
  const want = new Set(symbols);
  const key = [...want].sort().join(',');
  if (snapCache.data && snapCache.key === key && Date.now() - snapCache.at < 45000) return snapCache.data;

  const first = new Map();
  for (const s of want) { const c = s[0]; if (!first.has(c)) first.set(c, []); first.get(c).push(s); }
  const out = {};
  let updatedAt = null;
  const fetchPrefix = async (prefix) => {
    const r = await nseCall(NSE_LIVE, 'cm_get_equity_stocks', { limit: 500, symbolFilter: prefix }, 20000);
    updatedAt = r.updatedAt || updatedAt;
    for (const st of r.stocks || []) if (want.has(st.symbol) && !out[st.symbol]) out[st.symbol] = st;
    return r.returned ?? (r.stocks || []).length;
  };
  const queue = [...first.keys()];
  const overflow = [];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const p = queue.shift();
      const n = await fetchPrefix(p).catch(() => 0);
      if (n >= 500) overflow.push(p);
    }
  }));
  // A prefix that hit the 500 cap is split into two-character prefixes for the symbols still missing.
  const second = new Set();
  for (const p of overflow) for (const s of first.get(p)) if (!out[s] && s.length > 1) second.add(s.slice(0, 2));
  const q2 = [...second];
  await Promise.all(Array.from({ length: 6 }, async () => { while (q2.length) await fetchPrefix(q2.shift()).catch(() => 0); }));

  const data = { stocks: out, updatedAt };
  snapCache = { at: Date.now(), key, data };
  return data;
}
