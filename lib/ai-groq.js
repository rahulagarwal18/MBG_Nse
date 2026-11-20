// AI analyst provider: Groq (OpenAI-compatible chat completions endpoint).
const URL = 'https://api.groq.com/openai/v1/chat/completions';

export const groqEnabled = () => !!process.env.GROQ_API_KEY;

export async function groqWrite({ system, user, maxTokens = 900, timeoutMs = 20000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
        reasoning_effort: 'low',
        include_reasoning: false,
        temperature: 0.3,
        max_completion_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    const text = j.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty response');
    return text;
  } finally {
    clearTimeout(timer);
  }
}
