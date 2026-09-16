// Vision brain — the model calls behind fast_point / fast_fill_vision, plus the
// screenshot-observation prompt the bench's visual note uses. Transient Gemini
// failures (503 UNAVAILABLE / 429) are retried with backoff and can fall back to
// OpenRouter, then to Claude — see callModelParts / callGemini / callOpenRouter.
//
// The DOM scout/planner that used to live here (page maps, intent overlay,
// fast_do, Set-of-Mark) was deleted on 2026-09-16: 14 live fast_scout calls
// produced zero executed plans.
import { request as httpsRequest } from 'https';
import {
  SCOUT_ENABLED, GEMINI_API_KEY, GEMINI_MODEL,
  OPENROUTER_API_KEY, OPENROUTER_BASE_URL, OPENROUTER_MODEL, VISION_FALLBACK_ENABLED,
  OPENROUTER_CLAUDE_MODEL, VISION_FALLBACK2_ENABLED,
} from './config.js';
import { log } from './log.js';

// POST JSON via Node's built-in https module instead of the global fetch.
// The MCP server can run inside Claude Desktop as an Electron UtilityProcess,
// where the global fetch is bound to a network session that isn't initialized
// for utility processes and throws a bare "fetch failed". Node's https module
// uses core networking and behaves identically under plain Node and Electron.
// Resolves with the parsed JSON body; rejects on non-2xx with a trimmed body.
// Rejected errors carry a numeric `.status` so the retry layer can decide what's
// retryable: HTTP status for a server response, 0 for network errors/timeouts
// (always retryable), -1 for a 2xx body that wasn't valid JSON (not retryable).
// `label` names the provider in the error string (e.g. "gemini", "openrouter").
function httpsPostJson(url, headers, bodyObj, label = 'gemini') {
  const payload = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        port: u.port || 443,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            const err = new Error(`scout ${label} ${status}: ${data.slice(0, 300)}`);
            err.status = status;
            reject(err);
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch (e) {
            const err = new Error(`scout ${label} bad JSON: ${e.message}`);
            err.status = -1;
            reject(err);
          }
        });
      },
    );
    req.on('error', (e) => { if (e.status === undefined) e.status = 0; reject(e); });
    // Bound the request — a slow/stuck call must never hang the tool call.
    req.setTimeout(GEMINI_TIMEOUT_MS, () => req.destroy(new Error(`scout ${label} timed out (${GEMINI_TIMEOUT_MS}ms)`)));
    req.write(payload);
    req.end();
  });
}

// ── Retry / backoff tuning (transient Gemini failures) ──
// Gemini 503 UNAVAILABLE ("high demand") and 429 RESOURCE_EXHAUSTED are
// transient; so are network errors and timeouts. Retry those with exponential
// backoff + jitter; never retry non-retryable 4xx (400/401/403/404) or a bad
// JSON body. Bounded so total added latency stays modest (~0.4s+0.8s+1.6s ≈ 2.8s
// of backoff across 4 attempts, plus per-attempt request time).
const RETRY_ATTEMPTS = 4;        // total tries (1 initial + 3 retries)
const RETRY_BASE_MS = 400;       // backoff before the 1st retry
const RETRY_MAX_MS = 3_000;      // cap on any single backoff
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  const s = err && err.status;
  if (s === 0) return true;              // network error / timeout
  return RETRYABLE_STATUS.has(s);        // transient server statuses only
}

