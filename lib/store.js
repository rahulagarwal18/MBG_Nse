// Persistent JSON storage.
import { put, head } from '@vercel/blob';

let baseUrl = null;

function tokenBase() {
  const t = process.env.BLOB_READ_WRITE_TOKEN || '';
  const id = t.split('_')[3];
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : null;
}

async function urlFor(name) {
  if (baseUrl) return `${baseUrl}/${name}`;
  const tb = tokenBase();
  if (tb) return `${tb}/${name}`;
  const h = await head(name);
  return h.url;
}

export async function readJSON(name, fallback = null) {
  try {
    const url = await urlFor(name);
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) return await r.json();
    if (r.status === 404 && !baseUrl) {
      try {
        const h = await head(name);
        baseUrl = h.url.slice(0, h.url.lastIndexOf('/'));
        const r2 = await fetch(`${h.url}?v=${Date.now()}`, { cache: 'no-store' });
        if (r2.ok) return await r2.json();
      } catch { /* not created yet */ }
    }
  } catch { /* fall through */ }
  return fallback;
}

export async function writeJSON(name, data) {
  const res = await put(name, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60,
  });
  baseUrl = res.url.slice(0, res.url.lastIndexOf('/'));
  return res;
}
