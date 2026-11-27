// spread mirror · copies every anonymous share/visit event from ntfy (kept ~12 h) into spread/events.ndjson (kept forever).
// strict schema: anything that is not a clean event is dropped, so the public topic cannot inject junk into the map.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
const TOPIC = 'corvus-spread-1729';
const SINCE = 1795706200; // launch line (unix s): test events before this never count
await mkdir('spread', { recursive: true });
const seen = new Set((await readFile('spread/.seen', 'utf8').catch(() => '')).split('\n').filter(Boolean));
const ID = /^(gabe|\d{1,3}-[a-z0-9]{3,8})$/, CH = /^(wa|tg|li|sms|copy|more|qr|link)$/;
const clean = (m) => { let e; try { e = JSON.parse(m.message); } catch { return null; }
  if (e.v !== 1) return null;
  const out = { t: e.t, ts: m.time * 1000, c: CH.test(e.c) ? e.c : 'link' };
  if (e.t === 'v' && ID.test(e.p)) return { ...out, p: e.p, l: String(e.l || '').slice(0, 2) };
  if (e.t === 's' && ID.test(e.id) && (e.p === '' || ID.test(e.p))) return { ...out, id: e.id, p: e.p };
  return null; };
const body = await (await fetch(`https://ntfy.sh/${TOPIC}/json?poll=1&since=all`)).text();
let added = 0;
for (const m of body.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.event === 'message' && !seen.has(m.id)).sort((a, b) => a.time - b.time)) {
  seen.add(m.id); if (m.time < SINCE) continue; const e = clean(m); if (!e) continue;
  await appendFile('spread/events.ndjson', JSON.stringify({ ...e, k: m.id }) + '\n'); added++;
}
await writeFile('spread/.seen', [...seen].slice(-20000).join('\n') + '\n');
console.log('spread mirrored', added);
