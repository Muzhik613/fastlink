#!/usr/bin/env node
// node cli.mjs [--local|--relay] [--browser NAME] "task"  — streams tool calls, answers ask_caller from stdin, prints final JSON.
import { createInterface } from 'node:readline';
import { runTask, answer } from './runner.mjs';

const argv = process.argv.slice(2);
let transport = 'relay', browser;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--local') transport = 'local';
  else if (a === '--relay') transport = 'relay';
  else if (a === '--browser') browser = argv[++i];
  else rest.push(a);
}
const task = rest.join(' ').trim();
if (!task) { console.error('usage: node cli.mjs [--local|--relay] [--browser NAME] "task"'); process.exit(2); }

// stdin lines are queued so a piped answer that arrives before the question is not lost.
const rl = createInterface({ input: process.stdin, terminal: false });
const lines = [], waiting = [];
rl.on('line', l => { const w = waiting.shift(); w ? w(l) : lines.push(l); });
const ask = (q) => { process.stderr.write(`\n? ${q}\n> `); return lines.length ? Promise.resolve(lines.shift()) : new Promise(r => waiting.push(r)); };
const short = (o) => { const s = JSON.stringify(o); return s.length > 120 ? s.slice(0, 117) + '...' : s; };

const onEvent = (e) => {
  if (e.type === 'tool') console.error(`  [${(e.ms / 1000).toFixed(1)}s] ${e.ok ? 'ok ' : 'ERR'} ${e.name} ${short(e.args)}`);
  else if (e.type === 'text') console.error(`  grok: ${e.text.replace(/\s+/g, ' ').slice(0, 200)}`);
};

const t0 = Date.now();
let r = await runTask({ task, transport, browser, holdMs: 3_600_000, onEvent });
while (r.status === 'question') r = await answer(r.run_id, await ask(r.question), { holdMs: 3_600_000 });
rl.close();
console.log(JSON.stringify({ ...r, wallMs: Date.now() - t0 }, null, 2));
process.exit(r.status === 'done' ? 0 : 1);
