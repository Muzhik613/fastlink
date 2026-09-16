// drive-runner.js — submit a benchmark prompt through fast-runner (Grok agent loop
// over the FastLink relay) instead of a chat website. Mirrors drive-web.js's
// phases so run.js swaps drivers, not flow:
//     preflight → start (spawn cli.mjs) → watch → waitForIdle → readFinalMessage
//
// TRACE SOURCE: the runner's own tool calls. cli.mjs streams one stderr line per
// call (`[1.2s] ok fast_snapshot {...}`) — that feeds the live watch. When the
// process exits, the exact toolLog for the run (with args) is read from the
// runner's run store (~/.local/state/fastrun/runs.jsonl, keyed by run_id) and
// REPLACES the streamed rows, so the record is the store, the stream is only the
// live view. Rows carry the same shape as monitor.js's RelayTrace rows.
//
// FINISH SIGNAL: process exit — not a quiet period. With a chat site the only
// evidence a turn ended is silence; here the agent loop is a subprocess whose
// exit is authoritative. STUCK / NO_ACTIVITY keep monitor.js's meaning: STUCK =
// ceiling hit or ≥2 calls at the 30s broker timeout; NO_ACTIVITY = exited with
// zero FastLink calls.
//
// ask_caller: nobody is on the other end during a bench, so a question is answered
// with a fixed "proceed" line — the run continues instead of hanging to the ceiling.
import { spawn } from 'child_process';
import { readFileSync, appendFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULTS, summarize } from './monitor.js';
import { ALL_TESTS as TESTS } from './suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'fast-runner', 'cli.mjs');
const RUNS_FILE = join(homedir(), '.local', 'state', 'fastrun', 'runs.jsonl');
export const USAGE_JSONL = join(HERE, 'tool-usage.jsonl');
export const USAGE_MD = join(HERE, 'tool-usage.md');

const TIMEOUT_ROWS_FOR_STUCK = 2; // same threshold as monitor.js
const NO_ONE_HOME = 'No one is available to answer. Use your best judgement, proceed, and finish the task with report_done.';
const TOOL_LINE = /^\s*\[(\d+(?:\.\d+)?)s\] (ok |ERR) (\S+)/;

/** Prove the channel the runner will use: a relay session as the runner's own
 *  OAuth client, pinned to `browser`, reporting connected. */
export async function preflight({ browser = null } = {}) {
  const { connectRelay } = await import('../fast-runner/relay-transport.mjs');
  const relay = await connectRelay({ browser });
  try {
    const st = JSON.parse((await relay.callTool('fast_status', {})).content[0].text);
    if (!st.connected) throw new Error(`relay: ${st.targetError || st.hint}`);
    return `runner relay preflight ok: driving "${st.routedBrowser}" (${st.selectionMode}) as user ${st.userId}`;
  } finally { await relay.close(); }
}

/** Trace source with RelayTrace's interface (poll/rows/lastError/clients/lastRowAt). */
export class RunnerTrace {
  constructor() { this.rows = []; this.lastError = null; this.clients = new Set(['fast-runner']); this._pending = []; }
  push(row) { this._pending.push(row); }
  replace(rows) { this.rows = rows.slice().sort((a, b) => a.t - b.t); this._pending = []; }
  async poll() {
    const n = this._pending.length;
    if (n) { this.rows.push(...this._pending); this._pending = []; }
    return n;
  }
  get lastRowAt() { return this.rows.length ? this.rows[this.rows.length - 1].t : null; }
}

/** Spawn the runner on `prompt`. Returns a handle; nothing is awaited here so
 *  run.js can start watching immediately. */
export function start(prompt, { browser = null, transport = 'relay', toolset = null } = {}) {
  const args = [CLI, transport === 'local' ? '--local' : '--relay'];
  if (browser) args.push('--browser', browser);
  if (toolset) args.push('--toolset', toolset);
  if (process.env.FASTRUN_GATE) args.push('--gate', process.env.FASTRUN_GATE); // report_done gate mode (on | record | off)
  args.push(prompt);
  const proc = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const handle = {
    proc, trace: new RunnerTrace(), startedAt: Date.now(), exited: null, stdout: '', stderrTail: [],
    final: null, runId: null, toolLog: [], questions: 0,
    done: new Promise((resolve) => proc.on('close', (code) => { handle.exited = { code, at: Date.now() }; resolve(code); })),
  };
  proc.stdout.on('data', (d) => { handle.stdout += d; });
  let buf = '';
  proc.stderr.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      handle.stderrTail.push(line); if (handle.stderrTail.length > 40) handle.stderrTail.shift();
      const m = TOOL_LINE.exec(line);
      if (m) { handle.trace.push({ t: Date.now(), name: m[3], durMs: Math.round(Number(m[1]) * 1000), ok: m[2] === 'ok ', session: 'runner', client: 'fast-runner' }); continue; }
      if (/^\? /.test(line)) { handle.questions++; proc.stdin.write(NO_ONE_HOME + '\n'); }
    }
  });
  proc.on('error', (e) => { handle.trace.lastError = e.message; });
  return handle;
}

