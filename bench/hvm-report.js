// hvm-report.js — render the multi-pass grok_runner bench (bench/hvm-run.sh) as one
// markdown doc: per test × pass score/wall/calls/outcome, best + median wall vs the
// relay baseline, a tool histogram over ALL passes with a per-tool fumble count, and
// the fumble list. A FUMBLE is a call immediately followed by a retry (same tool, same
// target), by a different tool on the same target, or any failed call (something had
// to follow it). Targets come from the runner's run store (args are not in
// tool-usage.jsonl).
//
// node bench/hvm-report.js --since <iso> [--passes 3] [--client grok_runner] [--transport local] [--out docs/X.md]
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ALL_TESTS as TESTS } from './suite.js';
import { loadUsage } from './drive-runner.js';
import { load as loadResults } from './report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_FILE = join(homedir(), '.local', 'state', 'fastrun', 'runs.jsonl');
// relay-transport baseline (WSL, 2026-09-15), seconds
const BASELINE = { multipage: 16.9, staticform: 30.4, overlay: 66.0, flightsearch: 23.3, mapsdir: 41.9, extract: 5.7 };
const SKIPPED = { gcpform: 'needs a logged-in Google account', cfworkers: 'needs a logged-in Cloudflare account' };

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const since = flag('--since', '1970-01-01T00:00:00Z');
const passes = Number(flag('--passes', 3));
const client = flag('--client', 'grok_runner');
const transport = flag('--transport', 'local');
const out = flag('--out', null);
const notes = flag('--notes', ''); // "pass 1 on <sha>; fixer applied: …;" from hvm-run.sh

const inWindow = (r) => r.client === client && r.transport === transport && r.ts >= since;
const rows = loadResults().filter(inWindow).sort((a, b) => a.ts.localeCompare(b.ts));
const usage = loadUsage().filter((r) => r.client === client && r.ts >= since);
const runs = new Map();
try {
  for (const l of readFileSync(RUNS_FILE, 'utf8').trim().split('\n')) { try { const r = JSON.parse(l); runs.set(r.run_id, r); } catch { /* skip */ } }
} catch { /* no store */ }

// pass k = k-th occurrence of a test in ts order
const byTest = new Map();
for (const r of rows) { const l = byTest.get(r.testId) || []; l.push(r); byTest.set(r.testId, l); }
const tests = TESTS.filter((t) => byTest.has(t.id));
const secs = (ms) => (ms == null ? null : ms / 1000);
const fmt = (s) => (s == null ? '–' : `${s.toFixed(1)}s`);
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const flags = (r) => `${r.valid === false ? 'X' : ''}${r.stuck ? 'S' : ''}${r.claimedComplete === true && r.score < r.total ? '!' : ''}${r.claimedComplete === false ? '~' : ''}`;
const runIdOf = (r) => (/run_id=(\w+)/.exec(r?.notes || '') || [])[1] || null;
const recOf = (r) => runs.get(runIdOf(r)) || null;
// model time = sum of per-turn latencyMs (runs.jsonl `turns`, present from a9a1cd0 on)
const modelMs = (rec) => (rec?.turns?.length ? rec.turns.reduce((s, t) => s + (t.latencyMs || 0), 0) : null);
const cell = (r) => {
  if (!r) return '–';
  const m = modelMs(recOf(r));
  return `${r.score}/${r.total} ${fmt(secs(r.wallMs))} ${r.toolCalls}c${m != null ? ` m=${fmt(m / 1000)}` : ''}${flags(r) ? ` ${flags(r)}` : ''}`;
};

const targetOf = (a = {}) => {
  for (const k of ['target', 'selector', 'text', 'match', 'name', 'url', 'intent', 'near', 'to', 'value']) if (a[k] != null && a[k] !== '') return `${k}=${String(a[k]).slice(0, 60)}`;
  if (a.index != null) return `index=${a.index}`;
  if (a.x != null && a.y != null) return `xy=${a.x},${a.y}`;
  if (a.fields) return `fields=${Object.keys(a.fields).join(',').slice(0, 60)}`;
  return null;
};

