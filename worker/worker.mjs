const providers = {
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  sambanova: 'https://api.sambanova.ai/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1',
};
const effortLevels = {
  light: { calls: 5, tokens: 400 }, medium: { calls: 25, tokens: 900 }, heavy: { calls: 100, tokens: 2000 },
};
const encode = text => new TextEncoder().encode(text);
const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const bytes = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
const random = size => crypto.getRandomValues(new Uint8Array(size));
const digest = async str => base64(await crypto.subtle.digest('SHA-256', encode(str)));
const today = () => new Date().toISOString().slice(0, 10);
const response = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const failure = (error, status) => response({ error }, status);
const aes = secret => crypto.subtle.importKey('raw', bytes(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);

async function gateway(request, env) {
  const path = new URL(request.url).pathname.replace(/^\/lend-api(?=\/)/, '');
  if (!['/lend', '/stats', '/revoke', '/think'].includes(path)) return failure('unknown route', 404);
  if (request.method !== (path === '/stats' ? 'GET' : 'POST')) return failure('wrong method', 405);
  if (!env.ENC_KEY || !env.ROBOT_TOKEN) return failure('temporarily unavailable', 503);
  if (path === '/think') {
    if (request.headers.get('authorization') !== 'Bearer ' + env.ROBOT_TOKEN) return failure('unauthorized', 401);
  } else if (request.method === 'POST') {
    const origin = request.headers.get('origin');
    if (origin && !['https://corvus.gent', 'https://www.corvus.gent', new URL(request.url).origin].includes(origin)) return failure('wrong origin', 403);
  }
  if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0] !== 'application/json') return failure('expected JSON', 415);
  return env.POOL.get(env.POOL.idFromName('lending-pool')).fetch(request);
}

export default {
  async fetch(request, env) {
    try { return await gateway(request, env); } catch { return failure('temporarily unavailable', 503); }
  },
};

