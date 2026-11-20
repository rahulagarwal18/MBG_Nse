import { INFO } from '../lib/universe.js';
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=86400');
  return res.status(200).json(Object.entries(INFO).map(([s, [n, i]]) => ({ s, n, i })));
}