// histogram + fumbles over every pass (each usage row = one cell)
const agg = new Map(); const fumbles = [];
const passOf = new Map(); // runId → pass index
for (const [id, list] of byTest) list.forEach((r, i) => { const m = /run_id=(\w+)/.exec(r.notes || ''); if (m) passOf.set(m[1], { pass: i + 1, testId: id }); });
for (const u of usage) {
  const rec = runs.get(u.runId);
  const log = rec?.toolLog || u.toolLog;
  const where = passOf.get(u.runId) || { pass: '?', testId: u.testId };
  log.forEach((e, i) => {
    const a = agg.get(e.name) || { calls: 0, errors: 0, ms: 0, fumbles: 0, tests: new Set() };
    a.calls++; if (!e.ok) a.errors++; a.ms += e.ms; a.tests.add(u.testId); agg.set(e.name, a);
    const next = log[i + 1]; if (!next) return;
    const t1 = targetOf(e.args), t2 = targetOf(next.args);
    let why = null;
    if (!e.ok) why = 'failed → followed by ' + next.name;
    else if (t1 && t1 === t2) why = next.name === e.name ? 'retry (same tool, same target)' : `switched to ${next.name} on the same target`;
    if (!why) return;
    a.fumbles++;
    fumbles.push(`- pass ${where.pass} ${where.testId} #${i + 1}: \`${e.name}\`${t1 ? ` (${t1})` : ''} — ${why}${!e.ok && e.preview ? ` — ${String(e.preview).replace(/\s+/g, ' ').slice(0, 100)}` : ''}`);
  });
}

const md = [];
md.push(`# Grok runner bench — hvm, ${transport} transport (${since.slice(0, 10)})`, '');
md.push(`Client \`${client}\`, ${passes} pass(es) over ${tests.length} tests, driven by \`bench/hvm-run.sh\` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since ${since}.`, '');
md.push('Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.', '');
md.push(`Skipped as environment-invalid (fresh profile, no login): ${Object.entries(SKIPPED).map(([k, v]) => `\`${k}\` (${v})`).join(', ')}.`, '');
if (notes.trim()) md.push(`Runtime per pass: ${notes.trim()}`, '');
// what the run store says each pass actually ran (model / toolset / gate), independent of the notes
// (rows written before the gate mode existed ran with the gate on)
const passRuntime = new Map();
for (const list of byTest.values()) list.forEach((r, i) => { const rec = recOf(r); if (rec) { const k = `${rec.model || '?'}/${rec.toolset || 'default'}/gate ${rec.gate || 'on'}`; const s = passRuntime.get(i + 1) || new Set(); s.add(k); passRuntime.set(i + 1, s); } });
if (passRuntime.size) md.push(`Run store per pass (model/toolset/gate): ${[...passRuntime.entries()].sort((a, b) => a[0] - b[0]).map(([p, s]) => `pass ${p} = ${[...s].join(' + ')}`).join('; ')}.`, '');
md.push('## Per test', '', 'Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.', '');
md.push(`| test | ${Array.from({ length: passes }, (_, i) => `pass ${i + 1}`).join(' | ')} | best wall | median wall | median calls | score | baseline wall | best vs baseline |`);
md.push(`|---|${'---|'.repeat(passes)}---:|---:|---:|---|---:|---:|`);
for (const t of tests) {
  const list = byTest.get(t.id);
  const valid = list.filter((r) => r.valid !== false);
  const walls = valid.map((r) => secs(r.wallMs)).filter((x) => x != null);
  const best = walls.length ? Math.min(...walls) : null;
  const med = median(walls);
  const calls = median(valid.map((r) => r.toolCalls));
  const score = valid.length ? `${Math.min(...valid.map((r) => r.score))}–${Math.max(...valid.map((r) => r.score))}/${valid[0].total}` : '–';
  const base = BASELINE[t.id];
  const delta = best != null && base ? `${best <= base ? '−' : '+'}${Math.abs(best - base).toFixed(1)}s (${((best / base - 1) * 100).toFixed(0)}%)` : '–';
  md.push(`| ${t.id} | ${Array.from({ length: passes }, (_, i) => cell(list[i])).join(' | ')} | ${fmt(best)} | ${fmt(med)} | ${calls ?? '–'} | ${score} | ${base ? fmt(base) : '–'} | ${delta} |`);
}
const validRows = rows.filter((r) => r.valid !== false);
md.push('', `Totals over valid cells: ${validRows.length} cells, ${validRows.reduce((s, r) => s + r.score, 0)}/${validRows.reduce((s, r) => s + r.total, 0)} checkpoints, ${validRows.reduce((s, r) => s + r.toolCalls, 0)} tool calls, ${fmt(secs(validRows.reduce((s, r) => s + (r.wallMs || 0), 0)))} wall.`, '');
const outcomes = rows.map((r) => `${r.testId}#${passOf.get((/run_id=(\w+)/.exec(r.notes || '') || [])[1])?.pass ?? '?'}=${r.outcome}${r.invalidReason ? ` (${r.invalidReason})` : ''}`);
md.push(`Outcomes: ${outcomes.join(', ') || 'none'}.`, '');

