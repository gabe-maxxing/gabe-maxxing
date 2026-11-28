// Corvus-styled SVG cards. Two themes each; README picks via <picture>.
import type { Stats } from "./stats.ts";

type T = { bg: string; edge: string; fg: string; mute: string; purple: string; gold: string; grid: string };
const THEMES: Record<string, T> = {
  dark: { bg: "#0d0b14", edge: "#241f33", fg: "#ece8f5", mute: "#8c84a0", purple: "#b4a0d6", gold: "#ffd76a", grid: "#1b1727" },
  light: { bg: "#faf8fd", edge: "#e4ddef", fg: "#1a1426", mute: "#6b6280", purple: "#7a5fb0", gold: "#a87400", grid: "#ece7f4" },
};
const SERIF = `'Bodoni Moda','Bodoni 72',Didot,'Playfair Display',Georgia,serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;
const W = 800;

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString("en-US"));
const dstr = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Brussels" });
const back = (i: number) => dstr(new Date(Date.now() - i * 864e5));

function frame(t: T, h: number, title: string, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<rect x=".5" y=".5" width="${W - 1}" height="${h - 1}" rx="14" fill="${t.bg}" stroke="${t.edge}"/>
${body}
</svg>
`;
}
const label = (t: T, x: number, y: number, s: string) =>
  `<text x="${x}" y="${y}" font-family="${MONO}" font-size="12" letter-spacing="2.4" fill="${t.mute}">${esc(s.toUpperCase())}</text>`;
const motto = (t: T) =>
  `<text x="${W - 32}" y="30" text-anchor="end" font-family="${SERIF}" font-size="11" letter-spacing="3" fill="${t.mute}" opacity=".7">ΓΝΩΘΙ ΣΑΥΤΟΝ</text>`;

function lastN(s: Stats, n: number) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s.days[back(i)]?.lines ?? 0;
  return sum;
}

const hero = (t: T) =>
  frame(t, 220, "gabe",
    `<text x="40" y="150" font-family="${SERIF}" font-style="italic" font-weight="500" font-size="150" letter-spacing="-4" fill="${t.fg}">gabe</text>
<text x="${W - 40}" y="150" text-anchor="end" font-family="${SERIF}" font-size="22" fill="${t.purple}">hello.</text>
<rect x="42" y="198" width="44" height="2" fill="${t.gold}"/>
${motto(t)}`);

const linesShipped = (s: Stats, t: T) => {
  const m = lastN(s, 30), today = s.days[back(0)]?.lines ?? 0;
  return frame(t, 230, `${m} lines shipped in the last 30 days`,
    `${label(t, 32, 34, "lines shipped · last 30 days")}${motto(t)}
<text x="32" y="140" font-family="${SERIF}" font-size="104" font-weight="500" fill="${t.gold}">${fmt(m)}</text>
<line x1="32" y1="168" x2="${W - 32}" y2="168" stroke="${t.edge}"/>
<text x="32" y="200" font-family="${MONO}" font-size="15" fill="${t.fg}">${fmt(today)}<tspan fill="${t.mute}"> today</tspan>    ${fmt(Math.round(m / 30))}<tspan fill="${t.mute}"> daily avg</tspan></text>
<text x="${W - 32}" y="216" text-anchor="end" font-family="${MONO}" font-size="10" fill="${t.mute}">additions + deletions, noise excluded</text>`);
};

const summary = (s: Stats, t: T) =>
  frame(t, 96, "commits, pull requests, repos",
    `<text x="${W / 2}" y="58" text-anchor="middle" font-family="${SERIF}" font-size="30" fill="${t.fg}">${fmt(s.totals.commits)}<tspan font-family="${MONO}" font-size="13" fill="${t.mute}"> commits</tspan><tspan fill="${t.purple}">  ·  </tspan>${fmt(s.totals.prs)}<tspan font-family="${MONO}" font-size="13" fill="${t.mute}"> PRs</tspan><tspan fill="${t.purple}">  ·  </tspan>${fmt(s.totals.repos)}<tspan font-family="${MONO}" font-size="13" fill="${t.mute}"> repos</tspan></text>
<text x="${W / 2}" y="80" text-anchor="middle" font-family="${MONO}" font-size="10" letter-spacing="2" fill="${t.mute}">LAST 365 DAYS · PRIVATE REPOS COUNTED, NEVER NAMED</text>`);

const heatmap = (s: Stats, t: T) => {
  const cell = 11, gap = 3, x0 = 32, y0 = 56, today = new Date();
  const dow = (today.getUTCDay() + 6) % 7; // monday=0
  const vals = Array.from({ length: 365 }, (_, i) => s.days[back(i)]?.lines ?? 0);
  const max = Math.max(1, ...vals);
  const lvl = (v: number) => (v === 0 ? 0 : Math.min(4, 1 + Math.floor((Math.log(v) / Math.log(max)) * 3.999)));
  const op = [0, 0.28, 0.5, 0.75, 1];
  let cells = "";
  for (let i = 0; i < 365; i++) {
    const col = 52 - Math.floor((i + (6 - dow)) / 7), row = 6 - ((i + (6 - dow)) % 7);
    const l = lvl(vals[i]);
    const fill = l ? t.purple : t.grid;
    cells += `<rect x="${x0 + col * (cell + gap)}" y="${y0 + row * (cell + gap)}" width="${cell}" height="${cell}" rx="2.5" fill="${fill}"${l ? ` fill-opacity="${op[l]}"` : ""}><title>${back(i)}: ${vals[i].toLocaleString("en-US")} lines</title></rect>`;
  }
  return frame(t, 168, "lines per day, last 365 days",
    `${label(t, 32, 34, "lines per day · 365 days")}${motto(t)}${cells}`);
};

