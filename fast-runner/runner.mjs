// Agent loop: task -> Grok -> FastLink tool calls -> ... until report_done / ask_caller / budget.
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMessage, ensureProxy, MODEL } from './xai.mjs';
import { connect } from './fastlink-client.mjs';
import { startVisualCheck, startLookCheck, settleShots, takeNotes } from './visual-check.mjs';
import { startRecording, stopRecording } from './recorder.mjs';

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
- Do every step the task names, in order, before report_done; if you cannot do a step, say which and why in result.
- When finished call report_done with a concise result and evidence (what you read back, URL). report_done is refused unless a read (fast_snapshot/fast_text) followed your last action and evidence quotes that result verbatim. A tool call that failed and was never retried also blocks report_done — retry it, or say in result why it is not needed. So does a result that claims an action (opened, clicked, selected, filled, submitted…) no successful tool call performed — say what you observed, not what you intended. Do not end your turn without calling report_done or ask_caller.`;

// Evidence gate for report_done (a caller-facing contract, every toolset):
//  1. the run must have READ the page after its last state-changing call (that
//     call's own verified:true read-back counts — readBack below);
//  2. `evidence` must quote a tool result of this run, taken on the CURRENT
//     (last-seen) URL — a quote from an earlier page is not evidence for this one;
//  3. a failed call never retried (same tool+target, or another tool on that
//     target) is refused ONCE; the next report_done passes but the row records
//     `unresolvedFailures` for the bench. A failed read/wait also counts as
//     resolved by a later successful action followed by a successful read.
// Otherwise the model is told exactly what is missing and continues. Refusals
// are logged per run.
const STATE_TOOLS = new Set([
  'fast_click', 'fast_click_xy', 'fast_fill', 'fast_select_option', 'fast_key_press',
  'fast_type', 'fast_nav', 'fast_tab', 'fast_scroll',
  'fast_switch', 'fast_close', 'fast_batch',
]);
const READ_TOOLS = new Set(['fast_snapshot', 'fast_text', 'fast_screenshot', 'fast_evaluate', 'fast_list']);
const isStateChanging = (e) => STATE_TOOLS.has(e.name);
const isRead = (e) => READ_TOOLS.has(e.name) || (e.name === 'fast_wait' && !!(e.args && e.args.text));
// ONE normalization for both sides of the evidence match (tool results and the
// model's quote): JSON escapes copied verbatim (\uXXXX \n \t \" \\ \/) unescaped,
// NFKC (… → ..., fullwidth forms), curly quotes → straight, dash variants → "-",
// zero-width chars dropped, whitespace (nbsp included) collapsed, lowercased.
export const normQuote = (s) => String(s ?? '')
  .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\[nrt]/g, ' ').replace(/\\(["\\/])/g, '$1')
  .normalize('NFKC')
  .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
  .replace(/[‐-―−]/g, '-')
  .replace(/[​-‍⁠﻿]/g, '')
  .replace(/\s+/g, ' ').trim().toLowerCase();
const currentUrl = (run) => (run.urlTrail || [])[run.urlTrail?.length - 1] || '';

// The units a model quotes from a result: every string/number VALUE of the JSON
// (a content block, a field value, a label, a URL), split into lines, plus object
// keys that read as labels (contain a space: a {fields} name). Plain keys
// ("value", "text") are structure, never evidence. A non-JSON result is its lines.
const MAX_LEAVES = 20_000;
function leafLines(text, o) {
  const out = [];
  const add = (s) => { for (const l of String(s).split(/\r?\n/)) { const n = normQuote(l); if (n) out.push(n); } };
  const walk = (v) => {
    if (out.length >= MAX_LEAVES || v == null) return;
    if (typeof v === 'string' || typeof v === 'number') return add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/\s/.test(k)) add(k); walk(x); }
  };
  if (o && typeof o === 'object') walk(o); else add(text);
  return out;
}

// Every tool result passes through here, ALL its text blocks. FastLink reports
// failures as {"error":…} in the first block (not MCP isError). A result carrying
// `url` (fast_tab/nav/click/snapshot/wait, or its auto-snapshot's) extends
// urlTrail; a successful result joins the evidence corpus — full text, never a
// preview — tagged with the URL it was read on, pre-normalized for the gate.
export function recordResult(run, texts, isError) {
  const parts = (Array.isArray(texts) ? texts : [texts]).map(t => String(t ?? ''));
  const text = parts[0] || '';
  let o = null;
  if (text.startsWith('{') || text.startsWith('[')) { try { o = JSON.parse(text); } catch {} }
  const ok = !isError && typeof o?.error !== 'string';
  const url = typeof o?.url === 'string' ? o.url : typeof o?.snapshot?.url === 'string' ? o.snapshot.url : '';
  if (url && currentUrl(run) !== url) run.urlTrail.push(url);
  if (ok) run.corpus.push(corpusRow(parts, currentUrl(run)));
  return ok;
}
export function corpusRow(parts, url = '') {
  const lines = [];
  for (const p of parts) {
    let po = null;
    if (p.startsWith('{') || p.startsWith('[')) { try { po = JSON.parse(p); } catch {} }
    lines.push(...leafLines(p, po));
  }
  const text = parts.join('\n');
  return { text, url, norm: normQuote(text), leaves: '\n' + lines.join('\n') + '\n', leafSet: new Set(lines) };
}

// What the evidence quotes. (1) Quoted spans, each quote kind paired with its own
// closer ("…" “…” ‘…’ `…`, and '…' only when not an apostrophe) at ANY length, so
// a 3-char `value="JFK"` cannot shift the pairing of every later quote. (2) The
// unquoted segments between separators (newline, " ... ", ;, |, (), =, ", ", ": ").
// (3) Word runs of 3-6 words. All normalized like the corpus.
const QUOTED = /"([^"\n]{1,300})"|“([^”\n]{1,300})”|‘([^’\n]{1,300})’|`([^`\n]{1,300})`|(?<![\p{L}\p{N}])'([^'\n]{1,300})'(?![\p{L}\p{N}])/gu;
const SEGMENT_SEP = /\n|\s(?:\.{2,}|…|—|–|-|\|)\s|[;|()=]|,\s|:\s/;
const TRIM_PUNCT = /^[\s"'`.,;:!?]+|[\s"'`.,;:!?]+$/g;
export function evidenceFragments(ev) {
  const raw = [];
  for (const m of String(ev).matchAll(QUOTED)) raw.push(m.slice(1).find(x => x != null));
  for (const seg of String(ev).replace(QUOTED, '\n').split(SEGMENT_SEP)) raw.push(seg);
  const words = normQuote(ev).split(' ').filter(Boolean);
  for (let n = 6; n >= 3; n--) for (let i = 0; i + n <= words.length; i++) raw.push(words.slice(i, i + n).join(' '));
  return [...new Set(raw.map(f => normQuote(f).replace(TRIM_PUNCT, '')).filter(f => f.length >= 3))];
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Does corpus entry `c` contain fragment `f`? Strict by length: a 3-char quote
// must BE a whole value/line ("JFK"); a single word of 4+ chars must stand as a
// whole word inside a value/line ("Metrics", "£45.17", "10/15/2026"); a phrase
// must appear inside one value/line or in the raw result text.
function quotes(c, f) {
  if (c.leafSet.has(f)) return true;
  if (f.length < 4) return false;
  if (!f.includes(' ')) return new RegExp(`(?<![\\p{L}\\p{N}])${escRe(f)}(?![\\p{L}\\p{N}])`, 'u').test(c.leaves);
  return c.leaves.includes(f) || c.norm.includes(f);
}

// What a call was aimed at; the same target under another tool still counts as a retry.
const target = (e) => String(e.args?.text ?? e.args?.field ?? e.args?.match ?? '');
const stepTarget = (s) => String(s?.args?.text ?? s?.args?.field ?? s?.args?.match ?? '');
// Failures INSIDE an ok result: each field of a fast_fill {fields} and each entry
// of a fast_select_option {selections} that errored OR read back verified:false,
// and each failed fast_batch step (a step whose own result was not clean is
// ok:false — batch.js), is its own failed ACTION, target = the field label /
// selections key / step target (a batch fill/select step reports its fields, not
// itself). Stored on the toolLog entry as `partial` (the result is parsed once,
// here). h_repeat: a selections pick verified:false under a wrapper saying
// verified:true, and a batch saying "3/3 steps ok" over a 0/2 fill. A top-level
// single write/click whose own result is verified:false counts the same way.
// A verified:false entry also carries `unverified:true` + the tool's own `reason`
// ("cross-origin: value not readable", …): the write may well have landed, it is
// the READ-BACK that is missing, and that is what the end-of-run visual note asks
// the screen about. A FORCED fast_type (force/allowIframe) that did not come back
// verified:true is the same thing — the guard it bypassed was the read-back.
// An unread write is found by WALKING the result, not by matching a shape per
// tool. Live miss (Azure, 04ca273): `fast_do` reported it inside `executed[]`
// — {action:"type", target:"Virtual machine name text input", verified:false,
// reason:"unreadable: typed but not read back"} — one level below anything the
// old per-tool matching looked at, so `unverifiedWrites` came back empty and the
// note never ran. That was the THIRD distinct reason the note had not fired on a
// real page, and these shapes have changed twice in a day, so the rule is now
// structural: any node anywhere that says its value was not read back counts.
const unreadNode = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && (v.verified === false || v.unverified === true
      || (typeof v.reason === 'string' && /^(unreadable|cross-origin)\b/i.test(v.reason)));
// The label such a node is about: whatever it calls its target, else the key it
// was filed under (a {fields} map), else the call's own target.
const firstString = (...vals) => {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {   // a {label,section,…} descriptor
      const s = firstString(v.label, v.field, v.name, v.text);
      if (s) return s;
    }
  }
  return '';
};
// a key like `result` names the slot, not the write, so it is never a target
const GENERIC_KEYS = new Set(['result', 'results', 'value', 'data', 'response', 'out']);
const unreadTarget = (v, key, fallback) => firstString(v.field, v.target, v.label, v.match, v.name)
  || (typeof key === 'string' && !GENERIC_KEYS.has(key) ? key : '')
  || String(fallback ?? '');
// A BAG is a child holding per-field / per-step / per-action outcomes: an array
// of objects, or a map whose values are objects. A node holding one is a wrapper
// and the write is reported at the entry inside it. A plain `{tag,label}`
// descriptor (`filled:{label:"Birthdate"}`) is NOT a bag — its holder IS the
// report, which is how a pick that read back false is still caught under a
// wrapper claiming verified:true. Structural on purpose: a bag we have not seen
// before still behaves like one.
const isBag = (v) => (Array.isArray(v) ? v : Object.values(v || {})).some((x) => x && typeof x === 'object');
// A parent that says verified:false over children that say the same is ONE write,
// reported at the deepest place that names it (h_repeat: a wrapper saying
// verified:true over a selections pick saying false — the pick is the truth).
function walkUnread(node, tool, key, fallback, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return false;
  let deeper = false;
  if (Array.isArray(node)) {
    for (const v of node) deeper = walkUnread(v, tool, undefined, fallback, out, depth + 1) || deeper;
    return deeper;
  }
  let container = false;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'args' || k === 'plan' || k === 'typedInto') continue;   // the request, not the read-back
    if (v && typeof v === 'object' && isBag(v)) container = true;
    deeper = walkUnread(v, tool, k, fallback, out, depth + 1) || deeper;
  }
  // A write is reported at the leaf that names it, never at a wrapper over
  // per-field / per-step / per-action results: a fill whose fields each carry
  // their own outcome is those fields, not one nameless entry for the call.
  if (deeper || container || !unreadNode(node)) return deeper;
  out.push({ name: tool, target: unreadTarget(node, key, fallback), unverified: true, ...(typeof node.reason === 'string' ? { reason: node.reason } : {}) });
  return true;
}
export function partialFailures(name, args, text) {
  let o = null;
  try { o = JSON.parse(text); } catch { return []; }
  const out = [];
  const unread = (nm, tg, v) => ({ name: nm, target: tg, unverified: true, ...(typeof v?.reason === 'string' ? { reason: v.reason } : {}) });
  // children of a fill are reported under fast_fill whichever fill ran
  const childTool = (nm) => (nm === 'fast_fill_form' ? 'fast_fill' : nm);
  const errored = (bag, tool) => {
    if (bag && typeof bag === 'object') for (const [k, v] of Object.entries(bag)) {
      if (v && typeof v.error === 'string') out.push({ name: tool, target: k });
    }
  };
  const children = (nm, res) => {
    if (nm === 'fast_fill' || nm === 'fast_fill_form') errored(res?.fields, 'fast_fill');
    else if (nm === 'fast_select_option') errored(res?.results, 'fast_select_option');
  };
  if (name !== 'fast_batch') {
    children(name, o);
    walkUnread(o, childTool(name), undefined, target({ args }), out);
    // an OLD build that reports no `verified` at all: a FORCED fast_type bypassed
    // the editable-focus guard, and that guard IS the missing read-back
    const forcedType = name === 'fast_type' && (args?.force === true || args?.allowIframe === true);
    if (!out.length && forcedType && o?.verified !== true && typeof o?.error !== 'string') {
      out.push(unread(name, target({ args }), { reason: 'forced: the editable-focus guard was bypassed, so nothing read the value back' }));
    }
  }
  else if (Array.isArray(o?.results)) {
    const steps = args?.actions || args?.steps || [];
    for (const r of o.results) {
      if (!r) continue;
      const st = steps[r.step] || { name: r.name };
      const nm = st.name || r.name;
      const before = out.length;
      children(nm, r.result);
      walkUnread(r.result, childTool(nm), undefined, stepTarget(st), out);
      if (out.length === before && r.ok === false) out.push({ name: nm, target: stepTarget(st) });
    }
  }
  return out;
}
// A write whose OWN result read the value back from the page (`verified:true` on a
// fast_fill / fast_fill {fields} / fast_select_option; for a fast_batch, its LAST
// state-changing step is such a verified write) is the read-after-action for that
// write — not for any later action. overlay p1-p3 (gate=record, 2026-09-15): the
// select result carried verified:true, picked:"Forest", value:"Forest".
const VERIFYING_WRITES = new Set(['fast_fill', 'fast_fill_form', 'fast_select_option', 'fast_type']);
function readBack(name, args, o) {
  if (VERIFYING_WRITES.has(name)) return o?.verified === true;
  if (name !== 'fast_batch' || !Array.isArray(o?.results)) return false;
  const steps = args?.actions || args?.steps || [];
  for (let i = o.results.length - 1; i >= 0; i--) {
    const r = o.results[i];
    const nm = (r && steps[r.step]?.name) || r?.name;
    if (!STATE_TOOLS.has(nm) && nm !== 'fast_fill_form') continue;
    return r.ok !== false && VERIFYING_WRITES.has(nm) && r.result?.verified === true;
  }
  return false;
}
// What the gate needs from one result, stored on its toolLog entry (parsed once):
// `partial` (missed fields / failed batch steps), `sections` (where writes landed),
// `verified` (its own read-back, above), `url` (the page it reports), and for a
// FAILED call whose error says its target is a select control (`selectField`),
// `redirect:"fast_select_option"` — the tool that error told the model to use.
export function entryFacts(name, args, text, ok) {
  let o = null;
  try { o = JSON.parse(text); } catch {}
  const out = {};
  if (typeof o?.url === 'string') out.url = o.url;
  if (!ok) {
    if (o?.selectField && typeof o.selectField === 'object') out.redirect = 'fast_select_option';
    return out;
  }
  if (writeEffect(name, args, o)) out.effect = true;
  const partial = partialFailures(name, args, text);
  const sections = resultSections(text);
  if (partial.length) out.partial = partial;
  if (sections.length) out.sections = sections;
  if (readBack(name, args, o)) out.verified = true;
  return out;
}
// Sections a successful fill/select RESULT says it acted in: the `section` of each
// written field's `filled` / `field` descriptor (fast_select_option reports one).
export function resultSections(text) {
  let o = null;
  try { o = JSON.parse(text); } catch { return []; }
  const out = new Set();
  const take = (r) => { if (!r || typeof r !== 'object' || typeof r.error === 'string') return; for (const d of [r.filled, r.field]) if (d && typeof d.section === 'string' && d.section) out.add(d.section); };
  take(o);
  for (const bag of [o?.fields, o?.results]) if (bag && typeof bag === 'object') for (const r of Object.values(bag)) { take(r); take(r?.result); }
  return [...out];
}
// Targets a SUCCESSFUL call acted on: its own target, every {fields} / selections
// label and every batch step target — minus what it reported as missed — plus the
// SECTION each written field sat in (args `section`/`near`, top-level or per field,
// and the result's own report): a "section with no input yet" miss is resolved by
// filling the created field with section:<that label>, exactly as its hint says.
const FILL_SELECT = new Set(['fast_fill', 'fast_fill_form', 'fast_select_option', 'fast_type', 'fast_batch']);
const sectionsOf = (args, missed) => {
  const top = args?.section ?? args?.near;
  const out = [];
  const fields = args?.fields && typeof args.fields === 'object' ? Object.entries(args.fields) : [];
  for (const [k, v] of fields) {
    if (missed.has(k)) continue;
    const s = v && typeof v === 'object' ? (v.section ?? v.near ?? top) : top;
    if (s) out.push(String(s));
  }
  if (!fields.length && top && !missed.has(target({ args }))) out.push(String(top));
  return out;
};
const succeededTargets = (e) => {
  if (!e.ok) return [];
  const missed = new Set((e.partial || []).map(p => p.target));
  const ts = [target(e), ...Object.keys(e.args?.fields || {}), ...Object.keys(e.args?.selections || {})];
  for (const s of e.args?.actions || e.args?.steps || []) ts.push(stepTarget(s), ...Object.keys(s?.args?.fields || {}), ...Object.keys(s?.args?.selections || {}), ...sectionsOf(s?.args, missed));
  return [...ts.filter(t => t && !missed.has(t)), ...sectionsOf(e.args, missed), ...(e.sections || [])];
};
const sameTarget = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const describe = (f) => f.name + (f.target ? ` ${JSON.stringify(f.target)}` : '');
// Failed calls whose intent never succeeded afterwards (latest attempt per tool+target).
// A failed ACTION needs a retry on its target (or another tool on it). A failed
// READ/WAIT is also resolved when the page moved on: a later successful
// state-changing call followed by a successful read (the wait for "min" that
// timed out before Enter submitted the route is moot once the routes were read).
const isReadOrWait = (e) => READ_TOOLS.has(e.name) || e.name === 'fast_wait';
// A missed {fields} label / failed batch step (entry.partial) is resolved only by a
// later successful fill/select/batch that acted on that label.
export function unresolvedFailures(log) {
  const out = new Map();
  log.forEach((e, i) => {
    const later = log.slice(i + 1);
    for (const p of e.partial || []) {
      const retried = later.some(x => FILL_SELECT.has(x.name) && succeededTargets(x).some(t => sameTarget(t, p.target)))
        || (!FILL_SELECT.has(p.name) && later.some(x => x.ok && x.name === p.name && target(x) === p.target));
      if (!retried) out.set(`${p.name}\0${p.target}`, { name: p.name, target: p.target, t: e.t, ...(p.unverified ? { unverified: true } : {}), ...(p.reason ? { reason: p.reason } : {}) });
    }
    if (e.ok) return;
    const tg = target(e);
    const retried = later.some(x => x.ok && (x.name === e.name ? target(x) === tg : tg !== '' && target(x) === tg))
      || (tg !== '' && later.some(x => succeededTargets(x).some(t => sameTarget(t, tg))));
    const overtaken = isReadOrWait(e) && later.some((x, j) => x.ok && isStateChanging(x) && later.slice(j + 1).some(y => y.ok && isRead(y)));
    // the error named the tool to use instead (a click/type on a select control →
    // fast_select_option); that tool succeeding later supersedes the failed call
    const redirected = !!e.redirect && later.some(x => x.ok && x.name === e.redirect);
    if (!retried && !overtaken && !redirected) out.set(`${e.name}\0${tg}`, { name: e.name, target: tg, t: e.t });
  });
  return [...out.values()];
}

