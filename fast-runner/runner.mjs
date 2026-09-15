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
const MAX_GATE_REFUSALS = 3; // report_done refused this many times -> accepted, flagged gateOverridden
const TZ = 'America/Chicago';

// Today's date is in the prompt so a model never guesses the year for "a month
// from today" (both Grok models reached for fast_evaluate to get it, 4.3 typed 2024).
const todayLine = () => {
  const d = new Date();
  const date = d.toLocaleDateString('en-CA', { timeZone: TZ });
  const dow = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' });
  return `Today is ${dow} ${date} (${TZ}). Compute relative dates from this; never guess the year.`;
};
const SYSTEM = `You are the operator of a real Chrome browser. The tools below drive it directly (FastLink). Work autonomously until the task is finished.
Rules:
- Read pages with fast_snapshot; act with DOM tools. A form with 2+ fields is ONE fast_fill {fields} or ONE fast_batch — never one call per field; use fast_batch whenever the next steps are already known.
- Action results already include a fresh snapshot; do not re-snapshot right after an action. No artificial waits.
- A result that starts with truncated:true is partial: never answer or report_done from it — call fast_snapshot full:true / fast_text / limit:N first.
- Call ask_caller ONLY when a decision genuinely needs the caller (missing info, ambiguous choice, risky/irreversible action). Never ask for things you can find on the page.
- Never claim success without reading it back from the page (snapshot/text/value).
- When finished call report_done with a concise result and evidence (what you read back, URL). report_done is refused unless a read (fast_snapshot/fast_text) followed your last action and evidence quotes that result verbatim. Do not end your turn without calling report_done or ask_caller.`;

