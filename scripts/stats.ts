// Honest shipping stats. Walks every repo I own or contribute to (private included),
// counts lines I authored per day, and never writes a private repo name anywhere.
// Run: GH_STATS_TOKEN=... npx tsx scripts/stats.ts   |   npx tsx scripts/stats.ts --demo
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { renderAll } from "./render.ts";

export type Day = { lines: number; add: number; del: number; commits: number; ai: number };
export type Stats = {
  generated: string;
  login: string;
  partial: boolean;
  days: Record<string, Day>;
  langs: Record<string, number>;
  agents: { claude: number; codex: number; commits: number; aiLines: number; lines: number };
  totals: { commits: number; prs: number; repos: number };
  rules: string;
};
type Row = [string, number, number, number, Record<string, number>]; // date, add, del, agent(0 none/1 claude/2 codex/3 both), lang->lines

const TOKEN = process.env.GH_STATS_TOKEN;
const DEMO = process.argv.includes("--demo");
const TZ = "Europe/Brussels";
const DAYS = 365;
const CACHE = "stats/.cache.json";

// ---- the honesty rules -------------------------------------------------
const SKIP_DIR = /(^|\/)(node_modules|vendor|vendored|third_party|dist|build|out|\.next|coverage|__pycache__|\.venv|Pods|target|generated|__generated__)\//;
const LOCK = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|Package\.resolved|flake\.lock)$/;
const MIN = /(\.min\.(js|css)|\.map|\.bundle\.[a-z]+)$/;
const GEN = /(\.generated\.|\.gen\.|_pb2?\.py|\.pb\.go|\.snap)$/;
const BIN = /\.(png|jpe?g|gif|webp|avif|ico|pdf|wasm|zip|gz|tar|mp[34]|mov|webm|woff2?|ttf|otf|eot|svg|bin|dmg|psd|mz3|nii|glb|gltf)$/i;
const DATA = /\.(json|csv|tsv|ndjson|jsonl)$/i;
export const RULES =
  "Excluded: lockfiles, node_modules, dist/build/out, vendored and generated code, minified files and maps, " +
  "binaries and svg, json/csv/ndjson diffs over 500 lines. Lines = additions + deletions I authored.";

export function counts(f: { filename: string; additions: number; deletions: number; patch?: string }): boolean {
  const n = f.additions + f.deletions;
  if (!n) return false;
  if (SKIP_DIR.test(f.filename) || LOCK.test(f.filename) || MIN.test(f.filename) || GEN.test(f.filename)) return false;
  if (BIN.test(f.filename)) return false;
  if (f.patch === undefined) return false; // binary or too large for GitHub to diff
  if (DATA.test(f.filename) && n > 500) return false;
  return true;
}

const LANG: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript",
  rs: "Rust", c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++", py: "Python", html: "HTML", css: "CSS",
  md: "Markdown", pl: "Prolog", lean: "Lean", hs: "Haskell", k: "k", bqn: "BQN", typ: "Typst", sh: "Shell",
  yml: "YAML", yaml: "YAML", json: "JSON", toml: "TOML", sql: "SQL", go: "Go", swift: "Swift", glsl: "GLSL",
};
const langOf = (p: string) => LANG[(p.split(".").pop() || "").toLowerCase()] || "Other";

// ---- github ------------------------------------------------------------
async function gh(path: string, tries = 4): Promise<{ data: any; remaining: number }> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(path.startsWith("http") ? path : `https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json", "user-agent": "gabe-stats" },
    });
    const remaining = Number(r.headers.get("x-ratelimit-remaining") ?? 1000);
    if (r.ok) return { data: await r.json(), remaining };
    if (r.status === 409 || r.status === 404 || r.status === 451) return { data: [], remaining }; // empty/gone repo
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      if (remaining === 0 && reset - Date.now() > 120_000) throw new Error("rate-limited");
      await new Promise((s) => setTimeout(s, Math.min(60_000, Math.max(2000, reset - Date.now()))));
      continue;
    }
    await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
  }
  throw new Error(`failed ${path.split("?")[0].replace(/\/repos\/[^/]+\/[^/]+/, "/repos/*")}`); // never echo repo names
}
async function pages(path: string, max = 30) {
  const out: any[] = [];
  for (let p = 1; p <= max; p++) {
    const { data } = await gh(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${p}`);
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
const key = (repo: string, sha: string) => createHash("sha256").update(`${repo}@${sha}`).digest("hex").slice(0, 24);
const CLAUDE = /co-authored-by:[^\n]*claude/i;
const CODEX = /(co-authored-by:[^\n]*(codex|openai)|generated (with|by)[^\n]*codex)/i;

