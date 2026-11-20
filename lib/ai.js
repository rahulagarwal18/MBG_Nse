// AI analyst: picks the configured provider (Claude if its key is set, otherwise Groq).
// Returns { text, provider } or null when no provider is configured or every provider fails.
import { claudeEnabled, claudeWrite } from './ai-claude.js';
import { groqEnabled, groqWrite } from './ai-groq.js';

export function aiAvailable() {
  return claudeEnabled() || groqEnabled();
}

export async function aiWrite(prompt) {
  const order = [];
  if (claudeEnabled()) order.push(['claude', claudeWrite]);
  if (groqEnabled()) order.push(['groq', groqWrite]);
  for (const [provider, write] of order) {
    try {
      return { text: await write(prompt), provider };
    } catch (e) {
      console.error(`AI provider ${provider} failed:`, e?.message || e);
    }
  }
  return null;
}
