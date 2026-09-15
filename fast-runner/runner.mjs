// Agent loop: task -> Grok -> FastLink tool calls -> ... until report_done / ask_caller / budget.
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMessage, ensureProxy, MODEL } from './xai.mjs';
import { connect } from './fastlink-client.mjs';

const STATE_DIR = join(homedir(), '.local', 'state', 'fastrun');
const RUNS_FILE = join(STATE_DIR, 'runs.jsonl');
const DEFAULT_BUDGETS = { maxToolCalls: 60, maxWallMs: 600_000, maxConsecutiveErrors: 3 };
const RESULT_CAP = 80_000; // chars per tool result fed back to Grok
const MAX_NUDGES = 2;      // end_turn without report_done -> nudge, then fail

const SYSTEM = `You are the operator of a real Chrome browser. The tools below drive it directly (FastLink). Work autonomously until the task is finished.
Rules:
- Read pages with fast_snapshot; act with DOM tools; use fast_batch when the next steps are already known.
- Action results already include a fresh snapshot; do not re-snapshot right after an action. No artificial waits.
- Call ask_caller ONLY when a decision genuinely needs the caller (missing info, ambiguous choice, risky/irreversible action). Never ask for things you can find on the page.
- Never claim success without reading it back from the page (snapshot/text/value).
- When finished call report_done with a concise result and evidence (what you read back, URL). Do not end your turn without calling report_done or ask_caller.`;

const NATIVE_TOOLS = [
  {
    name: 'ask_caller',
    description: 'Pause and ask the caller (the person/agent who dispatched this task) one question. Resumes with their answer. Use only when a decision genuinely needs them.',
    input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
  {
    name: 'report_done',
    description: 'Finish the task. result = concise outcome/answer. evidence = what you read back from the page that proves it (quote + URL).',
    input_schema: { type: 'object', properties: { result: { type: 'string' }, evidence: { type: 'string' } }, required: ['result', 'evidence'] },
  },
];

const runs = new Map();

// Toolset selection is EXPLICIT per run (--toolset / `toolset` arg / FASTRUN_TOOLSET), never ambient:
//   unset or "default" -> ./toolset.json           (all tools, the A/B baseline)
//   a bare name        -> ./toolset.<name>.json    (e.g. "phase2", "no-cdp")
//   anything with "/" or ending in .json -> that file path
// Returns { name, file, allow, rename, describe }. `name` is what runs.jsonl records.
export function loadToolset(spec = process.env.FASTRUN_TOOLSET || 'default') {
  spec = String(spec || 'default');
  const isPath = spec.includes('/') || spec.endsWith('.json');
  let name = isPath ? basename(spec, '.json') : spec;
  if (name.startsWith('toolset.')) name = name.slice('toolset.'.length);
  if (name === 'toolset') name = 'default';
  const file = isPath ? resolve(spec) : fileURLToPath(new URL(name === 'default' ? './toolset.json' : `./toolset.${name}.json`, import.meta.url));
  let ts;
  try { ts = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`toolset "${spec}": cannot read ${file} (${e.message})`); }
  if (!Array.isArray(ts.allow) || !ts.allow.length) throw new Error(`toolset "${spec}": "allow" must be a non-empty array (use ["*"] for all)`);
  return { name, file, allow: ts.allow, rename: ts.rename || {}, describe: ts.describe || {} };
}

// allow-filter, rename (Grok-facing name -> real name on call), describe overrides (keyed by REAL name).
export function buildTools(mcpTools, toolset) {
  const allowAll = toolset.allow.includes('*');
  const back = new Map();
  const tools = [];
  for (const t of mcpTools) {
    if (!allowAll && !toolset.allow.includes(t.name)) continue;
    const name = toolset.rename[t.name] || t.name;
    back.set(name, t.name);
    tools.push({ name, description: toolset.describe[t.name] || t.description || '', input_schema: t.inputSchema || { type: 'object', properties: {} } });
  }
  return { tools: [...tools, ...NATIVE_TOOLS], back };
}

// The server's MCP `instructions` essay rides along ONLY on the default toolset, so the baseline
// stays byte-identical; a triaged toolset carries its own tight descriptions instead.
export function buildSystem(toolset, instructions) {
  return toolset.name === 'default' && instructions ? `${SYSTEM}\n\nTool guidance from FastLink:\n${instructions}` : SYSTEM;
}

