import { loadState, CONFIG } from '../lib/engine.js';
import { getClock } from '../lib/market.js';

export default async function handler(req, res) {
  try {
    const [state, clock] = await Promise.all([loadState(), getClock().catch(() => null)]);
    res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
    return res.status(200).json({ state, clock, config: CONFIG });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
