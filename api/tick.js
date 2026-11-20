import { tick } from '../lib/engine.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const key = req.headers['x-desk-key'] || req.query.key;
  const cron = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cron && (!process.env.TICK_SECRET || key !== process.env.TICK_SECRET)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    const { info, clock } = await tick({ force: req.query.force === '1' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, info, clock });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
