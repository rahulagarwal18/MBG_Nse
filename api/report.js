import { getReport } from '../lib/tools.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const rep = await getReport();
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json(rep);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
