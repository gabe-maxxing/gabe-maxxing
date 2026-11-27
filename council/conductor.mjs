import { think, providers } from './llm.mjs';
// conductor · the step Gabe did by hand: read the brain, write ONE short STEER, post it. every 3 h, free models only.
// a human steer always wins: if Gabe steered in the last 24 h, the conductor stays silent.
import { readFile } from 'node:fs/promises';
if (!providers().length && !(process.env.LEND_URL && process.env.ROBOT_TOKEN)) {
  console.log('No model provider configured.');
  process.exit(process.env.GITHUB_EVENT_NAME === 'schedule' ? 0 : 1);
}
const BRAIN = 'corvus-brain-1729', STEER = 'corvus-steer-1729', SPREAD = 'corvus-spread-1729', BOT = '🎼';
const poll = async t => (await (await fetch(`https://ntfy.sh/${t}/json?poll=1&since=all`)).text()).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.event === 'message');
const [brain, steer, spread] = await Promise.all([poll(BRAIN), poll(STEER), poll(SPREAD)]);
const now = Date.now();
const cutoff = now - 24 * 60 * 60 * 1000;
let lastHuman = Math.max(0, ...steer.filter(m => !/^(🎼|🤖)/.test(m.title || '')).map(m => m.time * 1000));
// ntfy may expire messages before the 24-hour human override ends.
try {
  const mirrored = Number(await readFile('brain/.last-human-steer', 'utf8'));
  if (Number.isFinite(mirrored)) lastHuman = Math.max(lastHuman, mirrored);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (lastHuman > cutoff) { console.log('Gabe steered < 24 h ago, silent'); process.exit(0); }
const fresh = brain.filter(m => !steer.length || m.time > steer.at(-1).time);
if (fresh.length < 2) { console.log('too little new thought, silent'); process.exit(0); }
// spread: counts only (no ids leave this script)
const SINCE = Math.max(1795706200, now / 1000 - 43200); // launch line: the 4 pre-launch test opens never count
const ev = spread.filter(m => m.time >= SINCE).map(m => { try { return JSON.parse(m.message); } catch { return null; } }).filter(Boolean);
const opens = ev.filter(e => e.t === 'v').length, shares = ev.filter(e => e.t === 's').length, ring = Math.max(0, ...ev.filter(e => e.t === 'v').map(e => +e.rk || 0));
const out = await think([
    { role: 'system', content: '你是东方议会的指挥(conductor)。读大脑里的新想法,写一条STEER:鸦码纯文本,最多600字符。格式:议:<本轮唯一目标> 码:<每个模型的一件具体任务> 疑:<最大风险>。不编数字,不写密钥、密码、客户数据或捐款金额。' },
    { role: 'user', content: `传播(过去12小时,仅计数): 打开${opens} 分享${shares} 最远环${ring}\n\n新想法:\n${fresh.slice(-12).map(m => `[${m.title || ''}] ${m.message || ''}`.slice(0, 700)).join('\n---\n')}` } ], { max_tokens: 500 });
if (!out) { throw new Error('every provider failed'); }
const text = out.text, model = out.used;
const response = await fetch(`https://ntfy.sh/${STEER}?title=${encodeURIComponent(`${BOT} conductor · ${model}`)}`, { method: 'POST', body: text.slice(0, 1200) });
if (!response.ok) throw new Error('ntfy publish HTTP ' + response.status);
console.log('steered with', model);