function toolResultContent(res) {
  const out = [];
  for (const c of res?.content || []) {
    if (c.type === 'text') out.push({ type: 'text', text: c.text.length > RESULT_CAP ? c.text.slice(0, RESULT_CAP) + '\n[truncated]' : c.text });
    else if (c.type === 'image') out.push({ type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } });
  }
  if (!out.length) out.push({ type: 'text', text: JSON.stringify(res?.structuredContent ?? res ?? null) });
  return out;
}

// FastLink reports failures as {"error": ...} in the text payload, not MCP isError.
function isPayloadError(text) {
  if (!text.startsWith('{')) return false;
  try { const o = JSON.parse(text); return typeof o?.error === 'string'; } catch { return false; }
}

function lastAssistantText(run) {
  for (let i = run.messages.length - 1; i >= 0; i--) {
    const m = run.messages[i];
    if (m.role !== 'assistant') continue;
    const t = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (t) return t;
  }
  return '';
}

function histogram(run) {
  const h = {};
  for (const e of run.toolLog) h[e.name] = (h[e.name] || 0) + 1;
  return h;
}

function soFar(run) {
  return {
    toolCalls: run.toolLog.length,
    wallMs: (run.endedAt || Date.now()) - run.startedAt,
    lastText: lastAssistantText(run),
    recent: run.toolLog.slice(-10).map(({ t, name, ms, ok, preview }) => ({ t, name, ms, ok, preview })),
  };
}

function snapshot(run) {
  const base = { status: run.status, run_id: run.id };
  if (run.status === 'question') return { ...base, question: run.question, so_far: soFar(run) };
  if (run.status === 'running') return base;
  return { ...base, result: run.result, evidence: run.evidence, error: run.error, so_far: soFar(run), histogram: histogram(run), model: MODEL, toolset: run.toolset.name };
}

function notify(run) {
  const w = run.waiters; run.waiters = [];
  for (const r of w) r(snapshot(run));
}

function finish(run, status, fields = {}) {
  if (run.done) return;
  run.done = true;
  Object.assign(run, fields, { status, endedAt: Date.now() });
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(RUNS_FILE, JSON.stringify({
      run_id: run.id, task: run.task, transport: run.transport, browser: run.browser, model: MODEL,
      toolset: run.toolset.name, status, startedAt: new Date(run.startedAt).toISOString(), wallMs: run.endedAt - run.startedAt,
      toolCalls: run.toolLog.length, histogram: histogram(run), toolLog: run.toolLog,
      result: run.result, evidence: run.evidence, error: run.error, usage: run.usage,
    }) + '\n');
  } catch {}
  run.client?.close().catch(() => {});
  notify(run);
}

// Resolves with the run's next notable state, or {status:'running'} after holdMs.
function hold(run, holdMs) {
  if (run.status !== 'running') return Promise.resolve(snapshot(run));
  return new Promise(resolve => {
    let timer;
    const r = (s) => { clearTimeout(timer); resolve(s); };
    run.waiters.push(r);
    timer = setTimeout(() => { run.waiters = run.waiters.filter(x => x !== r); resolve({ status: 'running', run_id: run.id }); }, holdMs);
  });
}

