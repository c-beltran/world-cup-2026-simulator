// Provider-agnostic LLM client — OFFLINE narration step ONLY.
// Default provider: anthropic (Claude). Switch with LLM_PROVIDER. Keys + model id
// are read from env (load via `node --env-file=.env`, i.e. `npm run narrate`).
// This module is NEVER imported by /app — no key ever reaches the shipped page.

const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

const DEFAULT_MODEL = {
  anthropic: 'claude-haiku-4-5', // verified against platform.claude.com/docs (Haiku 4.5)
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
};

async function anthropic({ system, user, maxTokens = 800, temperature = 0.85 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set — add it to pipeline/.env and run `npm run narrate`.');
  const model = process.env.LLM_MODEL || DEFAULT_MODEL.anthropic;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.content.map((c) => c.text || '').join('').trim();
}

// Free-tier fallback (the project's original default provider). Untested here.
async function gemini({ system, user, maxTokens = 800, temperature = 0.85 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set.');
  const model = process.env.LLM_MODEL || DEFAULT_MODEL.gemini;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '').trim();
}

const PROVIDERS = { anthropic, gemini };

export async function generate(opts) {
  const fn = PROVIDERS[PROVIDER];
  if (!fn) throw new Error(`Unknown LLM_PROVIDER "${PROVIDER}" (available: ${Object.keys(PROVIDERS).join(', ')}).`);
  return fn(opts);
}

export const llmInfo = () => ({ provider: PROVIDER, model: process.env.LLM_MODEL || DEFAULT_MODEL[PROVIDER] || '(default)' });