/** Watch loop. Same outcomes as monitor.watchRun; exit replaces quiet. */
export async function watch(handle, { ceilingMs = DEFAULTS.ceilingMs, pollMs = DEFAULTS.pollMs, onTick = null, startedAt = handle.startedAt } = {}) {
  for (;;) {
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, pollMs))]);
    await handle.trace.poll();
    const now = Date.now();
    const elapsed = now - startedAt;
    const sum = summarize(handle.trace.rows);
    onTick?.({ elapsed, quietFor: sum.lastEnd ? now - sum.lastEnd : elapsed, calls: sum.toolCalls, timeouts: sum.timeouts, lastError: handle.trace.lastError });
    if (sum.timeouts >= TIMEOUT_ROWS_FOR_STUCK) {
      handle.proc.kill('SIGTERM');
      return { outcome: 'STUCK', reason: `${sum.timeouts} tool calls hit the 30s broker timeout — the tab is wedged; kill and re-run`, ...sum, elapsed };
    }
    if (elapsed >= ceilingMs) {
      handle.proc.kill('SIGTERM');
      return { outcome: 'STUCK', reason: `hard ceiling ${Math.round(ceilingMs / 1000)}s exceeded`, ...sum, elapsed };
    }
    if (handle.exited) {
      await handle.trace.poll();
      const final = summarize(handle.trace.rows);
      if (final.toolCalls === 0) {
        return { outcome: 'NO_ACTIVITY', reason: `runner exited (code ${handle.exited.code}) without a single FastLink call${handle.trace.lastError ? `: ${handle.trace.lastError}` : ''}`, ...final, elapsed };
      }
      return { outcome: 'FINISHED', reason: `runner exited (code ${handle.exited.code})`, ...final, elapsed };
    }
  }
}

/** Wait for the process; then swap the streamed rows for the run store's exact
 *  toolLog (absolute t = startedAt + t + ms, i.e. the END timestamp like relay rows). */
export async function waitForIdle(handle, { timeoutMs = 60_000 } = {}) {
  const t = setTimeout(() => handle.proc.kill('SIGKILL'), timeoutMs);
  await handle.done; clearTimeout(t);
  try { handle.final = JSON.parse(handle.stdout); } catch { handle.final = null; }
  handle.runId = handle.final?.run_id || null;
  const rec = handle.runId ? readRun(handle.runId) : null;
  if (rec) {
    // ms < 0 = Date.now() jumped backwards inside the runner (WSL clock skew after
    // host sleep); clamp so the duration sums stay sane.
    handle.toolLog = (rec.toolLog || []).map((e) => ({ ...e, ms: Math.max(0, e.ms) }));
    const t0 = Date.parse(rec.startedAt);
    handle.trace.replace(handle.toolLog.map((e) => ({ t: t0 + e.t + e.ms, name: e.name, durMs: e.ms, ok: e.ok, session: rec.run_id, client: 'fast-runner' })));
  }
  return { idle: !!handle.exited, sawGenerating: true, record: !!rec };
}

function readRun(runId) {
  let raw;
  try { raw = readFileSync(RUNS_FILE, 'utf8'); } catch { return null; }
  for (const line of raw.trim().split('\n').reverse()) {
    try { const r = JSON.parse(line); if (r.run_id === runId) return r; } catch { /* skip */ }
  }
  return null;
}

/** The runner's final message: result + evidence, or its error. */
export function readFinalMessage(handle) {
  const f = handle.final;
  if (!f) return { via: 'none', text: `runner produced no JSON (exit ${handle.exited?.code}); stderr tail:\n${handle.stderrTail.join('\n')}` };
  const parts = [];
  if (f.result) parts.push(f.result);
  if (f.evidence) parts.push(`Evidence: ${f.evidence}`);
  if (f.error) parts.push(`Error: ${f.error}`);
  if (!parts.length && f.so_far?.lastText) parts.push(f.so_far.lastText);
  return { via: `runner:${f.status}`, text: parts.join('\n'), status: f.status, runId: f.run_id, model: f.model };
}

// ---------------------------------------------------------------------------
// Tool-usage histogram across cells → bench/tool-usage.md
// ---------------------------------------------------------------------------
export function recordUsage(handle, { client, testId, toolset = null }) {
  appendFileSync(USAGE_JSONL, JSON.stringify({
    ts: new Date().toISOString(), client, testId, runId: handle.runId, status: handle.final?.status || null,
    toolset: handle.final?.toolset || toolset || 'default',
    model: handle.final?.model || null,
    wallMs: handle.exited ? handle.exited.at - handle.startedAt : null,
    toolLog: handle.toolLog.map(({ t, name, ms, ok, args }) => ({ t, name, ms, ok, target: targetOf(name, args) })),
  }) + '\n');
  // Append only. tool-usage.md is rendered per pass (bench/hvm-run.sh) or on demand
  // (`node bench/drive-runner.js usage`), not after every cell: re-rendering here cost 3.5s per cell.
}

