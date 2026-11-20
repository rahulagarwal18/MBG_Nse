# MBG_Nse · MultiBank Automated Trading (NSE India)

Human-approved automated trading desk for the NIFTY 500 with an **MCP server** for AI assistants, running on a **$10,000 simulated demo account** (held in rupees at the live USD/INR rate) with live NSE prices.

**Live:** https://multibank-automated-trading-nse.vercel.app
**MCP endpoint:** https://multibank-automated-trading-nse.vercel.app/api/mcp

## What it does
- Scans all NIFTY 500 stocks every 30 minutes from 09:40 IST and **recommends** gap-up trades with entry, stop, target and maximum loss already calculated.
- **Nothing is bought until a person approves it** (name + approver PIN). The live price is re-checked at approval.
- Exits are automatic: stop-loss, breakeven, trailing stop, 3R target, square-off by 15:20 IST.
- Every P&L figure is **net of Indian charges** (brokerage, STT, exchange and SEBI fees, stamp duty, GST).
- **Multi-source prices:** NSE official data first, cross-checked against a second feed (≈99% agreement, see the `data_quality` tool).
- **Stock report** tab: search any of ~5,000 NSE stocks (incl. SME) → last 30 days, 5-day projection with likely ranges, measured past accuracy, AI plain-language summary.
- **MCP server (19 read-only tools):** market status, quotes, index quotes, market mood / India VIX, corporate actions, 52-week range, index valuation, gap scanner, movers, sector performance, history, symbol search, intraday charges, position sizing, stock report, desk state, pending approvals, strategy report, data quality.

## Project layout
| Path | Purpose |
|---|---|
| `public/index.html` | Dashboard (single page) |
| `api/mcp.js` | MCP endpoint (Streamable HTTP, JSON-RPC) |
| `lib/tools.js` | MCP tool catalogue |
| `lib/nse.js` | Client for NSE's official MCP servers |
| `lib/market.js` | Multi-source quotes, exchange clock, history |
| `lib/charges.js` | Indian intraday charges |
| `lib/engine.js` | Trading rules, proposals, approvals, exits |
| `lib/analyze.js` | 30-day metrics, 5-day projection, accuracy check |
| `lib/ai.js`, `lib/ai-groq.js`, `lib/ai-claude.js` | AI analyst (uses whichever key is configured) |
| `api/tick.js`, `api/approve.js`, `api/heartbeat.js` | Desk cycle, approvals, self-healing |
| `api/analyze.js`, `api/search.js` | Stock report and search |
| `.github/workflows/desk.yml` | Scheduler (every 15 min in market hours) |

## Settings (server environment variables)
| Name | Purpose |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Private storage for desk state |
| `TICK_SECRET`, `CRON_SECRET` | Protect the cycle endpoint |
| `APPROVER_PIN` | PIN required to approve or reject trades |
| `GROQ_API_KEY`, `GROQ_MODEL` | AI analyst |
| `ANTHROPIC_API_KEY` (optional) | Switches the AI analyst to Claude |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional) | Phone alerts |

Repository secrets for the scheduler: `DESK_KEY`, `DESK_URL`.

> Prototype for demonstration. Simulated money, not an official MultiBank Group service, not investment advice.
