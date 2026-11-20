// MCP endpoint (Streamable HTTP, stateless JSON responses).
import { TOOLS } from '../lib/tools.js';

export const config = { maxDuration: 60 };

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'nse-desk', title: 'NSE Desk', version: '1.1.0' };
const INSTRUCTIONS = 'Live NSE (India) market tools for the NIFTY 500. Prices come from NSE official data first and are cross-checked against a second feed (see data_quality). Tools: market status, quotes, index quotes, market mood and India VIX, corporate actions, 52-week range, index valuation, gap-up scanner, movers, sector performance, ' +
  'OHLCV history, symbol search, intraday charges, risk-based position sizing, plus the autonomous paper desk state and its strategy replay report. ' +
  'All prices are in INR; times are IST. Data may be delayed. Not investment advice.';

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize': {
      const v = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      return ok(id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return err(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const data = await tool.run(params.arguments || {});
        const isError = !!data?.error;
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError });
      } catch (e) {
        return ok(id, { content: [{ type: 'text', text: `Tool failed: ${e?.message || e}` }], isError: true });
      }
    }
    case 'resources/list': return ok(id, { resources: [] });
    case 'prompts/list': return ok(id, { prompts: [] });
    default:
      return isNotification ? null : err(id, -32601, `Method not found: ${method}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'DELETE') return res.status(200).end();
  if (req.method === 'GET') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json(err(null, -32000, 'Use POST for MCP JSON-RPC messages.'));
  }
  if (req.method !== 'POST') return res.status(405).end();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json(err(null, -32700, 'Parse error')); } }
  if (body == null) return res.status(400).json(err(null, -32700, 'Parse error'));

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    return out.length ? res.status(200).json(out) : res.status(202).end();
  }
  const out = await handle(body);
  if (!out) return res.status(202).end();
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(out);
}