export function loadUsage(file = USAGE_JSONL) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  // Every row carries target / toolset / model: rows written before those fields existed were
  // backfilled into the file once (2026-09-16), so nothing is looked up in the run store here.
  return raw.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** What a call was aimed at, as a comparable string; null when the call has no
 *  target (fast_snapshot, fast_status…). Two consecutive calls on the same
 *  target are the fumble signal below. */
const TARGET_KEYS = ['text', 'match', 'field', 'selector', 'label', 'url', 'intent', 'key', 'option'];
export function targetOf(name, args) {
  if (!args || typeof args !== 'object') return null;
  if (name === 'fast_batch') return null;
  for (const k of TARGET_KEYS) if (args[k] != null && args[k] !== '') return String(args[k]).toLowerCase().trim();
  if (args.x != null && args.y != null) return `xy`; // any coordinate click on the same page counts as the same blind target
  if (args.fields) return Object.keys(args.fields).sort().join('|').toLowerCase();
  if (args.selections) return Object.keys(args.selections).sort().join('|').toLowerCase();
  return null;
}

/** EVERY cell counts (all passes), so n=3 runs aggregate instead of the latest
 *  overwriting. Per tool: calls, errors, avg ms, and the fumble columns — how
 *  often a call was immediately followed by the SAME tool on the same target
 *  (retry) or a DIFFERENT tool on the same target (switch). */
export function renderUsage(rows) {
  const order = TESTS.map((t) => t.id);
  const out = [
    '# fast-runner tool usage',
    '',
    `${rows.length} cell(s), ALL passes, one table per toolset × model, from \`bench/tool-usage.jsonl\`. Regenerate: \`node bench/drive-runner.js usage\`.`,
    '',
    'fumble columns: `retry` = call immediately followed by the same tool on the same target; `switch` = followed by a different tool on the same target; `fumble %` = (retry+switch)/calls.',
    '',
  ];
  const byToolset = new Map();
  for (const r of rows) { const k = `${r.toolset || 'default'} / ${r.model || '?'}`; if (!byToolset.has(k)) byToolset.set(k, []); byToolset.get(k).push(r); }
  for (const [toolset, cells] of byToolset) {
    const agg = new Map();
    const passes = new Map(); // testId -> number of cells
    for (const r of cells) {
      passes.set(r.testId, (passes.get(r.testId) || 0) + 1);
      const log = r.toolLog;
      for (let i = 0; i < log.length; i++) {
        const e = log[i];
        const a = agg.get(e.name) || { calls: 0, errors: 0, ms: 0, retry: 0, switch: 0, tests: new Set() };
        a.calls++; if (!e.ok) a.errors++; a.ms += e.ms; a.tests.add(r.testId);
        const next = log[i + 1];
        if (next && e.target != null && next.target === e.target) { if (next.name === e.name) a.retry++; else a.switch++; }
        agg.set(e.name, a);
      }
    }
    const names = [...agg.keys()].sort((a, b) => agg.get(b).calls - agg.get(a).calls || a.localeCompare(b));
    const cellsPerTest = [...passes.entries()].sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0])).map(([t, n]) => `${t}×${n}`).join(', ');
    out.push(`## toolset \`${toolset}\` — ${cells.length} cell(s): ${cellsPerTest}`, '',
      '| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |',
      '|---|---:|---:|---:|---:|---:|---:|---|');
    for (const n of names) {
      const a = agg.get(n);
      const tests = [...a.tests].sort((x, y) => order.indexOf(x) - order.indexOf(y)).join(', ');
      out.push(`| ${n} | ${a.calls} | ${a.errors} | ${Math.round(a.ms / a.calls)} | ${a.retry} | ${a.switch} | ${Math.round(100 * (a.retry + a.switch) / a.calls)} | ${tests} |`);
    }
    const totalCalls = names.reduce((s, n) => s + agg.get(n).calls, 0);
    const totalFumbles = names.reduce((s, n) => s + agg.get(n).retry + agg.get(n).switch, 0);
    out.push('', `Total: ${totalCalls} calls across ${names.length} distinct tools; ${totalFumbles} fumbles (${totalCalls ? Math.round(100 * totalFumbles / totalCalls) : 0}%).`, '');
  }
  return out.join('\n');
}

// --- CLI -------------------------------------------------------------------
// node bench/drive-runner.js usage            → re-render bench/tool-usage.md
// node bench/drive-runner.js preflight [name] → prove the relay path as the runner
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'usage') { writeFileSync(USAGE_MD, renderUsage(loadUsage())); console.log(readFileSync(USAGE_MD, 'utf8')); process.exit(0); }
  if (cmd === 'preflight') { console.log(await preflight({ browser: arg || null })); process.exit(0); }
  console.error('usage: node bench/drive-runner.js usage | preflight [browser]');
  process.exit(2);
}
