// ── Visual check AT THE WRITE ────────────────────────────────────────────────
// Some writes cannot be read back by any tool (a cross-origin frame, a forced
// type whose target the page will not report). For each such write the runner
// takes ONE screenshot the moment the write returns and asks a second model what
// is on the screen, while the driving model is already thinking about its next
// turn. The observations ride along with the NEXT tool result, so a corrupted
// field is seen one turn after it happened instead of at report_done.
//
// Why here and not at the end (Azure run 5f06a066, grok-4.3 driver, 116s): a fill
// corrupted the VM name box at 37s; the end-of-run checker (a fresh grok-4.6
// conversation) took 56s and reported it at 103s, after ~60s of work on top of a
// broken field.
//
// The check stays DUMB ON PURPOSE. It states what is visible; it does not classify
// widgets, name a tool, diagnose or deliver a verdict. The model decides what to do.
import { createMessage } from './xai.mjs';
import { readFileSync } from 'node:fs';

// WHO looks: grok-4.20 non-reasoning, a fresh conversation. Replay of 11 saved
// screenshots (3 Azure, 8 rendered forms with known defects), 3 reps each:
//   grok-4.6  (the old checker), task text  recall 95%  false-confirm 0/10  median 34.7s  p90 51.8s
//   grok-4.3,                    task text  recall 93%  false-confirm 0/10  median  7.3s  p90 11.5s
//   grok-4.20-nr,                task text  recall 83%  false-confirm 2/15  median  1.5s   ("Employee ID reads EMP-40981" — the box was EMPTY; it read the task, not the screen)
//   grok-4.20-nr, THIS prompt (no task)     recall 95%  false-confirm 0/15  median  1.8s  p90 2.6s  tab/step marks 12/12
export const CHECK_MODEL = process.env.FASTRUN_CHECK_MODEL || 'grok-4.20-0309-non-reasoning';
export const MAX_VISUAL_CHECKS = 5;   // per run; unread writes are rare (4 of 719 logged calls)
export const CHECK_WAIT_MS = 8_000;   // longest the loop waits for a check before moving on without it
const MAX_OBSERVATIONS = 8;

// The ONE observation prompt. The checker is given the image and what the write
// was aimed at (a label, or the typed text when that is all the call names) —
// NEVER the task text: with the task in hand the fast checker reported values the
// task asked for as if they were on the screen. What was aimed at is phrased as
// "where does this appear, and quote the whole box", which also finds a value that
// landed in the wrong box (a header search field) and reads a box's full contents
// rather than confirming a prefix.
export function observationPrompt({ targets } = {}) {
  const wanted = (Array.isArray(targets) ? targets : []).map(String).map(s => s.replace(/\bfast_[a-z_]+\b/gi, ' ').trim()).filter(Boolean).slice(0, 8);
  return [
    'Describe what this browser screenshot SHOWS. Report only what is visibly on the screen.',
    wanted.length ? `Cover, FIRST: for each of these — ${wanted.map(v => JSON.stringify(v)).join(', ')} — say where on the screen it appears and quote in full what the box holding it reads, or say that you cannot see it.` : '',
    `${wanted.length ? 'Then cover' : 'Cover'}, when visible: (a) EVERY box that looks empty or still shows greyed placeholder text`,
    '(a blank box, a greyed "Select..."/"Choose..." word sitting in it), naming the label printed',
    'beside it — include the ones marked as required (an asterisk, the word "required"), and list',
    'them even if they seem unrelated to each other; (b) any red/orange marks, dots, outlines,',
    'warning icons, a message under a box, a dialog or a banner, and what each sits next to —',
    'including a mark on a tab or step name at the top of the page; (c) whether the content continues',
    'below the visible area (a scrollbar, a cut-off section, a partially visible row).',
    `RULES: at most ${MAX_OBSERVATIONS} observations, each ONE short sentence about what is on the`,
    'screen; if more boxes look empty than fit, name the ones nearest the top of the page and say how',
    'many others look empty. Write each as a flat statement of what is visible ("the Subscription box',
    'reads empty", "the Basics tab shows a red mark", "the form continues below the visible area").',
    'Do NOT name control types (do not call anything a dropdown, a text field, a checkbox).',
    'Do NOT explain causes, do NOT suggest what to do, do NOT name any tool or action,',
    'Do NOT say whether anything is right, wrong, complete or incomplete. No advice, no verdicts.',
    'If the screen looks fine and nothing stands out, return an empty list.',
    'Reply strict JSON: {"observations":[string, ...]}.',
  ].filter(Boolean).join(' ');
}

// MECHANICAL register filter — NOT judgement. A line where the checker slipped out
// of plain observation (named one of our tools, gave an instruction, pronounced a
// verdict) is DROPPED rather than reworded. It can only remove, never add.
const OFF_REGISTER = [
  /fast_[a-z_]+/i,
  /^(click|select|choose|enter|fill|type|press|scroll|navigate|go to|you should|you need|you must)\b/i,
  /\b(should be|must be|needs to be|is incomplete|is invalid|is wrong|has failed|failed to)\b/i,
];
export function plainObservations(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim())
    .filter((s) => s && !OFF_REGISTER.some((re) => re.test(s)))
    .slice(0, MAX_OBSERVATIONS);
}
export function safeJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = String(s ?? '').match(/\{[\s\S]*\}/);   // models wrap JSON in prose/fences
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return {};
}

