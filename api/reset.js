import { freshState, saveState } from '../lib/engine.js';

export default async function handler(req, res) {
  const key = req.headers['x-desk-key'] || req.query.key;
  if (!process.env.TICK_SECRET || key !== process.env.TICK_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (req.query.confirm !== 'yes') return res.status(400).json({ ok: false, error: 'add confirm=yes' });
  await saveState(await freshState());
  return res.status(200).json({ ok: true });
}
