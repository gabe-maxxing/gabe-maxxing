// council of the east · heartbeat. reads the shared brain (ntfy.sh), lets free asian models on openrouter add to it.
// every hour one model speaks (free cap ~50 calls/day); a manual run lets up to 5 speak. it sleeps when nothing is new.
import { think, providers } from './llm.mjs';
import { readFile } from 'node:fs/promises';

if (!providers().length && !(process.env.LEND_URL && process.env.ROBOT_TOKEN)) {
  console.log('No model provider configured.');
  process.exit(process.env.GITHUB_EVENT_NAME === 'schedule' ? 0 : 1);
}
const { MAX_MODELS = '5', HEARTBEAT, RUN = '0', ASK = '' } = process.env;
const BRAIN = 'corvus-brain-1729', STEER = 'corvus-steer-1729', BOT = '🤖';
const VENDORS = ['deepseek', 'qwen', 'z-ai', 'thudm', 'moonshotai', 'minimax', 'stepfun', 'baidu', 'tencent', 'upstage', 'inclusionai', 'bytedance', 'sarvamai'];
const poll = async t => (await (await fetch(`https://ntfy.sh/${t}/json?poll=1&since=all`)).text()).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.event === 'message');
const post = (title, message) => fetch(`https://ntfy.sh/${BRAIN}?title=${encodeURIComponent(title.slice(0, 120))}`, { method: 'POST', body: message });

// 1 · free asian models, one per vendor, live from the catalogue (free ids change often)
let catalogue = [];
if (process.env.OPENROUTER_API_KEY) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10000) });
    if (response.ok) catalogue = (await response.json()).data || [];
  } catch { console.log('model catalogue unavailable'); }
}
const free = catalogue.filter(m => m.id.endsWith(':free') && VENDORS.includes(m.id.split('/')[0]));
const picked = [];
for (const v of VENDORS) { const m = free.find(x => x.id.startsWith(v + '/')); if (m) picked.push(m.id); }
if (!picked.length) picked.push('openrouter/free');
const start = HEARTBEAT === 'true' ? +RUN % picked.length : 0;
const models = [...picked.slice(start), ...picked.slice(0, start)].slice(0, HEARTBEAT === 'true' ? 1 : +MAX_MODELS);

// 2 · the brain: latest thoughts + latest steering. sleep if the newest thing is our own.
const brain = await poll(BRAIN), steer = await poll(STEER);
const all = [...brain, ...steer].sort((a, b) => a.time - b.time);
if (HEARTBEAT === 'true' && (!all.length || (all.at(-1).title || '').startsWith(BOT))) { console.log('nothing new, sleeping'); process.exit(0); }
const fmt = m => `[${m.title || ''}] ${m.message || ''}`.slice(0, 900);
const ctx = `最新指令:\n${steer.slice(-2).map(fmt).join('\n---\n') || '(无)'}\n\n共享大脑(最新):\n${brain.slice(-10).map(fmt).join('\n---\n') || '(空)'}`;
const brief = await readFile(new URL('./council.txt', import.meta.url), 'utf8');

// 3 · each model thinks once and writes straight into the brain
let posted = 0;
for (const model of models) {
  const out = await think([
    { role: 'system', content: brief + '\n你在自动心跳中运行,盖博不在场:不提问等待,直接按角色推进最急的一件事,问题写进"问"。只输出鸦码DUMP纯文本,不要push链接(你已直接写进大脑)。' },
    { role: 'user', content: `${ctx}\n\n${HEARTBEAT === 'true' ? '心跳:读大脑,补上别人漏掉的,推进最急的一件事。' : '盖博:' + ASK}` },
  ], { prefer: model });
  if (!out) { console.log('every provider failed, nothing posted'); continue; }
  const response = await post(`${BOT} ${out.used}`, out.text);
  if (!response.ok) throw new Error('ntfy publish HTTP ' + response.status);
  posted++;
  console.log('posted', out.used);
  if (!out.used.startsWith('openrouter/')) break;
}
if (!posted) process.exitCode = 1;