// gate=record: each report the gate WOULD have refused, next to what the page actually scored
// (a would-be refusal on a full-score cell = the gate would have been wrong)
const would = [];
for (const [id, list] of byTest) list.forEach((r, i) => {
  for (const w of recOf(r)?.gateWouldRefuse || []) would.push(`- pass ${i + 1} ${id}: scored ${r.score}/${r.total} (${r.score === r.total ? 'full — the gate would have been WRONG' : 'short — the gate would have been RIGHT'}) — ${w.problems.map((p) => p.replace(/\s+/g, ' ').slice(0, 160)).join(' | ')}`);
});
const overclaims = rows.filter((r) => r.claimedComplete === true && r.score < r.total).map((r) => `- pass ${passOf.get(runIdOf(r))?.pass ?? '?'} ${r.testId}: reported done at ${r.score}/${r.total}${recOf(r)?.gateWouldRefuse ? ' (the gate would have refused)' : ' (the gate would NOT have caught it)'}`);
if (rows.some((r) => recOf(r)?.gate === 'record')) md.push('## Gate would-refuse (gate=record)', '', ...(would.length ? would : ['- none']), '', '## Overclaims (reported done, score < total)', '', ...(overclaims.length ? overclaims : ['- none']), '');

md.push('## Tool histogram (all passes)', '', '| tool | calls | errors | avg ms | fumbles | tests used in |', '|---|---:|---:|---:|---:|---|');
const order = TESTS.map((t) => t.id);
for (const n of [...agg.keys()].sort((a, b) => agg.get(b).calls - agg.get(a).calls || a.localeCompare(b))) {
  const a = agg.get(n);
  md.push(`| ${n} | ${a.calls} | ${a.errors} | ${Math.round(a.ms / a.calls)} | ${a.fumbles} | ${[...a.tests].sort((x, y) => order.indexOf(x) - order.indexOf(y)).join(', ')} |`);
}
const total = [...agg.values()].reduce((s, a) => s + a.calls, 0);
md.push('', `Total: ${total} calls across ${agg.size} distinct tools, ${fumbles.length} fumbles.`, '');
md.push('## Fumbles', '', ...(fumbles.length ? fumbles : ['- none']), '');

const text = md.join('\n');
if (out) { writeFileSync(join(HERE, '..', out), text); console.log(`wrote ${out} (${rows.length} cells)`); }
else console.log(text);
