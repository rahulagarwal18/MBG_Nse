// Self-healing: an open dashboard nudges the desk if no scheduled cycle has run for 9+ minutes.
import { tick, loadState } from '../lib/engine.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
  try {
    const s = await loadState();
    const age = Math.floor(Date.now() / 1000) - (s.lastTick || 0);
    if (age < 540) return res.status(200).json({ ok: true, ran: false, age });
    const { info } = await tick();
    return res.status(200).json({ ok: true, ran: true, actions: info.actions });
  } catch (e) {
    return res.status(200).json({ ok: false });
  }
}
