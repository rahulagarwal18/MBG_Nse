// Human approval endpoint: approve or reject a proposed trade (approver PIN required).
import { timingSafeEqual } from 'node:crypto';
import { decide } from '../lib/engine.js';

export const config = { maxDuration: 30 };

const same = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { id, action, pin } = body || {};
  if (!process.env.APPROVER_PIN || !same(pin, process.env.APPROVER_PIN)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'Wrong approver PIN.' });
  }
  if (!id || !['approve', 'reject'].includes(action)) return res.status(400).json({ ok: false, error: 'Missing trade id or action.' });
  try {
    const out = await decide({ id: String(id), action });
    return res.status(out.ok ? 200 : 409).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
