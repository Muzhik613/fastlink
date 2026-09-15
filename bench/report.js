// report.js — render bench/results.jsonl as a comparison table.
//
// TIME AND SCORE ARE ALWAYS PRINTED IN THE SAME CELL, on purpose. Wall-clock alone
// rewards giving up: a client that quits at 60% looks "fast". Every cell therefore
// reads  <score>/<total> <wall>s  and carries flags for the ways a number can lie:
//   !  the client CLAIMED completion the page state does not support (overclaim)
//   ~  the client said it fell short (underclaim / honest failure)
//   S  STUCK — hit the ceiling or burned 30s broker timeouts
//   X  INVALID — no tool calls, rate limit, driver failure. Never averaged in.
//
// Usage: node bench/report.js [--file results.jsonl] [--valid-only] [--raw]
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ALL_TESTS as TESTS } from './suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export function load(file = join(HERE, 'results.jsonl')) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  return raw.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const key = (r) => `${r.client}|${r.transport}`;
const secs = (ms) => (ms == null ? '  –  ' : `${(ms / 1000).toFixed(0)}s`);

function flags(r) {
  let f = '';
  if (r.valid === false) f += 'X';
  if (r.stuck) f += 'S';
  if (r.claimedComplete === true && r.score < r.total) f += '!';
  if (r.claimedComplete === false && r.score === r.total) f += '~';
  return f;
}

export function render(rows, { validOnly = false } = {}) {
  const use = validOnly ? rows.filter((r) => r.valid !== false) : rows;
  if (!use.length) return 'No results yet. Run a cell:  node bench/run.js --client claude --test multipage';

  // Latest row wins per (client, transport, test) so a re-run supersedes a bad one.
  const cell = new Map();
  for (const r of use) cell.set(`${key(r)}|${r.testId}`, r);
  const cols = [...new Set(use.map(key))].sort();
  const tests = TESTS.filter((t) => use.some((r) => r.testId === t.id));

  const W = 18;
  const out = [];
  out.push('  score/total + wall-clock, together. Flags: ! overclaim  ~ underclaim  S stuck  X invalid');
  out.push('');
  out.push('  ' + 'test'.padEnd(12) + cols.map((c) => c.padEnd(W)).join(''));
  out.push('  ' + '-'.repeat(12) + cols.map(() => '-'.repeat(W - 2) + '  ').join(''));
  for (const t of tests) {
    const line = ['  ' + t.id.padEnd(12)];
    for (const c of cols) {
      const r = cell.get(`${c}|${t.id}`);
      line.push((r ? `${r.score}/${r.total} ${secs(r.wallMs)} ${flags(r)}`.trim() : '–').padEnd(W));
    }
    out.push(line.join(''));
  }

  // Column totals. Invalid and stuck cells are excluded from the time average —
  // a wedged run's seconds are not a measurement of anything.
  out.push('');
  out.push('  ' + 'TOTAL'.padEnd(12) + cols.map((c) => {
    const rs = tests.map((t) => cell.get(`${c}|${t.id}`)).filter(Boolean);
    const ok = rs.filter((r) => r.valid !== false && !r.stuck);
    const s = rs.reduce((a, r) => a + (r.score || 0), 0);
    const tot = rs.reduce((a, r) => a + (r.total || 0), 0);
    const ms = ok.reduce((a, r) => a + (r.wallMs || 0), 0);
    return `${s}/${tot} ${secs(ms)}`.padEnd(W);
  }).join(''));

  // Where the time goes, and how often the client's story matched reality.
  out.push('');
  out.push('  ' + 'client × transport'.padEnd(22) + 'calls  think%  action%  overclaims  stuck  invalid');
  out.push('  ' + '-'.repeat(22) + '-----  ------  -------  ----------  -----  -------');
  for (const c of cols) {
    const rs = use.filter((r) => key(r) === c);
    const think = rs.reduce((a, r) => a + (r.thinkingMs || 0), 0);
    const act = rs.reduce((a, r) => a + (r.actionMs || 0), 0);
    const wall = think + act || 1;
    const calls = rs.reduce((a, r) => a + (r.toolCalls || 0), 0);
    const over = rs.filter((r) => r.claimedComplete === true && r.score < r.total).length;
    out.push('  ' + c.padEnd(22)
      + String(calls).padStart(5)
      + `${Math.round((think / wall) * 100)}%`.padStart(8)
      + `${Math.round((act / wall) * 100)}%`.padStart(9)
      + String(over).padStart(12)
      + String(rs.filter((r) => r.stuck).length).padStart(7)
      + String(rs.filter((r) => r.valid === false).length).padStart(9));
  }

  const bad = use.filter((r) => r.valid === false || r.stuck);
  if (bad.length) {
    out.push('');
    out.push('  Excluded / flagged runs:');
    for (const r of bad) out.push(`    ${r.ts}  ${key(r)}  ${r.testId}  ${r.outcome}  ${r.invalidReason || r.notes || ''}`.slice(0, 160));
  }
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => { const i = argv.indexOf(n); if (i === -1) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const file = flag('--file', join(HERE, 'results.jsonl'));
  const rows = load(file);
  if (argv.includes('--raw')) { for (const r of rows) console.log(JSON.stringify(r)); process.exit(0); }
  console.log(render(rows, { validOnly: argv.includes('--valid-only') }));
  process.exit(0);
}
