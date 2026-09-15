#!/usr/bin/env node
// Summarize /tmp/fastlink-timing.jsonl written by handleCall's logTiming.
// Usage: node timing-report.js            (whole log)
//        node timing-report.js 30         (last 30 calls = one flow)
// Rendering lives in timing-format.js — the SAME formatter the cloud-relay report
// (fastlink-relay/relay-timing-report.js) uses, so local and relay runs compare
// line for line.
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatTimingReport } from './timing-format.js';

const LOG = join(tmpdir(), 'fastlink-timing.jsonl');
const tail = parseInt(process.argv[2] || '0', 10);

let rows;
try {
  rows = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
} catch {
  console.error(`No timing log at ${LOG} yet — run a flow first.`);
  process.exit(1);
}
if (tail > 0) rows = rows.slice(-tail);

console.log(formatTimingReport(rows, {
  label: 'Opus',
  header: `  local MCP server — ${LOG}${tail > 0 ? ` (last ${tail})` : ''}\n`,
}));
