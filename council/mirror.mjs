// brain mirror · copies every thought from the free inbox (ntfy.sh) into this repo, forever.
// ntfy keeps messages only briefly; git keeps them. no keys needed.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';

const TOPICS = { brain: 'corvus-brain-1729', steer: 'corvus-steer-1729' };
await mkdir('brain', { recursive: true });
const seen = new Set((await readFile('brain/.seen', 'utf8').catch(() => '')).split('\n').filter(Boolean));
let added = 0;
for (const [kind, topic] of Object.entries(TOPICS)) {
  const body = await (await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=all`)).text();
  const msgs = body.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.event === 'message' && !seen.has(m.id));
  for (const m of msgs.sort((a, b) => a.time - b.time)) {
    const day = new Date(m.time * 1000).toISOString().slice(0, 10), at = new Date(m.time * 1000).toISOString().slice(11, 16);
    const text = String(m.message || '').replace(/\r/g, '').slice(0, 4000);
    await appendFile(`brain/${day}.md`, `\n### ${kind === 'steer' ? '🎼 STEER' : '🧠'} ${(m.title || '').replace(/\n/g, ' ')} · ${at} UTC\n\n${text}\n`);
    seen.add(m.id); added++;
  }
}
await writeFile('brain/.seen', [...seen].join('\n') + '\n');
console.log('mirrored', added);