async function loop(run) {
  const { budgets, onEvent } = run;
  const t0 = run.startedAt;
  let nudges = 0;
  while (!run.cancelled) {
    if (run.toolLog.length >= budgets.maxToolCalls) return finish(run, 'budget', { error: `maxToolCalls ${budgets.maxToolCalls} reached` });
    if (Date.now() - t0 >= budgets.maxWallMs) return finish(run, 'budget', { error: `maxWallMs ${budgets.maxWallMs} reached` });

    let resp;
    try {
      resp = await createMessage({ system: run.system, messages: run.messages, tools: run.tools, signal: run.abort.signal });
    } catch (e) {
      if (run.cancelled) return;
      return finish(run, 'error', { error: `model: ${e.message}` });
    }
    if (resp.usage) {
      const u = run.usage; u.turns++;
      u.input += resp.usage.input_tokens || 0; u.output += resp.usage.output_tokens || 0;
      u.cacheRead += resp.usage.cache_read_input_tokens || 0;
    }
    const content = (resp.content || []).filter(c => c.type !== 'thinking' && c.type !== 'redacted_thinking');
    run.messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
    for (const c of content) if (c.type === 'text' && c.text.trim()) onEvent?.({ type: 'text', text: c.text });

    const uses = content.filter(c => c.type === 'tool_use');
    if (!uses.length) {
      if (++nudges > MAX_NUDGES) return finish(run, 'error', { error: 'model ended without report_done', result: lastAssistantText(run) });
      run.messages.push({ role: 'user', content: [{ type: 'text', text: 'You ended your turn without calling report_done or ask_caller. Continue the task, or call report_done now.' }] });
      continue;
    }
    nudges = 0;

    const results = [];
    for (const u of uses) {
      if (run.cancelled) return;
      const args = u.input || {};
      if (u.name === 'report_done') {
        return finish(run, 'done', { result: args.result ?? '', evidence: args.evidence ?? '' });
      }
      if (u.name === 'ask_caller') {
        run.question = String(args.question ?? '');
        run.status = 'question';
        onEvent?.({ type: 'question', question: run.question });
        notify(run);
        const answer = await new Promise(resolve => { run.pendingAnswer = resolve; });
        if (run.cancelled) return;
        results.push({ type: 'tool_result', tool_use_id: u.id, content: [{ type: 'text', text: answer }] });
        continue;
      }
      const real = run.back.get(u.name);
      const t1 = Date.now();
      let res, ok = true;
      if (!real) {
        res = { content: [{ type: 'text', text: `unknown tool ${u.name}` }], isError: true };
      } else {
        try { res = await run.client.callTool(real, args); }
        catch (e) { res = { content: [{ type: 'text', text: `tool error: ${e.message}` }], isError: true }; }
      }
      const ms = Date.now() - t1;
      const firstText = res?.content?.find(c => c.type === 'text')?.text || '';
      ok = !res?.isError && !isPayloadError(firstText);
      // 1200 chars: enough of a result to post-mortem a fumble from runs.jsonl
      // (an error's candidates / a batch's per-step results); 160 showed only the
      // first key of a snapshot.
      const preview = firstText.slice(0, 1200);
      run.toolLog.push({ t: t1 - t0, name: real || u.name, args, ms, ok, preview });
      onEvent?.({ type: 'tool', name: real || u.name, args, ms, ok, preview });
      run.consecutiveErrors = ok ? 0 : run.consecutiveErrors + 1;
      results.push({ type: 'tool_result', tool_use_id: u.id, content: toolResultContent(res), ...(ok ? {} : { is_error: true }) });
      if (run.consecutiveErrors >= budgets.maxConsecutiveErrors) {
        run.messages.push({ role: 'user', content: results });
        return finish(run, 'error', { error: `${budgets.maxConsecutiveErrors} consecutive tool errors` });
      }
    }
    run.messages.push({ role: 'user', content: results });
    run.status = 'running';
  }
}

export async function runTask({ task, transport = 'relay', browser, toolset: toolsetSpec, budgets = {}, holdMs = 240_000, onEvent } = {}) {
  if (!task) throw new Error('task required');
  const toolset = loadToolset(toolsetSpec); // throws before any connect on a bad name/path
  await ensureProxy();
  const client = await connect({ transport, browser });
  const { tools, back } = buildTools(await client.listTools(), toolset);
  const run = {
    id: randomBytes(4).toString('hex'), task, transport, browser, toolset, status: 'running',
    messages: [{ role: 'user', content: [{ type: 'text', text: `TASK: ${task}` }] }],
    system: buildSystem(toolset, client.instructions),
    tools, back, client, toolLog: [], question: null, waiters: [], pendingAnswer: null,
    budgets: { ...DEFAULT_BUDGETS, ...budgets }, onEvent, startedAt: Date.now(), consecutiveErrors: 0,
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0 }, abort: new AbortController(), cancelled: false, done: false,
  };
  runs.set(run.id, run);
  loop(run).catch(e => finish(run, 'error', { error: `loop: ${e.message}` }));
  return hold(run, holdMs);
}

export function answer(runId, text, { holdMs = 240_000 } = {}) {
  const run = runs.get(runId);
  if (!run) return Promise.resolve({ status: 'error', run_id: runId, error: 'unknown run_id' });
  if (run.status !== 'question' || !run.pendingAnswer) return Promise.resolve({ ...snapshot(run), error: 'run is not waiting on a question' });
  const resolve = run.pendingAnswer;
  run.pendingAnswer = null; run.question = null; run.status = 'running';
  resolve(String(text ?? ''));
  return hold(run, holdMs);
}

export function status(runId) {
  const run = runs.get(runId);
  if (!run) return { status: 'error', run_id: runId, error: 'unknown run_id' };
  return { ...snapshot(run), so_far: soFar(run) };
}

export function cancel(runId) {
  const run = runs.get(runId);
  if (!run) return { status: 'error', run_id: runId, error: 'unknown run_id' };
  if (run.done) return snapshot(run);
  run.cancelled = true;
  run.abort.abort();
  run.pendingAnswer?.('');
  finish(run, 'cancelled', { error: 'cancelled by caller' });
  return snapshot(run);
}
