# Demo branch

This branch is the chart-heavy demo version of the dashboard (the "📊 Overview" tab, `public/viz.js`).
It is deployed as a separate Vercel project that serves only `public/` and proxies every `/api/*`
request to the main desk at https://multibank-automated-trading-nse.vercel.app, so it always shows the same live account, trades and market.

Deploy: `npx vercel deploy --prod` from a checkout of this branch linked to the demo project.
Main (`main` branch) does not carry the Overview tab.