const stack = (s: Stats, t: T) => {
  const ent = Object.entries(s.langs).filter(([k]) => k !== "Other").sort((a, b) => b[1] - a[1]);
  const top = ent.slice(0, 6), rest = ent.slice(6).reduce((n, [, v]) => n + v, 0);
  const all = rest ? [...top, ["other", rest] as [string, number]] : top;
  const total = all.reduce((n, [, v]) => n + v, 0) || 1;
  const shades = [t.gold, t.purple, t.fg, t.purple, t.mute, t.purple, t.grid];
  const ops = [1, 1, 0.9, 0.62, 0.9, 0.38, 1];
  let x = 32, bar = "", legend = "";
  const bw = W - 64;
  all.forEach(([k, v], i) => {
    const w = Math.max(2, (v / total) * bw);
    bar += `<rect x="${x.toFixed(1)}" y="56" width="${(w - 2).toFixed(1)}" height="18" rx="3" fill="${shades[i]}" fill-opacity="${ops[i]}"/>`;
    x += w;
    const lx = 32 + (i % 4) * 190, ly = 108 + Math.floor(i / 4) * 24;
    legend += `<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${shades[i]}" fill-opacity="${ops[i]}"/><text x="${lx + 18}" y="${ly}" font-family="${MONO}" font-size="12" fill="${t.fg}">${esc(k)} <tspan fill="${t.mute}">${Math.round((v / total) * 100)}%</tspan></text>`;
  });
  return frame(t, 168, "languages by lines shipped",
    `${label(t, 32, 34, "stack · by lines shipped")}${motto(t)}${bar}${legend}`);
};

const agents = (s: Stats, t: T) => {
  const a = s.agents, pct = a.lines ? Math.round((a.aiLines / a.lines) * 100) : 0;
  const both = a.claude + a.codex || 1, cw = Math.round(((a.claude / both) * (W - 64)));
  return frame(t, 176, "built with a fleet of agents",
    `${label(t, 32, 34, "built with a fleet of agents")}${motto(t)}
<text x="32" y="96" font-family="${SERIF}" font-size="58" fill="${t.gold}">${pct}%<tspan font-family="${MONO}" font-size="13" fill="${t.mute}">  of lines came from agent-assisted commits</tspan></text>
<rect x="32" y="118" width="${Math.max(2, cw - 2)}" height="12" rx="3" fill="${t.purple}"/>
<rect x="${32 + cw}" y="118" width="${Math.max(2, W - 64 - cw)}" height="12" rx="3" fill="${t.gold}"/>
<text x="32" y="156" font-family="${MONO}" font-size="12" fill="${t.fg}">Claude Code <tspan fill="${t.mute}">${fmt(a.claude)} commits</tspan></text>
<text x="${W - 32}" y="156" text-anchor="end" font-family="${MONO}" font-size="12" fill="${t.fg}">Codex <tspan fill="${t.mute}">${fmt(a.codex)} commits</tspan></text>`);
};

const streak = (s: Stats, t: T) => {
  let cur = 0, best = 0, run = 0;
  const start = (s.days[back(0)]?.lines ?? 0) > 0 ? 0 : 1; // today may still be empty
  for (let i = start; i < 365 && (s.days[back(i)]?.lines ?? 0) > 0; i++) cur++;
  for (let i = 0; i < 365; i++) { run = (s.days[back(i)]?.lines ?? 0) > 0 ? run + 1 : 0; best = Math.max(best, run); }
  return frame(t, 132, "shipping streak",
    `${label(t, 32, 34, "shipping streak")}${motto(t)}
<text x="32" y="96" font-family="${SERIF}" font-size="52" fill="${t.gold}">${cur}<tspan font-family="${MONO}" font-size="13" fill="${t.mute}"> days now</tspan></text>
<text x="${W - 32}" y="96" text-anchor="end" font-family="${SERIF}" font-size="52" fill="${t.purple}">${best}<tspan font-family="${MONO}" font-size="13" fill="${t.mute}"> days longest</tspan></text>`);
};

export function renderAll(s: Stats): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, t] of Object.entries(THEMES)) {
    const suf = name === "dark" ? "-dark" : "";
    out[`lines-shipped${suf}.svg`] = linesShipped(s, t);
    out[`summary${suf}.svg`] = summary(s, t);
    out[`heatmap${suf}.svg`] = heatmap(s, t);
    out[`stack${suf}.svg`] = stack(s, t);
    out[`agents${suf}.svg`] = agents(s, t);
    out[`streak${suf}.svg`] = streak(s, t);
    out[`gabe${suf}.svg`] = hero(t);
  }
  return out;
}