// Run `fn` (a single provider call) with retry+backoff on transient failures.
// Throws the last error once attempts are exhausted or the error is terminal.
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === RETRY_ATTEMPTS) break;
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      const wait = backoff / 2 + Math.random() * (backoff / 2); // jitter
      log(`scout ${label} attempt ${attempt}/${RETRY_ATTEMPTS} failed (${e.status ?? 'err'}); retrying in ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Hard ceiling on a single Gemini call. The fetch has no native timeout, so a
// slow/stuck request would otherwise hang the whole vision tool call until the
// caller's broker/relay 30s limit fires. Bound it so the call always returns.
const GEMINI_TIMEOUT_MS = 12_000;

// Core model call for every scout/vision tier. `parts` is the raw user-content
// parts array, so callers can mix text + inlineData (image) parts. `system` is
// optional (multimodal locate doesn't need a separate system instruction).
//
// Resilience — THREE provider tiers, tried in order, each retried with backoff on
// transient failures (503/429/network/timeout):
//   Tier 1: direct Gemini (Generative Language API).
//   Tier 2: OpenRouter google/gemini-2.5-pro — gated on FASTLINK_VISION_FALLBACK.
//   Tier 3: a NON-Gemini model (Claude via OpenRouter) — gated on
//           FASTLINK_VISION_FALLBACK2. This is provider DIVERSITY: tiers 1+2 are
//           the same Gemini family, so a Google-wide outage takes out both; a
//           Claude tier survives it.
// We only descend to the next tier on a TRANSIENT failure (isRetryable). A
// non-retryable 4xx (e.g. a bad key) stops immediately — the next tier would fail
// the same way, and we don't want to mask a config error. After all configured
// tiers are exhausted we surface one error explaining the cause, the retry count,
// and which tiers were tried — never a raw 503.
async function callModelParts({ system, parts, maxTokens }) {
  const errs = [];
  // Tier 1 — direct Gemini.
  try {
    return safeJson(await withRetry(() => callGemini({ system, parts, maxTokens }), 'gemini'));
  } catch (e) {
    errs.push(e);
    if (!isRetryable(e)) throw new Error(exhaustedMessage(errs));
  }
  // Tier 2 — OpenRouter Gemini (same family).
  if (VISION_FALLBACK_ENABLED) {
    try {
      log(`scout: gemini exhausted after ${RETRY_ATTEMPTS} attempts; falling back to OpenRouter ${OPENROUTER_MODEL} (tier 2)`);
      return safeJson(await withRetry(() => callOpenRouterModel(OPENROUTER_MODEL, { system, parts, maxTokens }), 'openrouter'));
    } catch (e) {
      errs.push(e);
      if (!isRetryable(e)) throw new Error(exhaustedMessage(errs));
    }
  }
  // Tier 3 — Claude via OpenRouter (provider diversity; survives a full Gemini outage).
  if (VISION_FALLBACK2_ENABLED) {
    try {
      log(`scout: gemini tiers exhausted; falling back to Claude ${OPENROUTER_CLAUDE_MODEL} (tier 3)`);
      return safeJson(await withRetry(() => callOpenRouterModel(OPENROUTER_CLAUDE_MODEL, { system, parts, maxTokens }, 'claude'), 'claude'));
    } catch (e) {
      errs.push(e);
    }
  }
  throw new Error(exhaustedMessage(errs));
}

// Build the user-facing error after all tiers/retries are exhausted, naming the
// likely cause, the attempt count, and which provider tiers were tried — instead
// of echoing a raw 503 body. `errs[0]` is the primary (Gemini) failure.
function exhaustedMessage(errs) {
  const primary = errs[0] || {};
  const s = primary.status;
  const tiers = ['Gemini direct'];
  if (VISION_FALLBACK_ENABLED) tiers.push(`OpenRouter ${OPENROUTER_MODEL}`);
  if (VISION_FALLBACK2_ENABLED) tiers.push(`Claude ${OPENROUTER_CLAUDE_MODEL}`);
  const tierNote = tiers.length > 1 ? ` Tried ${tiers.length} provider tiers (${tiers.join(' → ')}); all failed.` : '';
  const hint = (!VISION_FALLBACK_ENABLED && !VISION_FALLBACK2_ENABLED)
    ? ' Set OPENROUTER_API_KEY to enable the OpenRouter + Claude fallback tiers.'
    : '';
  let head;
  if (s === 503) head = `scout vision failed: Gemini is overloaded (503 UNAVAILABLE, "high demand") — retried ${RETRY_ATTEMPTS}× with backoff and it stayed unavailable.`;
  else if (s === 429) head = `scout vision failed: Gemini rate-limited (429 RESOURCE_EXHAUSTED) — retried ${RETRY_ATTEMPTS}× with backoff.`;
  else if (s === 0) head = `scout vision failed: network error/timeout reaching Gemini — retried ${RETRY_ATTEMPTS}×.`;
  else head = `scout vision failed after ${RETRY_ATTEMPTS} attempt(s): ${primary.message || 'unknown error'}`;
  // If a fallback tier failed with a different error, surface it too.
  const last = errs[errs.length - 1];
  const fbNote = (errs.length > 1 && last && last !== primary) ? ` Last fallback error: ${last.message}.` : '';
  return head + tierNote + fbNote + hint;
}

// Primary provider: direct Generative Language API. AQ.-format keys authenticate
// via the x-goog-api-key header; responseMimeType pins JSON output. Resolves to
// the raw model text (JSON string); the caller parses via safeJson.
function callGemini({ system, parts, maxTokens }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 }, // disable 2.5-flash "thinking" for speed
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return httpsPostJson(
    url,
    { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body,
    'gemini',
  ).then((data) => (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('') || '{}');
}

// Fallback provider: OpenRouter's OpenAI-compatible /chat/completions. Maps the
// Gemini `parts` shape to OpenAI message content: {text} → {type:"text"},
// {inlineData:{mimeType,data}} → {type:"image_url", image_url:{url:data-URI}}.
// `system` becomes a system message; response_format pins JSON output. `model` is
// the OpenRouter slug — a Gemini slug for tier 2, a Claude slug for tier 3; both
// share this exact request/response shape. Resolves to the raw model text (JSON
// string), same contract as callGemini. The 'claude'/'openrouter' error label is
// applied by httpsPostJson via the caller's withRetry label.
function callOpenRouterModel(model, { system, parts, maxTokens }, label = 'openrouter') {
  const url = `${OPENROUTER_BASE_URL}/chat/completions`;
  const content = (parts || []).map((p) => {
    if (p && typeof p.text === 'string') return { type: 'text', text: p.text };
    if (p && p.inlineData) {
      return { type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } };
    }
    return null;
  }).filter(Boolean);
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });
  const body = {
    model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  };
  return httpsPostJson(
    url,
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      // Optional OpenRouter attribution headers (harmless if ignored).
      'HTTP-Referer': 'https://github.com/fastlink',
      'X-Title': 'FastLink scout',
    },
    body,
    label,
  ).then((data) => (data?.choices?.[0]?.message?.content) || '{}');
}

export async function pointByImage({ targets, base64 }) {
  if (!SCOUT_ENABLED) return { points: [], reason: 'scout disabled (set GEMINI_API_KEY)' };
  if (!base64 || typeof base64 !== 'string') return { points: [], reason: 'no image' };
  const list = Array.isArray(targets) ? targets : [targets];
  const img = base64.replace(/^data:image\/\w+;base64,/, '');
  // Instruction text BEFORE the image (Anthropic finding: improves grounding).
  // CRITICAL anti-hallucination contract: if a target is NOT clearly visible in
  // THIS screenshot (off-screen / below the fold / not present), the model MUST
  // return found:false with point:null — it must NEVER invent a coordinate. A
  // fabricated point forces the caller to screenshot-verify every result, which
  // is slow; an honest found:false lets the caller scroll and retry. We also ask
  // for a 0-1 confidence so the caller can reject low-confidence guesses.
  const prompt = [
    'Locate each requested target in this browser screenshot. For each, return',
    'the point at the CENTER of the element you would click (for an input field,',
    'the middle of its empty box), as NORMALIZED integers 0-1000 in [y, x] order',
    '(y first), where [0,0] is top-left and [1000,1000] is bottom-right.',
    'STRICT RULE: only return a point if you can ACTUALLY SEE that exact element',
    'in the image right now. If it is off-screen, below the visible area, or not',
    'present, you MUST return {"found":false,"point":null} for it — do NOT guess,',
    'do NOT approximate a location, do NOT return a point for something you cannot',
    'see. A wrong guess is far worse than found:false.',
    'Also return "confidence" (0-1, how sure you are this is the right visible',
    'element) and "sizeFrac" (target width as fraction of image width).',
    'Targets, in order: ' + list.map((t, k) => `(${k}) ${t}`).join('; ') + '.',
    'Reply strict JSON: {"points":[{"k":int,"found":bool,"point":[y,x]|null,"confidence":number,"sizeFrac":number}]}.',
  ].join(' ');
  const out = await callModelParts({
    parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: img } }],
    maxTokens: 500,
  });
  const raw = Array.isArray(out && out.points) ? out.points : [];
  const points = raw.map((p) => {
    const pt = Array.isArray(p && p.point) ? p.point : null;
    // Native order is [y, x]; guard against a model that emits [x, y] by trusting
    // the documented order but exposing both so the caller can sanity-check.
    const y = pt ? Number(pt[0]) : null;
    const x = pt ? Number(pt[1]) : null;
    const conf = typeof p.confidence === 'number' ? p.confidence : 1;
    // Reject explicit not-found, missing coords, AND low-confidence guesses —
    // treat a shaky answer as not-found so the caller scrolls instead of
    // clicking a hallucinated point.
    const found = p.found !== false && x != null && y != null && conf >= 0.4;
    return {
      k: typeof p.k === 'number' ? p.k : null,
      found,
      xNorm: x, yNorm: y,
      confidence: conf,
      sizeFrac: typeof p.sizeFrac === 'number' ? p.sizeFrac : null,
    };
  });
  return { points };
}

// FAST_DO planner — the most aggressive tier. Given a screenshot + ONE plain-
// language intent, Gemini both DECOMPOSES the intent into concrete per-field
// steps AND describes each target so it can be located by pointByImage. This is
// the key difference from fast_fill_vision: there, Opus supplies the field→value
// map; here, Gemini infers the whole plan from the intent + what it sees.
//
// Returns { steps:[{action:"click"|"type"|"key", target, value?}], note? }.
// Each `target` is a plain-language element description (fed to pointByImage).
// For action "type", value is the text; for "key", value is the key name
// (Enter/Tab/...) and target may be empty. SAFETY: the planner is told NOT to
// emit a final submit/create/delete/confirm step unless the intent explicitly
// asks for it — it stops with the form filled.
// PLAIN-OBSERVATION tier — the end-of-run visual note (fast-runner). It is NOT a
// judge and NOT a planner: it is shown one screenshot and asked to say what is on
// the screen, in the same flat register a bystander would use ("this box looks
// empty", "there is a red dot next to Basics", "the form continues below the
// visible area"). It must not name widget kinds, diagnose a cause, prescribe a
// tool or deliver a verdict — the model driving the browser does that. `values`
// are strings the agent says it entered; the note reports what the boxes holding
// them actually read, when it can see them.
// Returns { observations:[string], skipped? } — never throws for the caller.
// `deps.call` replaces the model call, so the prompt/parse path unit-tests with a
// synthetic answer and no network.
export async function describeScreen({ base64, values, intent } = {}, deps = {}) {
  if (!SCOUT_ENABLED) return { observations: [], skipped: 'no vision' };
  if (!base64 || typeof base64 !== 'string') return { observations: [], skipped: 'no image' };
  const img = base64.replace(/^data:image\/\w+;base64,/, '');
  const prompt = observationPrompt({ values, intent });
  try {
    const out = await (deps.call || callModelParts)({
      parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: img } }],
      maxTokens: 600,
    });
    return { observations: plainObservations(out && out.observations) };
  } catch (e) {
    return { observations: [], skipped: `vision failed: ${String(e && e.message || e).slice(0, 200)}` };
  }
}

// The ONE observation prompt, whichever model is shown the screenshot (the runner's
// checker is a fresh Grok conversation; this Gemini path stays behind that switch).
// `intent` is the task text the run was given — what the screen is being read in
// light of, so "two of the boxes the task names read empty" is possible instead of
// "some boxes look empty". Everything else about the run is withheld: no plan, no
// history, no claimed results, and no tool vocabulary — any fast_* token in the
// task text is stripped, so the checker can never learn a tool name from us.
export function observationPrompt({ values, intent } = {}) {
  const wanted = (Array.isArray(values) ? values : []).map((v) => String(v)).filter(Boolean).slice(0, 8);
  const goal = String(intent == null ? '' : intent).replace(/\bfast_[a-z_]+\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  return [
    goal ? `Someone was asked to accomplish this on a web page: ${JSON.stringify(goal)}. That is the only thing you know about them — you cannot see what they did, how they did it or what they say happened.` : '',
    'Describe what this browser screenshot SHOWS. Report only what is visibly on the screen.',
    goal ? 'Read the screen in light of that goal: the boxes it names are the ones worth naming first.' : '',
    'Cover, when visible: (a) EVERY box that looks empty or still shows greyed placeholder text',
    '(a blank box, a greyed "Select..."/"Choose..." word sitting in it), naming the label printed',
    'beside it — include the ones marked as required (an asterisk, the word "required"), and list',
    'them even if they seem unrelated to each other; (b) any red/orange marks, dots, outlines,',
    'warning icons, a message under a box or a banner across the top, and what each sits next to —',
    'including a mark on a tab or step name at the top of the page; (c) whether the content continues',
    'below the visible area (a scrollbar, a cut-off section, a partially visible row).',
    wanted.length ? `(d) for each of these values, say what the box that should hold it reads right now, or that you cannot see it: ${wanted.map((v) => JSON.stringify(v)).join(', ')} — report these FIRST, before (a), (b) and (c).` : '',
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

// The note is handed straight to the model driving the browser, so it stays short
// and stays in the observation register. MAX_OBSERVATIONS is both what the prompt
// asks for and what the parse enforces.
const MAX_OBSERVATIONS = 8;
// MECHANICAL register filter — NOT judgement. A line where the vision tier slipped
// out of plain observation (named one of our tools, gave an instruction, pronounced
// a verdict) is DROPPED rather than reworded. Nothing here interprets what the
// screen means, and nothing is ever added: it can only remove.
const OFF_REGISTER = [
  /fast_[a-z_]+/i,                                                                                  // names one of our tools
  /^(click|select|choose|enter|fill|type|press|scroll|navigate|go to|you should|you need|you must)\b/i, // an instruction
  /\b(should be|must be|needs to be|is incomplete|is invalid|is wrong|has failed|failed to)\b/i,    // a verdict
];
export function plainObservations(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim())
    .filter((s) => s && !OFF_REGISTER.some((re) => re.test(s)))
    .slice(0, MAX_OBSERVATIONS);
}

export function safeJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/); // models sometimes wrap JSON in prose/fences
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  log(`scout: failed to parse model JSON`);
  return {};
}
