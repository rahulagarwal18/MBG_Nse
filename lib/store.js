// Persistent JSON storage (private store, read straight from origin so every read sees the latest write).
import { put, get } from '@vercel/blob';

// Returns `fallback` only when the document does not exist yet. Any other failure throws,
// so a temporary storage error can never be mistaken for "no data" and overwrite real state.
export async function readJSON(name, fallback = null) {
  const r = await get(name, { access: 'private', useCache: false });
  if (!r) return fallback;
  const text = await new Response(r.stream).text();
  return JSON.parse(text);
}

export async function writeJSON(name, data) {
  return put(name, JSON.stringify(data), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}