// The writes nothing could read back: the unresolved failures flagged
// `unverified` — a result that said verified:false, or a forced fast_type whose
// bypassed guard IS the missing read-back. This is not a claim that they failed:
// only that the page never confirmed them, which is exactly what a screenshot
// can still be asked about.
export const unverifiedWrites = (log) => unresolvedFailures(log || []).filter(f => f.unverified);

// The model's OWN action claims vs. the calls it made (no task parsing): a
// `result` saying "opened / clicked / selected / filled / submitted …" needs a
// successful call of that family (fast_batch steps count). Negated mentions
// ("Search NOT clicked", "form not submitted") are not claims. The run's FIRST
// fast_tab / fast_nav satisfies an open/navigate claim whose clause names what that
// call loaded, whatever the phrasing: its URL (requested or landed; scheme, www,
// query, trailing slash ignored), or a tab when it was fast_tab. Structural, not
// wording: "New tab opened to https://www.aa.com/booking/search/find-flights"
// (flightsearch p1-p3) passes; 'Worker "fastlink-relay" opened' with only the list
// page loaded (cfworkers fbc16cf2) names neither, so it still needs a click/2nd load.
// A custom dropdown is "selected" by clicking its option and a native <select>
// can be set by fast_fill, so the select family includes both; fast_fill_form is
// still a valid batch step name.
const CLICKS = ['fast_click', 'fast_click_xy'];
const CLAIMS = [
  { re: /\b(opened|navigated|drilled|went to)\b/gi, family: 'fast_click / fast_nav / fast_tab (beyond the first page load)', nav: true },
  { re: /\b(clicked|added|checked)\b/gi, family: 'fast_click', tools: CLICKS },
  { re: /\b(selected|picked)\b/gi, family: 'fast_select_option / fast_click / fast_fill', tools: ['fast_select_option', 'fast_fill', 'fast_fill_form', ...CLICKS], enter: true },
  { re: /\b(filled|entered|typed)\b/gi, family: 'fast_fill', tools: ['fast_fill', 'fast_fill_form', 'fast_type'] },
  { re: /\b(submitted)\b/gi, family: 'fast_click / fast_key_press Enter', tools: CLICKS, enter: true },
];
const VERB_BASE = { opened: 'open', navigated: 'navigate', drilled: 'drill in', 'went to': 'go to', clicked: 'click', added: 'add', checked: 'check', selected: 'select', picked: 'pick', filled: 'fill', entered: 'enter', typed: 'type', submitted: 'submit' };
const NEGATED_BEFORE =/(?:\b(?:not|never|no|nothing|none|neither|without|nor)|n't)\s+(?:[\w-]+\s+){0,2}$/i;
// Successful calls, fast_batch steps flattened (incl. ifFound then/else), in log order;
// a top-level call keeps the url its result reported.
const successfulCalls = (log) => {
  const out = [];
  const steps = (list) => { for (const s of list || []) { if (!s || typeof s !== 'object') continue; if (s.name) out.push({ name: s.name, args: s.args || {} }); steps(s.then); steps(s.else); } };
  for (const e of log) { if (!e.ok) continue; out.push({ name: e.name, args: e.args || {}, url: e.url }); if (e.name === 'fast_batch') steps(e.args?.actions || e.args?.steps); }
  return out;
};
const normUrl = (u) => String(u || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
const URL_IN = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'<>(),;]*)?/gi;
// The clause (sentence / ;-part / line) holding position i; a "." inside a URL is not an end.
const clauseAt = (text, i) => {
  const end = /[.!?;](?=\s|$)|\n/g;
  let start = 0, m;
  while ((m = end.exec(text))) { if (m.index >= i) return text.slice(start, m.index); start = m.index + 1; }
  return text.slice(start);
};
export function claimMismatch(log, result) {
  const text = String(result ?? '');
  const calls = successfulCalls(log || []);
  const loads = calls.filter(c => c.name === 'fast_tab' || c.name === 'fast_nav');
  const firstUrls = new Set(loads.length ? [normUrl(loads[0].args.url), normUrl(loads[0].url)].filter(Boolean) : []);
  // Does the clause point at some target OTHER than what the first load fetched?
  // Structural, not semantic: a URL none of the loads matches, or a QUOTED entity
  // ("fastlink-relay") the loaded URL does not contain. Anything else — an
  // unquoted description of the page that WAS loaded ("Opened the VM creation
  // page"), or a mention of the call itself ("fast_tab succeeded") — names no
  // other target, so the first load satisfies it.
  const flat = (s) => normQuote(s).replace(/[^a-z0-9]+/g, '');
  const loadedFlat = [...firstUrls].map(flat).join(' ');
  const namesOtherTarget = (clause) => {
    const urls = [...clause.matchAll(URL_IN)].map(u => normUrl(u[0].replace(/[.!?:]+$/, '')));
    if (urls.length && !urls.some(u => firstUrls.has(u))) return true;
    const quoted = [...clause.matchAll(QUOTED)].map(m => m.slice(1).find(x => x != null)).filter(Boolean);
    return quoted.some(q => flat(q) && !loadedFlat.includes(flat(q)));
  };
  const namesFirstLoad = (clause) => [...clause.matchAll(URL_IN)].some(u => firstUrls.has(normUrl(u[0].replace(/[.!?:]+$/, ''))))
    || (loads[0]?.name === 'fast_tab' && /\btab\b/i.test(clause))
    || /\bfast_(tab|nav)\b/i.test(clause)
    || !namesOtherTarget(clause);
  const out = [];
  for (const c of CLAIMS) {
    let verb = null;
    for (const m of text.matchAll(c.re)) {
      if (NEGATED_BEFORE.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
      if (c.nav && loads.length && namesFirstLoad(clauseAt(text, m.index))) continue;
      verb = m[1].toLowerCase(); break;
    }
    if (!verb) continue;
    const done = c.nav
      ? calls.some(x => CLICKS.includes(x.name)) || loads.length > 1
      : calls.some(x => c.tools.includes(x.name) || (c.enter && x.name === 'fast_key_press' && /^enter$/i.test(String(x.args.key || ''))));
    if (!done) out.push({ verb, family: c.family });
  }
  return out;
}

export function gateProblems(run, args) {
  const log = run.toolLog || [];
  const problems = [];
  if (!log.length) problems.push('no tool has been called — the page has not been read');
  else {
    let last = -1;
    for (let i = log.length - 1; i >= 0; i--) if (isStateChanging(log[i])) { last = i; break; }
    const selfVerified = last >= 0 && log[last].ok && (log[last].verified === true || log[last].seen === true);
    if (!selfVerified && !log.slice(last + 1).some(e => e.ok && isRead(e))) {
      problems.push(last >= 0
        ? `no tool has read the page since your last ${log[last].name}; call fast_snapshot or fast_text (its own auto-snapshot is not a read-back) and cite what it returned`
        : 'no successful read of the page yet; call fast_snapshot or fast_text and cite what it returned');
    }
  }
  const ev = String(args?.evidence ?? '').trim();
  if (!ev) problems.push('evidence is empty — quote what you read back from the page, plus the URL');
  else {
    const qs = evidenceFragments(ev);
    const hits = (run.corpus || []).filter(c => qs.some(q => quotes(c, q)));
    const now = currentUrl(run);
    if (!hits.length) problems.push('evidence does not quote any tool result of this run — copy a phrase exactly as the last fast_snapshot/fast_text result showed it (a content text, a field value, a number), then report again');
    else if (now && !hits.some(c => c.url === now)) problems.push(`evidence quotes a result read on ${hits[hits.length - 1].url || 'an earlier page'}, but the page is now at ${now}; read the current page (fast_snapshot/fast_text) and quote that result`);
  }
  // one refusal per run: a prior refusal that recorded unresolvedFailures already said this
  if (!(run.gateRefusals || []).some(r => r.unresolvedFailures)) {
    for (const f of unresolvedFailures(log).filter(f => !(f.unverified && log.some(e => e.seen && e.t === f.t)))) problems.push(`your last attempt to ${describe(f)} failed and was never retried; retry it or explain in \`result\` why it is not needed`);
  }
  // same one-refusal rule for an action the result claims but no call performed
  if (!(run.gateRefusals || []).some(r => r.claimMismatch)) {
    for (const c of claimMismatch(log, args?.result)) problems.push(`your result says "${c.verb}" but no ${c.family} call succeeded. If the task asked you to ${VERB_BASE[c.verb] || c.verb}, do it now; only if it did not, rewrite result to say what you actually observed`);
  }
  return problems;
}

// Gate mode, ONE per run (--gate / `gate` arg / FASTRUN_GATE env, default "on"):
//   on     — the gate above: refuse, up to MAX_GATE_REFUSALS, then accept flagged gateOverridden
//   record — run every check exactly as `on` would at the FIRST report_done, but never
//            refuse: the report is accepted and, when `on` would have refused, the row
//            gets gateWouldRefuse:[{t, problems, evidence, result}] (measures the model alone)
//   off    — no checks, no gate fields
// The system prompt is the same in every mode, so only the refusal itself changes.
export const GATE_MODES = ['on', 'record', 'off'];
export function gateMode(spec = process.env.FASTRUN_GATE || 'on') {
  const m = String(spec || 'on').toLowerCase();
  if (!GATE_MODES.includes(m)) throw new Error(`gate "${spec}": must be one of ${GATE_MODES.join(' | ')}`);
  return m;
}

// The loop's decision at a report_done: { refuse: problems } (on: the model continues)
// or { finish: fields } (the run ends 'done' with these fields).
export function reportDone(run, args, t) {
  const done = (fields = {}) => ({ finish: { result: annotate(args.result ?? '', fields.screenMismatch), evidence: args.evidence ?? '', ...fields } });
  if (run.gate === 'off') return done();
  const problems = gateProblems(run, args);
  const unresolved = unresolvedFailures(run.toolLog);
  const claims = claimMismatch(run.toolLog, args.result);
  const screen = screenMismatch(run, unresolved);
  const checks = { unresolvedFailures: unresolved.length ? unresolved : null, claimMismatch: claims.length ? claims : null, ...(screen.length ? { screenMismatch: screen } : {}) };
  const report = { result: String(args.result ?? '').slice(0, 2000), evidence: String(args.evidence ?? '').slice(0, 4000) };
  if (problems.length && run.gate === 'record') return done({ ...checks, gateWouldRefuse: [{ t, problems, ...report }] });
  if (problems.length && run.gateRefusals.length < MAX_GATE_REFUSALS) {
    // the refused report itself, so a post-mortem sees what was quoted
    run.gateRefusals.push({ turn: run.turns.length, t, problems, ...report, ...(unresolved.length ? { unresolvedFailures: unresolved } : {}), ...(claims.length ? { claimMismatch: claims } : {}) });
    return { refuse: problems };
  }
  if (problems.length) run.gateOverridden = problems;
  return done(checks);
}

// What happens at a report_done: any visual check still owed to the model (a write
// made in the same turn as the report) is awaited and handed over TOGETHER with
// whatever the gate has to say, in ONE round — never note first and gate problems
// a round later (Azure 5f06a066: note at turn 8, the gate's problems only at turn
// 10 and 11). A report the gate would accept still gets one round with the note,
// so the model sees the screen before its report is recorded.
//
// A report that follows failed looks gets one look of its own first (unlookedFailures): the
// screenshot is taken now and its observations ride in that same round.
export async function reportDecision(run, args, t, deps = {}) {
  const look = unlookedFailures(run);
  if (look) startLookCheck(run, look, deps);
  const notes = await deliverChecks(run);
  const verdict = reportDone(run, args, t);
  if (!notes.length) return verdict;
  return verdict.refuse ? { note: notes.join('\n\n'), refuse: verdict.refuse } : { note: notes.join('\n\n') };
}

// A report accepted while it still carries a failed call (wait, read, click…) on a target the report look answered
// seen:true (the checker's own per-target boolean, never its prose), with no successful
// state-changing call since that look was handed over. Not a refusal and no judgement of the
// report: the caller's result gets one mechanical line per target and the row gets
// screenMismatch. Live: Azure b1d84267, the look saw "Virtual machine name" (box empty) and the
// accepted report said that text "never appeared".
export function screenMismatch(run, unresolved = unresolvedFailures(run.toolLog || [])) {
  const log = run.toolLog || [];
  const out = [];
  for (const c of run.visualChecks || []) {
    if (c.kind !== 'report' || c.deliveredAt == null || !c.seen) continue;
    if (log.some(e => e.ok && isStateChanging(e) && e.t >= c.deliveredAt)) continue;
    for (const [tg, seen] of Object.entries(c.seen)) {
      if (seen !== true || out.some(o => sameTarget(o.target, tg))) continue;
      const f = unresolved.find(u => !u.unverified && sameTarget(u.target, tg));
      if (f) out.push({ target: tg, name: f.name, failedAt: f.t, seenAt: c.readyAt ?? c.deliveredAt });
    }
  }
  return out;
}
const annotate = (result, mismatches) => !mismatches?.length ? result : [
  String(result),
  ...mismatches.map(m => `[screen check] A screenshot taken at ${Math.round(m.seenAt / 1000)}s showed "${m.target}" visible, and the run did not act on the page after that.`),
].join('\n');

// When a report_done gets ONE look at the screen, decided on structure alone, never the report's
// wording (phrase lists for "didn't load / blank / not there" were rejected as fragile):
//   - a call failed and is still unresolved (errored, never retried or overtaken): a wait or read
//     that did not find its text, or a click/fill whose target was not there ("Nothing was
//     clicked") — both are the run failing to see something on the page. Unread writes are not
//     in this set: they have their own check at the write;
//   - nothing had an EFFECT on the page in the whole run (writeEffect below; navigation does not
//     count: fast_tab loaded it);
//   - no screenshot succeeded after the latest of those failures (a screenshot the model took
//     earlier shows a page the later failure is not about), and
//   - this run has not had that look yet.
// A run that gave up without changing anything, after attempts that found nothing, has only its
// report to say what is on the screen; a screenshot answers it in ~2s. Conservative both ways:
// one effective write anywhere or one screenshot since the failure and it never fires, and it
// fires at most once. Returns { idx, failures } or null.
//
// Live miss that set the effect rule (Azure 4bf918fb): two fast_clicks errored ("No element
// matching"), the model's own screenshot sat between them, then a fast_click_xy returned ok with
// focused:{tag:"div", editable:false} and no URL change. That click changed nothing, yet counted
// as a write, and the report ("redirected to login") went out unlooked.
const WRITE_TOOLS = new Set(['fast_click', 'fast_click_xy', 'fast_fill', 'fast_fill_form', 'fast_select_option', 'fast_key_press', 'fast_type']);
// A write counts only when its OWN result shows it changed something: a value read back verified
// (a fill, a pick, a toggled check — per field or per selection too), a navigation / URL change, a
// dialog opened or closed, or focus now on an editable target. An errored call never counts. A
// fast_batch counts when one of its write steps does.
function resultEffect(o) {
  if (!o || typeof o !== 'object' || typeof o.error === 'string') return false;
  if (o.verified === true || o.urlChanged === true || o.navigated === true || o.willNavigate === true) return true;
  if (o.dialogOpened || o.dialogClosed || o.focused?.editable === true) return true;
  for (const bag of [o.fields, o.results]) {
    if (bag && typeof bag === 'object' && !Array.isArray(bag) && Object.values(bag).some(v => v?.verified === true)) return true;
  }
  return false;
}
export function writeEffect(name, args, o) {
  if (WRITE_TOOLS.has(name)) return resultEffect(o);
  if (name !== 'fast_batch' || !Array.isArray(o?.results)) return false;
  const steps = args?.actions || args?.steps || [];
  return o.results.some(r => r && r.ok !== false && WRITE_TOOLS.has(steps[r.step]?.name || r.name) && resultEffect(r.result));
}
export function unlookedFailures(run) {
  const log = run.toolLog || [];
  if (run.gate === 'off' || (run.visualChecks || []).some(c => c.kind === 'report') || log.some(e => e.ok && e.effect === true)) return null;
  const failures = unresolvedFailures(log).filter(f => !f.unverified);
  if (!failures.length) return null;
  const last = Math.max(...failures.map(f => f.t));
  const idx = log.findLastIndex(e => !e.ok && e.t === last);
  if (idx < 0 || log.slice(idx + 1).some(e => e.ok && e.name === 'fast_screenshot')) return null;
  return { idx, failures };
}

// Hand over the finished visual checks: each one's observations are a read of the
// page right after its write — they join the evidence corpus (tagged with the URL
// the screenshot was taken on) and mark that write as seen, so the gate neither
// asks for a read-back the model already holds nor calls the write a failure.
export async function deliverChecks(run, opts) {
  const out = await takeNotes(run, opts);
  for (const { rec } of out) {
    run.toolLog[rec.idx].seen = true;
    run.corpus.push(corpusRow(rec.observations, rec.url));
  }
  return out.map(o => o.text);
}

// What the model did after each check reached it: whether it changed the page, and
// the first thing it said. Called once, as the run finishes.
export function closeVisualChecks(run) {
  for (const c of run.visualChecks || []) {
    if (c.deliveredAt == null || c.actedAfter != null) continue;
    c.actedAfter = (run.toolLog || []).slice(c.idx + 1).some(e => e.ok && isStateChanging(e) && e.t >= c.deliveredAt);
    const said = (run.messages || []).slice(c.msgIdx).find(m => m.role === 'assistant' && m.content.some(x => x.type === 'text' && x.text.trim()));
    c.model_response = said ? said.content.filter(x => x.type === 'text').map(x => x.text).join('\n').trim().slice(0, 2000) : '';
    delete c.msgIdx;
  }
}

// The gate fields a run row / snapshot carries, per mode.
const gateFields = (run) => run.gate === 'off' ? { gate: 'off' } : {
  gate: run.gate,
  ...(run.gate === 'on' ? { gateRefusals: run.gateRefusals, gateOverridden: run.gateOverridden || undefined } : { gateWouldRefuse: run.gateWouldRefuse || undefined }),
  unresolvedFailures: run.unresolvedFailures || undefined, claimMismatch: run.claimMismatch || undefined, screenMismatch: run.screenMismatch || undefined,
};

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

// Server tools that are NEVER model-facing, whatever a toolset says ("*" or an explicit allow).
// Applied here, after the toolset's own allow-filter, and nowhere else. fast_frame_read is the
// bench scorer's read of fields inside cross-origin frames (f7f3925); the scorer calls it through
// its own handler (bench/fastlink.js), never through a runner toolset. fast_ext_reload is an operator
// tool: a model reloading the extension mid-run tears down its own content scripts and can drop the
// broker link under its own run; scripts/ship-ext.sh calls it through fastlink-client.mjs callTool,
// not a toolset. Not fast_evaluate: that is
// also a scorer instrument, but toolset.phase2-eval.json passes it to the model on purpose (the
// owner's A/B, bench/hvm-queue-feedback.sh), and phase2/no-cdp already leave it out.
export const HIDDEN_TOOLS = new Set(['fast_frame_read', 'fast_ext_reload']);

// allow-filter, rename (Grok-facing name -> real name on call), describe overrides (keyed by REAL
// name; ask_caller/report_done accept one too, so a toolset can tighten the report without
// touching the baseline). A HIDDEN_TOOLS entry is dropped last, so it is also never in `back`.
export function buildTools(mcpTools, toolset) {
  const allowAll = toolset.allow.includes('*');
  const back = new Map();
  const tools = [];
  for (const t of mcpTools) {
    if (!allowAll && !toolset.allow.includes(t.name)) continue;
    if (HIDDEN_TOOLS.has(t.name)) continue;
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
  return { ...base, result: run.result, evidence: run.evidence, error: run.error, so_far: soFar(run), histogram: histogram(run), model: MODEL, toolset: run.toolset.name, urlTrail: run.urlTrail, ...gateFields(run), visualChecks: run.visualChecks || undefined, video: run.video };
}

function notify(run) {
  const w = run.waiters; run.waiters = [];
  for (const r of w) r(snapshot(run));
}

function finish(run, status, fields = {}) {
  if (run.done) return;
  run.done = true;
  Object.assign(run, fields, { status, endedAt: Date.now() });
  closeVisualChecks(run);   // what the model did with each visual check
  // Every terminal path (done/budget/error/cancelled/loop crash) comes through here, so this is where
  // the MCP client is closed (the local fast-dxt/server child exits with it) and the recording is
  // stopped and verified. The row, the caller and cancelAll wait for BOTH, so a process that exits
  // right after never leaves a server behind, and the row carries `video`.
  const closed = run.client?.close().catch(() => {});
  return (run.finished = Promise.all([stopRecording(run.id, run.video), closed]).then(([video]) => { run.video = video; writeRow(run, status); notify(run); }));
}

function writeRow(run, status) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(RUNS_FILE, JSON.stringify({
      run_id: run.id, task: run.task, transport: run.transport, browser: run.browser, model: MODEL,
      toolset: run.toolset.name, status, startedAt: new Date(run.startedAt).toISOString(), wallMs: run.endedAt - run.startedAt,
      toolCalls: run.toolLog.length, histogram: histogram(run), toolLog: run.toolLog, turns: run.turns,
      result: run.result, evidence: run.evidence, error: run.error, usage: run.usage, urlTrail: run.urlTrail,
      ...gateFields(run), visualChecks: run.visualChecks || undefined, video: run.video,
    }) + '\n');
  } catch {}
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
      const notes = await deliverChecks(run);
      run.messages.push({ role: 'user', content: [...notes.map(text => ({ type: 'text', text })), { type: 'text', text: 'You ended your turn without calling report_done or ask_caller. Continue the task, or call report_done now.' }] });
      continue;
    }
    nudges = 0;

    const results = [];
    const batchStart = run.toolLog.length;   // checks started from here on go out with the NEXT batch
    for (const u of uses) {
      if (run.cancelled) return;
      const args = u.input || {};
      await settleShots(run);   // a pending check's screenshot is taken before the page is touched again
      if (u.name === 'report_done') {
        const verdict = await reportDecision(run, args, Date.now() - t0);
        if (verdict.note) {
          onEvent?.({ type: 'visualCheck', text: verdict.note });
          if (verdict.refuse) onEvent?.({ type: 'gate', problems: verdict.refuse });
          const text = verdict.refuse ? `${verdict.note}\n\nreport_done refused: ${verdict.refuse.join('; ')}. Fix that, then call report_done again.` : verdict.note;
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: [{ type: 'text', text }] });
          continue;
        }
        if (verdict.refuse) {
          onEvent?.({ type: 'gate', problems: verdict.refuse });
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: [{ type: 'text', text: `report_done refused: ${verdict.refuse.join('; ')}. Fix that, then call report_done again.` }] });
          continue;
        }
        return finish(run, 'done', verdict.finish);
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
      const texts = (res?.content || []).filter(c => c.type === 'text').map(c => c.text);
      const firstText = texts[0] || '';
      ok = recordResult(run, texts, !!res?.isError); // urlTrail + evidence corpus (corpus is memory only, not written to runs.jsonl)
      // 1200 chars: enough of a result to post-mortem a fumble from runs.jsonl
      // (an error's candidates / a batch's per-step results); 160 showed only the
      // first key of a snapshot.
      const preview = firstText.slice(0, 1200);
      run.toolLog.push({ t: t1 - t0, name: real || u.name, args, ms, ok, preview, ...entryFacts(real || u.name, args, firstText, ok) });
      startVisualCheck(run, run.toolLog.length - 1);   // no-op unless this call left a write unread
      onEvent?.({ type: 'tool', name: real || u.name, args, ms, ok, preview });
      run.consecutiveErrors = ok ? 0 : run.consecutiveErrors + 1;
      results.push({ type: 'tool_result', tool_use_id: u.id, content: toolResultContent(res), ...(ok ? {} : { is_error: true }) });
      if (run.consecutiveErrors >= budgets.maxConsecutiveErrors) {
        run.messages.push({ role: 'user', content: results });
        return finish(run, 'error', { error: `${budgets.maxConsecutiveErrors} consecutive tool errors` });
      }
    }
    // checks from EARLIER batches have been running while the model thought and
    // these calls ran; they are normally done by now and ride along with this result
    for (const text of await deliverChecks(run, { before: batchStart })) {
      onEvent?.({ type: 'visualCheck', text });
      results.push({ type: 'text', text });
    }
    run.messages.push({ role: 'user', content: results });
    run.status = 'running';
  }
}