async function collect(): Promise<Stats> {
  const me = (await gh("/user")).data.login as string;
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const cache: Record<string, Row> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  const repos = await pages("/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed");
  const active = repos.filter((r) => r.pushed_at && r.pushed_at >= since && !r.archived);
  const rows: Row[] = [];
  const touched = new Set<string>();
  let partial = false;

  outer: for (const r of active) {
    let list: any[];
    try {
      list = await pages(`/repos/${r.full_name}/commits?author=${me}&since=${since}`);
    } catch (e) {
      if ((e as Error).message === "rate-limited") { partial = true; break; }
      continue;
    }
    if (list.length) touched.add(createHash("sha256").update(r.full_name).digest("hex"));
    for (const c of list) {
      const k = key(r.full_name, c.sha);
      if (!cache[k]) {
        try {
          const { data: d, remaining } = await gh(`/repos/${r.full_name}/commits/${c.sha}`);
          const msg: string = d.commit?.message ?? "";
          const by: string = `${d.commit?.committer?.name ?? ""} ${d.author?.login ?? ""}`;
          const agent = (CLAUDE.test(msg) ? 1 : 0) | (CODEX.test(msg) || /codex/i.test(by) ? 2 : 0);
          let add = 0, del = 0;
          const langs: Record<string, number> = {};
          for (const f of d.files ?? []) {
            if (!counts(f)) continue;
            add += f.additions; del += f.deletions;
            langs[langOf(f.filename)] = (langs[langOf(f.filename)] ?? 0) + f.additions + f.deletions;
          }
          cache[k] = [day(c.commit.author.date), add, del, agent, langs];
          if (remaining < 150) { partial = true; break outer; }
        } catch { partial = true; break outer; }
      }
      rows.push(cache[k]);
    }
  }
  mkdirSync("stats", { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache)); // keys are hashed, no names inside

  let prs = 0;
  try {
    const d = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
    prs = (await gh(`/search/issues?q=${encodeURIComponent(`author:${me} type:pr created:>=${d}`)}&per_page=1`)).data.total_count ?? 0;
  } catch {}
  return aggregate(me, rows, touched.size, prs, partial);
}

export function aggregate(login: string, rows: Row[], repos: number, prs: number, partial: boolean): Stats {
  const days: Record<string, Day> = {};
  const langs: Record<string, number> = {};
  const a = { claude: 0, codex: 0, commits: 0, aiLines: 0, lines: 0 };
  for (const [date, add, del, agent, l] of rows) {
    const d = (days[date] ??= { lines: 0, add: 0, del: 0, commits: 0, ai: 0 });
    d.lines += add + del; d.add += add; d.del += del; d.commits++;
    a.lines += add + del;
    if (agent) { d.ai += add + del; a.aiLines += add + del; a.commits++; }
    if (agent & 1) a.claude++;
    if (agent & 2) a.codex++;
    for (const [k, v] of Object.entries(l)) langs[k] = (langs[k] ?? 0) + v;
  }
  return { generated: new Date().toISOString(), login, partial, days, langs, agents: a, totals: { commits: rows.length, prs, repos }, rules: RULES };
}

function demo(): Stats {
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const rows: Row[] = [];
  for (let i = 0; i < DAYS; i++) {
    if (rnd() < 0.25) continue;
    const date = new Date(Date.now() - i * 864e5).toLocaleDateString("en-CA", { timeZone: TZ });
    const n = 1 + Math.floor(rnd() * 6) * (i < 40 ? 3 : 1);
    for (let j = 0; j < n; j++)
      rows.push([date, Math.floor(rnd() ** 2 * 600), Math.floor(rnd() ** 3 * 200), rnd() < (i < 60 ? 0.8 : 0.2) ? (rnd() < 0.7 ? 1 : 2) : 0,
        { JavaScript: Math.floor(rnd() * 300), Rust: Math.floor(rnd() * 120), C: Math.floor(rnd() * 80), HTML: Math.floor(rnd() * 100), Markdown: Math.floor(rnd() * 60) }]);
  }
  return aggregate("demo", rows, 9, 41, false);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!DEMO && !TOKEN) { console.error("GH_STATS_TOKEN missing"); process.exit(1); }
  const stats = DEMO ? demo() : await collect();
  const out = DEMO ? "stats/demo" : "stats";
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/stats.json`, JSON.stringify(stats, null, 1) + "\n");
  for (const [name, svg] of Object.entries(renderAll(stats))) writeFileSync(`${out}/${name}`, svg);
  console.log(`ok${stats.partial ? " (partial: rate limit)" : ""}: ${stats.totals.commits} commits, ${stats.totals.repos} repos`);
}
