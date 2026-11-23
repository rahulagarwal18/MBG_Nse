# CLAUDE.md: guide for AI assistants working on this repo

MBG_Nse is the India desk of MultiBank Automated Trading. It is a gap-up momentum paper-trading desk for the NIFTY 500 and includes an MCP server.

- **Account:** a simulated $10,000 account, held in INR at the live USD/INR rate.
- **Approval:** a human must approve every new trade.
- **Sister repo:** **MBG** (the US / S&P 500 desk). The two repos share most of their code, so a bug fixed in one usually needs the same fix in the other.

**Live sites:**
- Dashboard: https://multibank-automated-trading-nse.vercel.app
- MCP server: `/api/mcp`
- Hosting: Vercel project `nse-desk`, region bom1

## Architecture
- **No framework, no build step.** The code is plain Node ESM (`"type": "module"`). Every file in `api/` is a Vercel serverless function: `export default async function handler(req, res)`.
- **Dashboard:** `public/index.html` is the whole dashboard, written in vanilla JS with inline CSS. It polls `/api/state` and `/api/quotes` every 5 s.
- **State storage:** state is kept as JSON in **private Vercel Blob** (`lib/store.js`) and is always read with `useCache:false`.
  - Do NOT switch to a public store. Public-store CDN caching served stale state and lost updates.
- **Prices are multi-source** (`lib/market.js`):
  - Primary: NSE's official MCP servers (`lib/nse.js`): `https://mcp.nseindia.in/cmmkt/mcp` (live) and `/bhavcopy/cm/mcp` (history).
  - Backup and cross-check: Yahoo (`.NS` symbols).
  - **NSE MCP gotcha:** pass every integer argument explicitly, or the server throws a NullPointerException. The protocol is Streamable HTTP with an `Mcp-Session-Id` header, and responses may arrive as SSE.
- **MCP server:** `api/mcp.js` is a stateless JSON-RPC server (`initialize`, `tools/list`, `tools/call`). The tools are defined in `lib/tools.js`; there are 19, all read-only.
- **Charges:** `lib/charges.js` computes Indian intraday charges (brokerage, STT, exchange fee, SEBI fee, stamp duty, GST). Every P&L figure is net of these.
- **AI write-ups:** `lib/ai.js` uses Claude if `ANTHROPIC_API_KEY` is set, otherwise Groq. If neither works, it falls back to rules.

## Key files
| File | What it does |
|---|---|
| `lib/engine.js` | `CONFIG` (riskPct 1, maxPositions 5, minGapPct 2, minOpenGapPct 1, maxGapPct 6, pullbackPct 1, minPrice 50, flattenLastMin 10). Entries are "buy the dip": a gapper is only proposed once it is ≥ 1% below the day's high, and gaps over 6% are skipped (replay: −6.85% vs −9.46% for the old chase-the-high rules, 23 Nov 2026; still a loss). The `scan_gappers` MCP tool stays a plain gap scan without these two rules. `tick()` turns scan results into proposals in `state.pending`. `decide()` approves or rejects a proposal and re-checks the live price. Exits are automatic, with square-off by 15:20 IST. |
| `lib/universe.js` | The NIFTY 500 symbols, plus an `INFO` map of symbol → [company, industry] |
| `lib/analyze.js` | Stock report: 30-day metrics, a 5-day projection and a walk-forward accuracy check |
| `lib/backtest.js` | Strategy replay, net of charges |
| `api/tick.js` / `api/approve.js` / `api/heartbeat.js` | Desk cycle / approvals (PIN + name) / self-heal |
| `api/search.js` | Symbol search. Tries the local `INFO` map, then NSE `search_symbols`, then Yahoo, each with a short timeout |
| `.github/workflows/desk.yml` | Scheduler: calls `/api/tick` every 15 minutes, 03:00–10:59 UTC Mon–Fri. The NSE session is 09:15–15:30 IST (03:45–10:00 UTC). |

## Running and testing
- **Run locally:** `npm install`, then `npx vercel dev`. Env vars go in `.env.local`, which is never committed.
- **No test suite.** To check a change:
  1. Push to `main`; this auto-deploys.
  2. Check `/api/state`, `/api/quotes`, `/api/analyze?symbol=RELIANCE`, and the dashboard.
- **Test the MCP server:**
  ```
  curl -X POST $URL/api/mcp -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  ```

## Environment variables
Set these in Vercel, never in code:
- **Required:** `BLOB_READ_WRITE_TOKEN`, `TICK_SECRET`, `CRON_SECRET`, `APPROVER_PIN`, `GROQ_API_KEY`, `GROQ_MODEL`.
- **Optional:** `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

## Rules: keep these when fixing things
1. **Human approval must stay.** The desk only proposes entries and must never execute them automatically. Exits stay automatic.
2. **Never commit secrets, keys or the PIN.** Before pushing, run `git grep -nE "gsk_|sk-ant|vercel_blob_rw"`.
3. **Keep results honest.**
   - The replay loses money net of charges.
   - The projection's direction accuracy is close to a coin flip.
   - Show these numbers as they are; don't tune or hide them.
4. **Branding.**
   - The product name is "MultiBank Automated Trading NSE", with the blue theme.
   - Show no personal names, and don't advertise the tech stack or the AI vendor on the site.
   - Keep the footer: prototype, simulated money, not an official MultiBank Group service, not investment advice.
5. **Timezones.** The market runs on IST: use `Asia/Kolkata` (some runtimes report it as `Asia/Calcutta`). All prices are in INR.
6. **Hosting limits.** The Vercel Hobby plan allows a cron job at most **once per day**. That's why scheduling uses GitHub Actions plus the heartbeat.

## Known issues / good first fixes
- **Unreliable scheduling.** GitHub Actions cron runs are often delayed or skipped, so the desk only ticks reliably while a dashboard is open.
  - Fix: an external pinger, such as cron-job.org calling `/api/tick` with `x-desk-key`, or Vercel Pro crons.
- **Fragile data sources.** NSE MCP and Yahoo can be slow or unavailable. Every call needs a timeout and a fallback, and quotes must not block the dashboard.
- **Stale cache after cold starts.** The `/api/analyze` cache lives in memory per instance, so a cold start refetches everything.
- **Possible write race.** State is a single JSON blob where the last write wins. A tick and an approval running at the same time can still race. A version check with retry would harden this.