// The checker call: ONE fresh user turn through the grokcode proxy the run already
// drives on — no system prompt, no tools, no history.
export async function describeWithGrok({ base64, targets, model = CHECK_MODEL }, deps = {}) {
  const send = deps.create || createMessage;
  let res;
  try {
    res = await send({
      model, maxTokens: 700,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: String(base64 || '').replace(/^data:image\/\w+;base64,/, '') } },
        { type: 'text', text: observationPrompt({ targets }) },
      ] }],
    });
  } catch (e) {
    return { observations: [], skipped: `checker failed: ${String(e && e.message || e).slice(0, 200)}` };
  }
  const text = (res?.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('\n');
  return { observations: plainObservations(safeJson(text).observations), checkerMs: res?._timing?.latencyMs };
}

// ONE screenshot, whichever transport: the local server may return {path} or a
// dataUrl, the relay an MCP image block.
export async function screenshotBase64(client) {
  const res = await client.callTool('fast_screenshot', {});
  for (const c of res?.content || []) {
    if (c.type === 'image' && c.data) return c.data;
    if (c.type !== 'text') continue;
    let o = null;
    try { o = JSON.parse(c.text); } catch { continue; }
    if (typeof o?.dataUrl === 'string') return o.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    if (typeof o?.path === 'string') { try { return readFileSync(o.path).toString('base64'); } catch { return null; } }
  }
  return null;
}

const quoteList = (xs) => xs.map(x => JSON.stringify(x)).join(', ');
export const checkNoteText = (targets, observations) => [
  `Your write to ${quoteList(targets)} could not be read back from the page, so I took a screenshot right after it and showed it to a second model in a fresh conversation. It saw only that image and what the write was aimed at — not the task, your plan, your history or your tools. Here is what it says is on the screen:`,
  ...observations.map(o => `- ${o}`),
  'Anything you want to fix, or is that what you expected? Either is fine — carry on.',
].join('\n');

// Start a check for the unread writes ONE toolLog entry reports. Returns
// immediately: the screenshot and the checker run in the background. The record
// (run.visualChecks) is what the run row carries; the promises live in
// run.pendingChecks and are never serialized.
export function startVisualCheck(run, idx, deps = {}) {
  const entry = run.toolLog[idx];
  const unverified = (entry?.partial || []).filter(p => p.unverified);
  if (run.gate === 'off' || !unverified.length) return null;
  run.visualChecks ||= [];
  run.pendingChecks ||= [];
  const checker = deps.model || CHECK_MODEL;
  const targets = [...new Set(unverified.map(u => u.target).filter(Boolean))];
  const rec = { idx, t: entry.t, checker, unverified };
  run.visualChecks.push(rec);
  if (run.visualChecks.length > MAX_VISUAL_CHECKS) { rec.skipped = `check cap (${MAX_VISUAL_CHECKS}) reached`; return null; }
  const t0 = Date.now();
  const url = run.urlTrail?.[run.urlTrail.length - 1] || '';
  const shoot = deps.screenshot || (() => screenshotBase64(run.client));
  const describe = deps.describe || ((a) => describeWithGrok({ ...a, model: checker }, deps));
  const shot = Promise.resolve().then(shoot).catch(() => null);
  const done = shot.then(async (base64) => {
    rec.shotMs = Date.now() - t0;
    if (!base64) { rec.skipped = 'no screenshot'; return; }
    let out;
    try { out = await describe({ base64, targets }); }
    catch (e) { out = { observations: [], skipped: `checker failed: ${e.message}` }; }
    rec.checkerMs = out?.checkerMs ?? (Date.now() - t0 - rec.shotMs);
    const observations = (Array.isArray(out?.observations) ? out.observations : []).map(String).filter(Boolean);
    if (out?.skipped || !observations.length) { rec.skipped = out?.skipped || 'nothing observed'; return; }
    rec.observations = observations;
    rec.readyAt = Date.now() - run.startedAt;
    rec.note = checkNoteText(targets, observations);
    rec.url = url;
  });
  run.pendingChecks.push({ rec, shot, done });
  return rec;
}

// Before ANY next action touches the page, the pending screenshots must be taken:
// the check describes the screen the write left, not the one after the next call.
export async function settleShots(run) {
  for (const p of run.pendingChecks || []) await p.shot;
}

// The checks ready to hand the model, each with its `text`. `before` limits it to
// checks started by an earlier batch of calls (a check started in THIS batch is
// still running while the model thinks, and goes out with the next result). Waits
// at most `waitMs` from now; a check still running stays pending for next time.
export async function takeNotes(run, { before = Infinity, waitMs = CHECK_WAIT_MS } = {}) {
  const pending = (run.pendingChecks || []).filter(p => p.rec.idx < before);
  if (!pending.length) return [];
  const t0 = Date.now();
  let timer;
  const cap = new Promise(r => { timer = setTimeout(r, waitMs); });
  await Promise.race([Promise.all(pending.map(p => p.done)), cap]);
  clearTimeout(timer);
  const out = [];
  for (const p of pending) {
    const { rec } = p;
    if (!rec.skipped && !rec.note) continue;   // still running: stays pending
    run.pendingChecks = run.pendingChecks.filter(x => x !== p);
    if (!rec.note) continue;
    rec.deliveredAt = Date.now() - run.startedAt;
    rec.waitedMs = Date.now() - t0;
    rec.msgIdx = run.messages?.length ?? 0;
    out.push({ rec, text: rec.note });
    delete rec.note;
  }
  return out;
}
