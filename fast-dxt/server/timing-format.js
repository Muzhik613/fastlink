// timing-format.js — the ONE summarizer for FastLink per-tool-call timing rows.
//
// A "row" is exactly what handlers.js logTiming writes (local MCP server) and what
// fastlink-relay/src/timing.js stores per session (cloud relay):
//   { t, name, gapMs, durMs }
//     gapMs = startTs - previous call's return  → the MODEL's think/round-trip time
//     durMs = time spent inside the call         → action execution time
//
// Both `timing-report.js` (local JSONL) and `fastlink-relay/relay-timing-report.js`
// (relay trace) render through this, so a local run and a relay run — and a Claude
// run vs a Grok/GPT run — are directly comparable line for line.

// Render rows to a report string. `label` names the driver in the headline
// ("Opus", "grok-4", …) so traces from different models are self-describing.
export function formatTimingReport(rows, { label = 'Model', header = '' } = {}) {
  const out = [];
  if (header) out.push(header);

  let totalGap = 0, totalDur = 0;
  const byTool = {};
  out.push('  gapMs  durMs  tool');
  out.push('  -----  -----  ----');
  for (const r of rows) {
    const gap = r.gapMs ?? 0;
    const dur = r.durMs ?? 0;
    totalGap += gap;
    totalDur += dur;
    const b = (byTool[r.name] ||= { n: 0, dur: 0, gap: 0 });
    b.n++; b.dur += dur; b.gap += gap;
    out.push(`  ${String(gap).padStart(5)}  ${String(dur).padStart(5)}  ${r.name}`);
  }

  out.push('\n  Per-tool totals (durMs / calls):');
  for (const [name, b] of Object.entries(byTool).sort((a, c) => c[1].dur - a[1].dur)) {
    out.push(`    ${String(name).padEnd(20)} ${String(b.dur).padStart(6)}ms  (${b.n}x, avg ${Math.round(b.dur / b.n)}ms)`);
  }

  const wall = totalGap + totalDur;
  const pct = (x) => (wall ? `${Math.round((x / wall) * 100)}%` : '0%');
  out.push('\n  ============================================');
  out.push(`  ${label} round-trips (gap): ${totalGap}ms  ${pct(totalGap)}`);
  out.push(`  Actions (dur):          ${totalDur}ms  ${pct(totalDur)}`);
  out.push(`  Wall clock:             ${wall}ms`);
  out.push(`  Calls:                  ${rows.length}`);
  out.push('  ============================================');
  out.push(totalGap > totalDur
    ? '  → Round-trips dominate. Collapsing model turns (fast_do / fast_batch) is the win.'
    : '  → Actions dominate. Optimize the slowest tool above, not round-trips.');

  return out.join('\n');
}
