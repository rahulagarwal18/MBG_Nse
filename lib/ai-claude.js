// AI analyst provider: Claude (Anthropic SDK). Used automatically when ANTHROPIC_API_KEY is set.
import Anthropic from '@anthropic-ai/sdk';

export const claudeEnabled = () => !!process.env.ANTHROPIC_API_KEY;

let client = null;

export async function claudeWrite({ system, user, maxTokens = 16000, timeoutMs = 45000 }) {
  client ||= new Anthropic({ timeout: timeoutMs, maxRetries: 1 });
  const response = await client.beta.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') throw new Error('declined');
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw new Error('empty response');
  return text;
}