async function providerFetch(url, key, body) {
  return fetch(url, {
    method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(25000),
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
}

async function chooseModel(provider, key) {
  const base = providers[provider];
  if (provider === 'openrouter' && !(await providerFetch(base + '/key', key)).ok) return null;
  const result = await providerFetch(base + '/models', key);
  if (!result.ok) return null;
  const models = ((await result.json()).data || []).map(m => (m.id || '').replace(/^models\//, ''))
    .filter(id => id && !/embed|guard|tts|whisper|image|rerank|moderation|speech|audio|translat|transcri/i.test(id))
    .filter(id => provider !== 'openrouter' || id.endsWith(':free'));
  for (const pattern of [/gemini.*flash/i, /llama-3\.3/i, /mistral-small/i, /command-a/i, /deepseek|qwen|gpt-oss/i]) {
    const model = models.find(id => pattern.test(id));
    if (model) return model;
  }
  return models[0];
}

export class LendingPool {
  constructor(state, env) {
    this.sql = state.storage.sql;
    this.storage = state.storage;
    this.env = env;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS loans(
      id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, provider TEXT, model TEXT, effort TEXT,
      iv TEXT, ciphertext TEXT, day TEXT, used INTEGER DEFAULT 0, cap INTEGER);
      CREATE TABLE IF NOT EXISTS attempts(ip_day TEXT PRIMARY KEY, day TEXT, n INTEGER);
      CREATE TABLE IF NOT EXISTS runs(run TEXT, loan TEXT, day TEXT, PRIMARY KEY(run,loan));`);
  }
  async fetch(request) {
    const path = new URL(request.url).pathname.split('/').pop();
    if (path === 'stats') {
      const counts = [...this.sql.exec('SELECT provider, count(*) AS n FROM loans GROUP BY provider')];
      return response({ lent: counts.reduce((sum, row) => sum + row.n, 0), by: Object.fromEntries(counts.map(row => [row.provider, row.n])) });
    }
    const limit = path === 'think' ? 65536 : 2048;
    if (Number(request.headers.get('content-length')) > limit) return failure('body too large', 413);
    const reader = request.body?.getReader();
    if (!reader) return failure('expected JSON', 400);
    let size = 0, text = '';
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return failure('body too large', 413); }
      text += decoder.decode(value, { stream: true });
    }
    let data;
    try { data = JSON.parse(text + decoder.decode()); } catch { return failure('invalid JSON', 400); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return failure('expected an object', 400);
    if (path === 'lend') return this.lend(data, request.headers.get('cf-connecting-ip') || 'unknown');
    if (path === 'revoke') {
      if (typeof data.revoke !== 'string' || !data.revoke || data.revoke.length > 100) return failure('wrong code', 403);
      const id = await digest(data.revoke);
      const deleted = [...this.sql.exec('DELETE FROM loans WHERE id = ? RETURNING id', id)];
      return deleted.length ? response({ ok: true }) : failure('wrong code', 403);
    }
    return this.think(data);
  }
  async lend({ key, provider, effort }, ip) {
    const day = today();
    const ipDay = await digest(day + ':' + ip);
    this.sql.exec('DELETE FROM attempts WHERE day < ?', day);
    const attempts = this.sql.exec(`INSERT INTO attempts VALUES(?,?,1) ON CONFLICT(ip_day)
      DO UPDATE SET n=n+1 WHERE n < 5 RETURNING n`, ipDay, day);
    if (![...attempts].length) return failure('too many tries today', 429);
    if (!Object.hasOwn(providers, provider) || !Object.hasOwn(effortLevels, effort) ||
        typeof key !== 'string' || !/^[\x21-\x7e]{16,300}$/.test(key)) return failure('invalid loan', 400);
    let model;
    try { model = await chooseModel(provider, key); } catch { return failure('provider unavailable', 503); }
    if (!model) return failure('key or model unavailable', 400);

    const revoke = base64(random(24)).replaceAll('+', '-').replaceAll('/', '_');
    const id = await digest(revoke);
    const fingerprint = await digest(provider + ':' + key);
    const iv = random(12);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(this.env.ENC_KEY), encode(key));
    const inserted = [...this.sql.exec(`INSERT INTO loans(id,fingerprint,provider,model,effort,iv,ciphertext,day,cap)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(fingerprint) DO NOTHING RETURNING id`,
      id, fingerprint, provider, model, effort, base64(iv), base64(ciphertext), day, effortLevels[effort].calls)];
    if (!inserted.length) return failure('already lent', 409);
    return response({ revoke, effort, limits: effortLevels[effort] });
  }
  reserve(run) {
    const day = today();
    return this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM runs WHERE day < date(?, '-7 days')", day);
      if ([...this.sql.exec('SELECT COUNT(*) AS n FROM runs WHERE run=?', run)][0].n >= 3) return null;
      const [loan] = this.sql.exec(`SELECT * FROM loans WHERE (day != ? OR used < cap)
        AND id NOT IN (SELECT loan FROM runs WHERE run = ?) ORDER BY random() LIMIT 1`, day, run);
      if (!loan) return null;
      this.sql.exec('UPDATE loans SET used = CASE WHEN day=? THEN used+1 ELSE 1 END, day=? WHERE id=?', day, day, loan.id);
      this.sql.exec('INSERT INTO runs VALUES(?,?,?)', run, loan.id, day);
      return loan;
    });
  }
  async think({ run, messages, max_tokens }) {
    if (typeof run !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(run) ||
        !Array.isArray(messages) || !messages.length || messages.length > 32 ||
        !messages.every(m => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string') ||
        !Number.isInteger(max_tokens) || max_tokens < 1) return failure('invalid request', 400);
    for (let attempt = 0; attempt < 3; attempt++) {
      const loan = this.reserve(run);
      if (!loan) break;
      const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(loan.iv) }, await aes(this.env.ENC_KEY), bytes(loan.ciphertext));
      const key = new TextDecoder().decode(raw);
      if (![...this.sql.exec('SELECT id FROM loans WHERE id=?', loan.id)].length) continue;
      try {
        const reply = await providerFetch(providers[loan.provider] + '/chat/completions', key, {
          model: loan.model, messages: messages.map(({ role, content }) => ({ role, content })),
          max_tokens: Math.min(max_tokens, effortLevels[loan.effort].tokens),
        });
        if (!reply.ok) continue;
        const text = (await reply.json()).choices?.[0]?.message?.content;
        if (typeof text === 'string' && text.trim() && !text.includes(key)) return response({ text: text.trim(), provider: loan.provider });
      } catch { /* This reservation counts even if the provider times out. */ }
    }
    return response({ available: false });
  }
}
