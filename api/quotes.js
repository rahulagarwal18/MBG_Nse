import { getQuotes } from '../lib/market.js';

export default async function handler(req, res) {
  const symbols = String(req.query.symbols || '').split(',').map(s => s.trim().toUpperCase())
    .filter(s => /^[A-Z0-9&\-]{1,20}$/.test(s)).slice(0, 40);
  if (!symbols.length) return res.status(200).json({});
  try {
    const q = await getQuotes(symbols);
    res.setHeader('Cache-Control', 'public, s-maxage=3, stale-while-revalidate=5');
    return res.status(200).json(q);
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
