// one brain, many free mouths. tries each provider whose key is set, in order, until one answers.
// every provider here speaks the OpenAI chat format. keys live only in GitHub Secrets / env, never in the repo.
const P = [
  { name: 'openrouter', key: 'OPENROUTER_API_KEY', base: 'https://openrouter.ai/api/v1' },
  { name: 'groq', key: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1' },
  { name: 'gemini', key: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { name: 'mistral', key: 'MISTRAL_API_KEY', base: 'https://api.mistral.ai/v1' },
  { name: 'nvidia', key: 'NVIDIA_API_KEY', base: 'https://integrate.api.nvidia.com/v1' },
  { name: 'sambanova', key: 'SAMBANOVA_API_KEY', base: 'https://api.sambanova.ai/v1' },
  { name: 'cohere', key: 'COHERE_API_KEY', base: 'https://api.cohere.ai/compatibility/v1' },
  { name: 'ollama', key: null, base: process.env.OLLAMA_URL ? process.env.OLLAMA_URL.replace(/\/$/, '') + '/v1' : null },   // Gabe's M1, only when reachable
];
// asian open models first, then strong free fallbacks. ids change often, so we pick from each live catalogue.
const PREF = [/deepseek/i, /qwen/i, /glm/i, /kimi|moonshot/i, /minimax/i, /gpt-oss/i, /llama-?3\.3|llama-?4/i, /gemini.*flash/i, /mistral-(small|medium)/i, /command-a|command-r/i];
const auth = p => p.key ? { authorization: `Bearer ${process.env[p.key]}` } : {};
const live = p => p.base && (p.key === null ? !!process.env.OLLAMA_URL : !!process.env[p.key]);

async function pick(p) {
  try {
    const r = await fetch(`${p.base}/models`, { headers: auth(p) }); if (!r.ok) return null;
    let ids = ((await r.json()).data || []).map(m => (m.id || '').replace(/^models\//, ''));
    if (p.name === 'openrouter') ids = ids.filter(i => i.endsWith(':free'));
    for (const re of PREF) { const hit = ids.find(i => re.test(i) && !/embed|vision|guard|tts|whisper|image/i.test(i)); if (hit) return hit; }
    return ids[0] || null;
  } catch { return null; }
}

// The Worker enforces the lender's budget. Only a completion and provider name cross this boundary.
export async function lentThought(messages, max_tokens) {
  const { LEND_URL, ROBOT_TOKEN, GITHUB_RUN_ID } = process.env;
  if (!LEND_URL || !ROBOT_TOKEN || !GITHUB_RUN_ID) return null;
  try {
    const url = new URL('/think', LEND_URL);
    if (url.protocol !== 'https:') return null;
    const r = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(85000),
      headers: { authorization: 'Bearer ' + ROBOT_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ run: GITHUB_RUN_ID, messages, max_tokens }),
    });
    if (!r.ok) return null;
    const result = await r.json();
    if (!P.some(p => p.name === result.provider && p.key) || typeof result.text !== 'string' || !result.text.trim()) return null;
    return { used: 'lent:' + result.provider, text: result.text };
  } catch { return null; }
}

export async function think(messages, { max_tokens = 900, prefer } = {}) {
  const lent = await lentThought(messages, max_tokens);
  if (lent) return lent;
  for (const p of P.filter(live)) {
    const model = (p.name === 'openrouter' && prefer) || await pick(p); if (!model) continue;
    try {
      const r = await fetch(`${p.base}/chat/completions`, { method: 'POST', headers: { ...auth(p), 'content-type': 'application/json', 'x-title': 'corvus council of the east' },
        body: JSON.stringify({ model, max_tokens, messages }) });
      if (!r.ok) { console.log('provider HTTP', p.name, r.status); continue; }
      const j = await r.json(); const text = j.choices?.[0]?.message?.content?.trim();
      if (text) return { text, used: `${p.name}/${model}` };
      console.log('no answer from', p.name, r.status);
    } catch { console.log('failed', p.name); }
  }
  return null;
}
export const providers = () => P.filter(live).map(p => p.name);