export async function runTask({ task, transport = 'relay', browser, toolset: toolsetSpec, gate: gateSpec, budgets = {}, holdMs = 240_000, onEvent } = {}) {
  if (!task) throw new Error('task required');
  const toolset = loadToolset(toolsetSpec); // throws before any connect on a bad name/path
  const gate = gateMode(gateSpec);
  const runBudgets = { ...DEFAULT_BUDGETS, ...budgets };
  const id = randomBytes(4).toString('hex');
  // Every run is screen-recorded as <run_id>.mkv (scripts/record.sh). Started alongside the connect so
  // it costs no extra wall time; it never throws — a run that could not be recorded says so and runs.
  const recording = startRecording(id, { maxSec: runBudgets.maxWallMs / 1000 + 300 });
  let client, tools, back;
  try {
    await ensureProxy();
    client = await connect({ transport, browser });
    ({ tools, back } = buildTools(await client.listTools(), toolset));
  } catch (e) {
    await Promise.all([client?.close().catch(() => {}), stopRecording(id, await recording)]);
    throw e;
  }
  const video = await recording;
  onEvent?.({ type: 'recording', video });
  const run = {
    id, video, task, transport, browser, toolset, gate, status: 'running',
    messages: [{ role: 'user', content: [{ type: 'text', text: `TASK: ${task}` }] }],
    system: buildSystem(toolset, client.instructions),
    tools, back, client, toolLog: [], turns: [], corpus: [], urlTrail: [], gateRefusals: [], gateOverridden: null, gateWouldRefuse: null, unresolvedFailures: null, visualChecks: [], pendingChecks: [], question: null, waiters: [], pendingAnswer: null,
    budgets: runBudgets, onEvent, startedAt: Date.now(), consecutiveErrors: 0,
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

export function cancel(runId, reason = 'cancelled by caller') {
  const run = runs.get(runId);
  if (!run) return { status: 'error', run_id: runId, error: 'unknown run_id' };
  if (run.done) return snapshot(run);
  run.cancelled = true;
  run.abort.abort();
  run.pendingAnswer?.('');
  finish(run, 'cancelled', { error: reason });
  return snapshot(run);
}

// A process being killed (bench ceiling / STUCK sends SIGTERM) still ends its runs through finish():
// recording stopped + verified, row written. Resolves when every row is on disk.
export async function cancelAll(reason) {
  for (const run of runs.values()) if (!run.done) cancel(run.id, reason);
  await Promise.all([...runs.values()].map(r => r.finished));
}