// Evidence gate for report_done (a caller-facing contract, every toolset): the
// run must have READ the page after its last state-changing call, and
// `evidence` must quote a tool result of this run — otherwise the model is
// told exactly what is missing and continues. Refusals are logged per run.
const STATE_TOOLS = new Set([
  'fast_click', 'fast_click_xy', 'fast_fill', 'fast_select_option', 'fast_key_press', 'fast_key',
  'fast_type', 'fast_nav', 'fast_tab', 'fast_reload', 'fast_scroll', 'fast_wheel', 'fast_drag', 'fast_drag_xy',
  'fast_upload', 'fast_hover', 'fast_switch', 'fast_close', 'fast_batch', 'fast_do', 'fast_fill_vision',
  'fast_macro_run', 'fast_network_replay',
]);
const READ_TOOLS = new Set(['fast_snapshot', 'fast_text', 'fast_screenshot', 'fast_evaluate', 'fast_marks', 'fast_scout', 'fast_list', 'fast_console', 'fast_network']);
const isStateChanging = (e) => STATE_TOOLS.has(e.name);
const isRead = (e) => READ_TOOLS.has(e.name) || (e.name === 'fast_wait' && !!(e.args && e.args.text));
// Tool-result JSON vs. what the model copies from it: unescape \n and \", collapse whitespace, lowercase.
const normQuote = (s) => String(s ?? '').replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\s+/g, ' ').trim().toLowerCase();
export function gateProblems(run, args) {
  const log = run.toolLog || [];
  const problems = [];
  if (!log.length) problems.push('no tool has been called — the page has not been read');
  else {
    let last = -1;
    for (let i = log.length - 1; i >= 0; i--) if (isStateChanging(log[i])) { last = i; break; }
    if (!log.slice(last + 1).some(e => e.ok && isRead(e))) {
      problems.push(last >= 0
        ? `no tool has read the page since your last ${log[last].name}; call fast_snapshot or fast_text (its own auto-snapshot is not a read-back) and cite what it returned`
        : 'no successful read of the page yet; call fast_snapshot or fast_text and cite what it returned');
    }
  }
  const ev = String(args?.evidence ?? '').trim();
  if (!ev) problems.push('evidence is empty — quote what you read back from the page, plus the URL');
  else {
    const corpus = normQuote((run.corpus || []).join('\n'));
    const frags = [];
    for (const m of ev.matchAll(/["“”'‘’`]([^"“”'‘’`]{4,300})["“”'‘’`]/g)) frags.push(m[1]);
    const words = normQuote(ev).split(' ').filter(Boolean);
    for (let n = 6; n >= 3; n--) for (let i = 0; i + n <= words.length; i++) frags.push(words.slice(i, i + n).join(' '));
    for (const w of words) if (/\d/.test(w) && w.length >= 6) frags.push(w);
    const quoted = frags.some(f => { const q = normQuote(f).replace(/[.,;:]+$/, ''); return q.length >= 4 && corpus.includes(q); });
    if (!quoted) problems.push('evidence does not quote any tool result of this run — copy a phrase exactly as the last fast_snapshot/fast_text result showed it (a content text, a field value, a number), then report again');
  }
  return problems;
}

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

// allow-filter, rename (Grok-facing name -> real name on call), describe overrides (keyed by REAL
// name; ask_caller/report_done accept one too, so a toolset can tighten the report without
// touching the baseline).
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
  const native = NATIVE_TOOLS.map(t => toolset.describe[t.name] ? { ...t, description: toolset.describe[t.name] } : t);
  return { tools: [...tools, ...native], back };
}

// The server's MCP `instructions` essay rides along ONLY on the default toolset, so the baseline
// stays byte-identical; a triaged toolset carries its own tight descriptions instead.
export function buildSystem(toolset, instructions) {
  const base = `${SYSTEM}\n${todayLine()}`;
  return toolset.name === 'default' && instructions ? `${base}\n\nTool guidance from FastLink:\n${instructions}` : base;
}

function toolResultContent(res) {
  const out = [];
  for (const c of res?.content || []) {
    if (c.type === 'text') out.push({ type: 'text', text: c.text.length > RESULT_CAP
      ? `[truncated:true — this result was ${c.text.length} chars, only the first ${RESULT_CAP} follow; narrow it (fast_text selector/maxLen, fast_snapshot limit:N) before relying on it]\n${c.text.slice(0, RESULT_CAP)}`
      : c.text });
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

// Chars of tool_result text the model had to ingest fresh this turn (the last user message).
function toolResultChars(messages) {
  const m = messages[messages.length - 1];
  if (m?.role !== 'user') return 0;
  let n = 0;
  for (const c of m.content) {
    if (c.type !== 'tool_result') continue;
    for (const p of c.content || []) n += p.type === 'text' ? p.text.length : (p.source?.data?.length || 0);
  }
  return n;
}

// One row per model call -> run.turns (written to runs.jsonl). latencyMs is the whole
// createMessage (proxy + retries); `t` is the call's start offset, like toolLog.t.
function recordTurn(run, resp, content) {
  const u = resp.usage || {}, tm = resp._timing || {};
  const row = {
    turn: run.turns.length + 1, t: Date.now() - run.startedAt - (tm.latencyMs || 0),
    latencyMs: tm.latencyMs ?? null, attempts: tm.attempts ?? null, requestChars: tm.requestChars ?? null,
    inputTokens: u.input_tokens ?? null, cacheRead: u.cache_read_input_tokens ?? null,
    cacheCreate: u.cache_creation_input_tokens ?? null, outputTokens: u.output_tokens ?? null,
    toolResultChars: toolResultChars(run.messages), stop_reason: resp.stop_reason ?? null,
    tools: content.filter(c => c.type === 'tool_use').map(c => c.name),
    thinking: (resp.content || []).some(c => c.type === 'thinking' || c.type === 'redacted_thinking'),
  };
  // xAI usage extras (e.g. reasoning tokens) keep their upstream names, unknown shape today.
  for (const k of Object.keys(u)) if (!/^(input_tokens|output_tokens|cache_read_input_tokens|cache_creation_input_tokens)$/.test(k)) row[k] = u[k];
  run.turns.push(row);
  const s = run.usage; s.turns++;
  s.input += u.input_tokens || 0; s.output += u.output_tokens || 0;
  s.cacheRead += u.cache_read_input_tokens || 0; s.cacheCreate += u.cache_creation_input_tokens || 0;
  s.modelMs += tm.latencyMs || 0;
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
  return { ...base, result: run.result, evidence: run.evidence, error: run.error, so_far: soFar(run), histogram: histogram(run), model: MODEL, toolset: run.toolset.name, gateRefusals: run.gateRefusals, gateOverridden: run.gateOverridden || undefined };
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
      toolCalls: run.toolLog.length, histogram: histogram(run), toolLog: run.toolLog, turns: run.turns,
      result: run.result, evidence: run.evidence, error: run.error, usage: run.usage,
      gateRefusals: run.gateRefusals, gateOverridden: run.gateOverridden || undefined,
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
    const content = (resp.content || []).filter(c => c.type !== 'thinking' && c.type !== 'redacted_thinking');
    recordTurn(run, resp, content);
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
        const problems = gateProblems(run, args);
        if (problems.length && run.gateRefusals.length < MAX_GATE_REFUSALS) {
          run.gateRefusals.push({ turn: run.turns.length, t: Date.now() - t0, problems });
          onEvent?.({ type: 'gate', problems });
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: [{ type: 'text', text: `report_done refused: ${problems.join('; ')}. Fix that, then call report_done again.` }] });
          continue;
        }
        if (problems.length) run.gateOverridden = problems;
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
      if (ok) run.corpus.push(firstText); // full text, for the evidence gate (memory only, not written to runs.jsonl)
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
    tools, back, client, toolLog: [], turns: [], corpus: [], gateRefusals: [], gateOverridden: null, question: null, waiters: [], pendingAnswer: null,
    budgets: { ...DEFAULT_BUDGETS, ...budgets }, onEvent, startedAt: Date.now(), consecutiveErrors: 0,
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, modelMs: 0 }, abort: new AbortController(), cancelled: false, done: false,
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
