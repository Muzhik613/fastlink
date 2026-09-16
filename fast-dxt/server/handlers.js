import { writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Buffer } from 'buffer';
import { callExtension, getStatus, getBrokerLinkInfo, setSelectedInstall, getSelectedInstall } from './brokerClient.js';
import { HTTP_ENABLED, HTTP_PORT, TOKEN, SCOUT_ENABLED } from './config.js';
import { runBatch } from './batch.js';
import { pointByImage } from './scout.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

// --- Server-side capture-retry guard --------------------------------------
// captureVisibleTab copies the rendered surface out of the GPU compositor and
// INTERMITTENTLY throws "image readback failed" when that process wedges (page
// renders fine, only the bitmap copy fails). The extension already retries at the
// capture level (captureVisibleRetry), but the wedge can outlast those attempts,
// so a thin SERVER-side guard retries the whole callExtension a couple more times
// (spaced, since the failure is transient and a later frame often succeeds)
// before surfacing the error to the model. Only the screenshot/vision capture
// tools are guarded; everything else passes straight through.
const CAPTURE_TOOLS = new Set(['fast_screenshot', 'fast_vision_capture']);
// NON-IDEMPOTENT actions must NEVER be auto-retried — a re-fire double-writes
// (double-typed values, double clicks/submits). This matters specifically after
// BUG-4: a fill can succeed in the page while its ack is lost/slow and the call
// surfaces as a timeout — retrying that would silently write the value twice.
// callCapture today only runs for CAPTURE_TOOLS (read-only screenshot/vision, so
// safe to repeat), but guard explicitly so a future edit that adds a write tool
// to CAPTURE_TOOLS can't silently start double-writing. (BUG-4)
const NON_IDEMPOTENT = new Set([
  'fast_fill', 'fast_fill_vision', 'fast_type',
  'fast_click', 'fast_click_xy', 'fast_select_option',
  'fast_key_press', 'fast_nav', 'fast_reload',
]);
const READBACK_ERR_RE = /readback|compositor|captureVisibleTab/i;
async function callCapture(name, args, retries = 2) {
  let payload = await callExtension(name, args);
  // Never auto-retry a non-idempotent action, whatever the error.
  if (NON_IDEMPOTENT.has(name)) return payload;
  for (let i = 0; i < retries; i++) {
    const err = payload && typeof payload === 'object' ? payload.error : null;
    if (typeof err !== 'string' || !READBACK_ERR_RE.test(err)) break;
    await new Promise((r) => setTimeout(r, 800)); // let the wedged compositor recover
    payload = await callExtension(name, args);
  }
  return payload;
}

// --- Lightweight timing instrumentation (perf diagnosis) -------------------
// Append one JSONL row per tool call to /tmp/fastlink-timing.jsonl:
//   gapMs = time since the PREVIOUS call returned = Opus round-trip/think time
//   durMs = server+extension+Gemini time spent inside THIS call
// Summing gapMs vs durMs over a flow tells us whether round-trips (Opus) or the
// actions themselves dominate — i.e. whether collapsing round-trips will help.
const TIMING_LOG = join(tmpdir(), 'fastlink-timing.jsonl');
let lastReturnTs = null;
function logTiming(name, startTs, endTs) {
  try {
    const gapMs = lastReturnTs == null ? null : startTs - lastReturnTs;
    lastReturnTs = endTs;
    writeFileSync(
      TIMING_LOG,
      JSON.stringify({ t: endTs, name, gapMs, durMs: endTs - startTs }) + '\n',
      { flag: 'a' },
    );
  } catch {}
}

export async function handleCall(name, args) {
  const __start = Date.now();
  try {
    return await dispatchCall(name, args);
  } finally {
    logTiming(name, __start, Date.now());
  }
}

async function dispatchCall(name, args) {
  try {
    if (name === 'fast_profile') return text(await handleUseInstall(args));
    if (name === 'fast_status') return text(await statusReport());
    if (name === 'fast_batch')  return text(await runBatch(args, { call: callExtension, gate: batchGate }));
    if (name === 'fast_point')  return text(await handlePoint(args));
    if (name === 'fast_fill_vision') return text(await handleFillVision(args));
    const payload = CAPTURE_TOOLS.has(name)
      ? await callCapture(name, args || {})
      : await callExtension(name, args || {});
    // Tool-level errors come back as resolved payloads with `error` set, plus
    // any extras (diagnostics, available, etc.). Surface them as text so the
    // LLM sees everything, not just the message.
    if (payload && typeof payload === 'object' && 'error' in payload) return text(payload);
    let result = payload?.result ?? null;
    if (name === 'fast_screenshot' && result?.dataUrl) return text(saveScreenshot(result));
    return text(result);
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
}

// fast_profile: pin THIS session's calls to a slot label (BUG-5). "auto"/null →
// broker default (ACTIVE-then-any-connected).
async function handleUseInstall(args) {
  const broker = await getStatus().catch(e => ({ error: e.message }));
  const installs = broker?.installs || {};
  const known = Object.keys(installs);
  const raw = (args?.install ?? '').toString().trim().toLowerCase();

  if (raw === '' || raw === 'auto' || raw === 'default' || raw === 'none') {
    setSelectedInstall(null);
    return {
      selected: null,
      mode: 'auto',
      installs,
      hint: `AUTO — calls route to the active/any-connected slot. Known: ${known.join(', ') || '(none yet)'}.`,
    };
  }
  // Sanitize to the broker/extension slot key so the pin matches the `hello`.
  // Not-yet-connected labels are allowed (pin before opening the profile).
  const want = raw.replace(/[^a-z0-9_-]/g, '').replace(/^[-_]+/, '').slice(0, 32);
  if (!want) {
    return {
      error: `Invalid label "${raw}". Use [a-z0-9_-] (e.g. "work"), or "auto" to release.`,
      selected: getSelectedInstall(),
      installs,
    };
  }
  setSelectedInstall(want);
  const connected = !!installs[want]?.connected;
  return {
    selected: want,
    mode: 'pinned',
    connected,
    installs,
    hint: connected
      ? `Pinned to "${want}"; all calls route there. fast_profile "auto" releases.`
      : `Pinned to "${want}" but NOT connected — open FastLink in that profile with slot label "${want}". Calls error until it connects. Connected now: ${known.filter(k => installs[k]?.connected).join(', ') || '(none)'}.`,
  };
}

async function statusReport() {
  const broker = await getStatus().catch(e => ({ error: e.message }));
  const link = getBrokerLinkInfo();
  const justReconnected = link.lastDisconnectAgoMs != null && link.lastDisconnectAgoMs < 10_000;
  const selected = getSelectedInstall();

  const hints = [];
  if (broker?.connected) {
    hints.push('Extension connected. fast_snapshot/fast_click/fast_fill should work.');
    hints.push('If a DOM tool hangs or returns null on a specific tab, that tab likely loaded before the current extension version — reload it.');
  } else {
    hints.push('Extension NOT connected. Open chrome://extensions, find "FastLink", click its "service worker" link to see if it errored.');
  }
  // When >1 slot is connected, tell the LLM how to target a specific one.
  if (selected) {
    hints.push(`This session is PINNED to install "${selected}" (fast_profile). Calls route only there; "auto" releases the pin.`);
  } else if (broker?.pinRequired) {
    hints.push(`Multiple Chrome profiles connected (${broker.connectedInstalls.join(', ')}); calls are refused until this session pins one with fast_profile {install:"<label>"|"auto"}.`);
  }
  if (justReconnected) {
    hints.push(`Broker link reconnected ${Math.round(link.lastDisconnectAgoMs / 1000)}s ago — if the last call failed with "Connection closed", retry it once.`);
  }
  return {
    ...broker,
    selectedInstall: selected,
    brokerLink: link,
    httpEnabled: HTTP_ENABLED,
    httpPort: HTTP_ENABLED ? HTTP_PORT : null,
    httpAuthRequired: HTTP_ENABLED && !!TOKEN,
    hint: hints.join(' '),
  };
}

// VISION-POINT tier: locate on-screen targets that are NOT in the DOM (opaque/
// cross-origin iframes, canvas) by asking Gemini for native [y,x] points, then
// converting to CSS px for a trusted fast_click_xy. Small targets get one
// conditional crop-zoom refine pass (research: ZoomClick, +accuracy, ≤2 calls).
//
// args: { target | targets:[...], refine?:bool (default true) }
// returns: { points:[{ target, found, xCss, yCss, refined }] } — feed xCss/yCss
// straight into fast_click_xy (then fast_type to fill).
const REFINE_SIZE_FRAC = 0.05; // target narrower than 5% of width → crop-zoom
const REFINE_CONFIDENCE = 0.75; // coarse hit at/above this is trusted (skip refine)
const CLEAN_GAP_CSS = 44;       // nearest found neighbor must be ≥ this (px) for "clean spacing"

// Get a vision capture for the current tab. Always a FRESH capture: the
// navigation pre-warm that used to stash one was deleted with the scout tier.
// Returns the fast_vision_capture result ({dataUrl,imgW,imgH,dpr,...}) or {error}.
async function captureForVision() {
  const cap = await callExtension('fast_vision_capture', {});
  const full = cap?.result;
  if (cap?.error || !full?.dataUrl) return { error: cap?.error || 'vision capture failed' };
  return full;
}

// Capture once, point at all targets, return per-target {found,xCss,yCss,refined}.
// No scrolling — one viewport.
//
// opts.confidenceSkip (default false): SKIP-WHEN-CONFIDENT policy used by
// fast_fill_vision — only crop-zoom refine the genuinely ambiguous fields (small,
// low-confidence, or tight vertical spacing); trust a high-confidence, well-spaced
// coarse hit as-is. Default (false) keeps fast_point's original decision
// (forced || small || dense) untouched. In BOTH modes the needed refines now fire
// in PARALLEL — each refine depends only on coarse data, so order is irrelevant
// and N refines cost ~1 refine of wall-clock.
async function pointOnce(targets, refineMode, opts = {}) {
  const refine = refineMode !== false;
  const forced = refineMode === true || refineMode === 'always';
  const confidenceSkip = opts.confidenceSkip === true;
  // DOM-COORDS-WIN (default on): when an element IS in the DOM, its EXACT
  // snapshot-rect center beats vision regression. GCP proved this — a DOM-true
  // click landed dead-on while vision missed by ~50px on the same button. So we
  // resolve every target we can against the DOM first (one fast_snapshot + text
  // match) and only fall to Gemini vision for the leftovers (true non-DOM targets:
  // opaque/cross-origin iframes, canvas). Snapshot rects are outer-page CSS px —
  // the SAME space fast_click_xy wants — so NO dpr math (dpr only converts vision's
  // image-space points).
  const domHits = await domLocate(targets);
  const remaining = [];
  targets.forEach((t, k) => { if (!domHits[k]) remaining.push(t); });

  // Weave DOM hits (by original target order) around the vision results, which are
  // aligned to `remaining`.
  const assemble = (visionOut) => {
    const out = [];
    let vi = 0;
    for (let k = 0; k < targets.length; k++) {
      if (domHits[k]) out.push({ target: targets[k], found: true, xCss: domHits[k].xCss, yCss: domHits[k].yCss, refined: false, via: 'dom' });
      else out.push(visionOut[vi++] || { target: targets[k], found: false });
    }
    return { points: out };
  };

  // DOM resolved everything → skip the screenshot + Gemini call entirely.
  if (!remaining.length) return assemble([]);

  // ---- Vision tier: only the targets with no DOM match ----
  const full = await captureForVision();
  if (full.error) {
    // If DOM already resolved some targets, return those + found:false for the
    // vision leftovers rather than failing the whole call. Only surface the error
    // when NOTHING was resolved (preserves the old single-tier behavior).
    if (domHits.some(Boolean)) return assemble(remaining.map((t) => ({ target: t, found: false })));
    return { error: full.error };
  }
  // The vision call can THROW when the model provider is exhausted (e.g. Gemini
  // 503 after all retries + the OpenRouter fallback). Don't let that strand the
  // whole request: if the DOM already resolved some targets, keep them and mark
  // the vision leftovers found:false; if nothing was resolved, surface a clear
  // `visionUnavailable` error so callers (handleFillVision) can fall back to a
  // pure-DOM fill before giving up.
  let points;
  try {
    ({ points } = await pointByImage({ targets: remaining, base64: full.dataUrl }));
  } catch (e) {
    if (domHits.some(Boolean)) return assemble(remaining.map((t) => ({ target: t, found: false })));
    return { error: e.message, visionUnavailable: true };
  }
  const coarse = remaining.map((t, k) => {
    const p = points.find((q) => q.k === k) || points[k];
    if (!p || !p.found) return { found: false };
    return {
      found: true,
      xCss: (p.xNorm / 1000) * full.imgW / full.dpr,
      yCss: (p.yNorm / 1000) * full.imgH / full.dpr,
      sizeFrac: p.sizeFrac,
      confidence: p.confidence,
    };
  });
  const foundYs = coarse.filter((c) => c.found).map((c) => c.yCss).sort((a, b) => a - b);
  const dense = remaining.length >= 3;

  // Decide per target whether it needs a refine, and pre-compute the y-band the
  // refine result must land in (guards the crop-zoom from re-locking onto a
  // stacked neighbor). Build a job list; run them all concurrently below.
  const jobs = remaining.map((t, k) => {
    const c = coarse[k];
    if (!c.found) return null;
    const small = c.sizeFrac != null && c.sizeFrac < REFINE_SIZE_FRAC;
    const below = foundYs.filter((y) => y < c.yCss - 1).pop();
    const above = foundYs.filter((y) => y > c.yCss + 1).shift();
    const gap = Math.min(
      below != null ? c.yCss - below : Infinity,
      above != null ? above - c.yCss : Infinity,
    );
    let want;
    if (confidenceSkip) {
      const confident = c.confidence != null && c.confidence >= REFINE_CONFIDENCE;
      const cleanSpacing = gap >= CLEAN_GAP_CSS;
      // Skip refine only when we're confident AND well-separated AND not tiny.
      want = forced || small || !confident || !cleanSpacing;
    } else {
      want = forced || small || dense;
    }
    if (!(refine && want)) return null;
    return {
      k, target: t, xCss: c.xCss, yCss: c.yCss,
      loY: below != null ? (below + c.yCss) / 2 : 0,
      hiY: above != null ? (above + c.yCss) / 2 : Infinity,
    };
  });

  // Fire all needed refines in PARALLEL.
  const refinedByK = new Map();
  await Promise.all(jobs.map((j) => {
    if (!j) return null;
    return refinePoint(j.target, j.xCss, j.yCss, full)
      .then((r) => { if (r && r.yCss >= j.loY && r.yCss <= j.hiY) refinedByK.set(j.k, r); })
      .catch(() => {}); // a refine failure just falls back to the coarse point
  }));

  const visionOut = [];
  for (let k = 0; k < remaining.length; k++) {
    const c = coarse[k];
    if (!c.found) { visionOut.push({ target: remaining[k], found: false }); continue; }
    const r = refinedByK.get(k);
    const xCss = r ? r.xCss : c.xCss;
    const yCss = r ? r.yCss : c.yCss;
    visionOut.push({ target: remaining[k], found: true, xCss: Math.round(xCss), yCss: Math.round(yCss), refined: !!r, confidence: c.confidence, via: 'vision' });
  }
  return assemble(visionOut);
}

// Vision locate with AUTO-SCROLL. Because fast_point now NEVER hallucinates
// (off-screen targets return found:false), the caller can scroll the page and
// retry to bring missing targets into view — no human babysitting. We point on
// the current view, then if anything is still not-found, wheel-scroll down a
// viewport-ish and re-point, merging in newly-found targets. Bounded passes.
async function handlePoint(args) {
  if (!SCOUT_ENABLED) return { disabled: true, reason: 'set GEMINI_API_KEY to enable vision' };
  const targets = Array.isArray(args?.targets) ? args.targets : (args?.target ? [args.target] : []);
  if (!targets.length) return { error: 'fast_point needs target (string) or targets (array)' };
  // Auto-scroll is OPT-IN (scroll:true). Scrolling DISMISSES open dropdowns /
  // popovers (clicking outside them), so it must NOT fire by default — a menu
  // item that returns found:false should be retried by reopening the menu, not
  // by scrolling it away. Only pass scroll:true for long static forms where the
  // target is genuinely below the fold (e.g. fields under a scrolled panel).
  const scroll = args?.scroll === true;

  let result = await pointOnce(targets, args?.refine);
  if (result.error) return result;
  if (!scroll) return result;

  // Up to 4 downward scroll passes to surface targets below the fold.
  const MAX_PASSES = 4;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const missing = result.points.filter((p) => !p.found);
    if (!missing.length) break;
    // Wheel-scroll the page (trusted, works on GCP's nested scrollers).
    await callExtension('fast_wheel', { x: 900, y: 400, deltaY: 500 }).catch(() => {});
    const retry = await pointOnce(missing.map((m) => m.target), args?.refine);
    if (retry.error || !retry.points) continue;
    // Merge: fill in any now-found targets.
    for (const r of retry.points) {
      if (!r.found) continue;
      const slot = result.points.find((p) => p.target === r.target && !p.found);
      if (slot) { slot.found = true; slot.xCss = r.xCss; slot.yCss = r.yCss; slot.refined = r.refined; slot.scrolledTo = pass + 1; }
    }
  }
  return result;
}

// FILL-IN-ONE-CALL: fill an entire form server-side in a SINGLE MCP tool call,
// collapsing ~15 round-trips (per-field point → click → type) into one. Reuses
// pointOnce — the SAME "locate targets → CSS coords" helper handlePoint uses —
// so ALL fields (and the submit button) are located in ONE Gemini vision call,
// then each is focused (trusted fast_click_xy) and typed (trusted fast_type)
// sequentially server-side.
//
// DOM-FILL FALLBACK for the vision tier. When Gemini can't locate a field —
// because it's genuinely off-screen OR because the vision provider is down after
// retries — many forms are still reachable via the DOM: fast_fill {fields} walks open
// shadow roots AND same-origin iframes, so "iframe" fields that are actually
// same-origin widgets fill fine. This REUSES that existing DOM-fill internal (no
// reimplementation); the plain-language field descriptions double as
// label/placeholder/aria substrings, which match often enough to rescue the form.
// A field genuinely NOT in the DOM (cross-origin iframe like idmsa.apple.com,
// canvas) simply won't match and stays missed — correctly vision-only.
// Returns the Set of field keys it successfully filled.
async function domFillFallback(fieldsSubset) {
  const keys = Object.keys(fieldsSubset || {});
  if (!keys.length) return new Set();
  try {
    // fast_fill {fields} re-reads each field after filling (verified per field), so
    // a DOM-fallback success is genuinely confirmed. Only count a field done if it
    // filled AND held.
    const res = await callExtension('fast_fill', { fields: fieldsSubset, noSnapshot: true });
    const results = res?.result?.fields || {};
    const done = new Set();
    for (const k of keys) {
      const r = results[k];
      if (r && !r.error && !r.skipped && r.verified !== false) done.add(k);
    }
    return done;
  } catch {
    return new Set();
  }
}

// VERIFY READ-BACK for vision-typed fields. Synthetic CDP typing is not confirmed
// inline, so after filling we read the DOM back ONCE (a fresh fast_snapshot, whose
// item.text carries each input's current value) and mark a field verified if its
// typed value is now present on the page. Best-effort by design: same-origin DOM
// fields get CONFIRMED; a value typed into a CROSS-ORIGIN iframe can't be read
// back from the top document, so it stays verified:false ("typed, unverified") —
// the honest answer. Mutates the `filled` entries in place. Skips trivially short
// values (<2 chars) to avoid coincidental substring matches.
async function verifyVisionFills(filled) {
  const pending = filled.filter((f) => f.verified === false && typeof f.value === 'string' && f.value.trim().length >= 2);
  if (!pending.length) return;
  let items;
  try {
    const snap = await callExtension('fast_snapshot', { viewport: false });
    items = snap?.result?.items;
  } catch { return; }
  if (!Array.isArray(items)) return;
  const hay = items.map((it) => `${it.text || ''} ${it.label || ''} ${it.ariaLabel || ''} ${it.placeholder || ''} ${it.name || ''}`.toLowerCase());
  for (const f of pending) {
    const needle = String(f.value).trim().toLowerCase();
    if (hay.some((h) => h.includes(needle))) { f.verified = true; delete f.reason; }
  }
}

// args: { fields: { "<field description>": "<value>", ... }, submit?: "<button desc>" }
// returns: { filled:[{field,found,value,verified}], missed:[...], submitted, unverified?, note? }
async function handleFillVision(args) {
  if (!SCOUT_ENABLED) return { disabled: true, reason: 'set GEMINI_API_KEY to enable vision' };
  const fields = args?.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { error: 'fast_fill_vision needs a fields object: { "<field description>": "<value>", ... }' };
  }
  const fieldKeys = Object.keys(fields);
  if (!fieldKeys.length) return { error: 'fast_fill_vision: fields object is empty' };
  const submit = (typeof args?.submit === 'string' && args.submit.trim()) ? args.submit.trim() : null;

  // Locate every field AND the submit button (if requested) in ONE vision call.
  // confidenceSkip: refine only the ambiguous fields, and in parallel — so the
  // whole form is ~2-3 Gemini calls (capture+locate, then a parallel refine batch
  // ≈ 1 round-trip), not N.
  const targets = submit ? [...fieldKeys, submit] : fieldKeys;
  const located = await pointOnce(targets, args?.refine, { confidenceSkip: true });
  if (located.error) {
    // Vision provider unavailable (e.g. Gemini overloaded after retries + fallback).
    // Before surfacing the error, try a pure-DOM fill of every field — a Gemini
    // outage must never strand a form the DOM can reach.
    if (located.visionUnavailable) {
      const domDone = await domFillFallback(fields);
      if (domDone.size) {
        // DOM fallback is read-back verified (domFillFallback passes verify:true).
        const filled = [...domDone].map((k) => ({ field: k, found: true, value: String(fields[k] ?? ''), via: 'dom-fallback', verified: true }));
        const missed = fieldKeys.filter((k) => !domDone.has(k));
        let submitted = false;
        if (submit) {
          const c = await callExtension('fast_click', { text: submit }).catch(() => null);
          submitted = !!(c && !c.error && !c?.result?.error);
          if (!submitted) missed.push(submit);
        }
        return { filled, missed, submitted, note: 'vision unavailable (Gemini overloaded); filled via DOM fallback' };
      }
    }
    return located;
  }
  const points = located.points || [];

  const filled = [];
  const missed = [];
  const clear = args?.clear !== false; // clear existing value before typing (default on)
  // Fill fields sequentially: trusted click to focus, CLEAR, then trusted type.
  for (const key of fieldKeys) {
    const p = points.find((q) => q.target === key);
    if (!p || !p.found) { missed.push(key); continue; }
    const value = String(fields[key] ?? '');
    // Clear-before-type: GCP (and many forms) pre-fill a default (e.g. "API key
    // 4"); a plain focus+type APPENDS, producing "API key 4FastLink...". A
    // TRIPLE-click selects the field's whole contents so the subsequent type
    // REPLACES it. Triple-click is used (not Ctrl+A) because Ctrl+A triggers a
    // page-level select-all on iframe/React widgets.
    if (clear) {
      await callExtension('fast_click_xy', { x: p.xCss, y: p.yCss, clickCount: 3 });
    } else {
      await callExtension('fast_click_xy', { x: p.xCss, y: p.yCss });
    }
    // force:true — the field was just focused by the trusted vision-confirmed
    // click above; bypass fast_type's top-frame editable guard so values reach
    // inputs inside CROSS-ORIGIN iframes (e.g. appleid.apple.com) too, which is
    // the one fill path that works when those forms can't be reached any other way.
    const typed = await callExtension('fast_type', { text: value, force: true });
    // fast_type reads its OWN write back (actions/input.js): a same-origin field
    // comes back verified:true with the live value; a cross-origin iframe comes
    // back verified:false with the reason nothing in the page can confirm it.
    // ONE source of truth — this path does not re-decide it.
    const t = (typed && typed.result) || {};
    filled.push({
      field: key, found: true, value, verified: t.verified === true,
      ...(t.verified === true ? {} : { reason: t.reason || 'unreadable: typed but not read back' }),
    });
  }

  // DOM-FILL RESCUE: any field vision couldn't locate (below the fold, or low
  // confidence) may still be DOM-reachable — prefer DOM over giving up. Reuse
  // fast_fill {fields} on just the missed fields; move successes from missed→filled.
  // Genuinely non-DOM fields (cross-origin iframe, canvas) won't match and stay
  // missed. `missed` holds only field keys here (submit is added later).
  if (missed.length) {
    const subset = {};
    for (const k of missed) subset[k] = fields[k];
    const domDone = await domFillFallback(subset);
    if (domDone.size) {
      for (let i = missed.length - 1; i >= 0; i--) {
        if (domDone.has(missed[i])) missed.splice(i, 1);
      }
      for (const k of domDone) filled.push({ field: k, found: true, value: String(fields[k] ?? ''), via: 'dom-fallback', verified: true });
    }
  }

  // VERIFY the vision-typed fields by reading the DOM back — BEFORE submit, since
  // a submit can navigate and wipe the values. Confirms same-origin fills; leaves
  // unconfirmable cross-origin fills flagged verified:false.
  await verifyVisionFills(filled);

  // Submit LAST, after the fields are filled.
  let submitted = false;
  if (submit) {
    let sp = points.find((q) => q.target === submit);
    // If the button wasn't located in the combined pass (e.g. it shifted/scrolled
    // into view only after filling), re-point for it alone once before giving up.
    if (!sp || !sp.found) {
      // Fresh capture: fields were just filled, so the warm (pre-fill) capture
      // may be stale.
      const re = await pointOnce([submit], args?.refine, { confidenceSkip: true });
      sp = re.points && re.points[0];
    }
    if (sp && sp.found) {
      await callExtension('fast_click_xy', { x: sp.xCss, y: sp.yCss });
      submitted = true;
    } else {
      missed.push(submit);
    }
  }

  // Flag unverified synthetic typing so the agent knows to confirm — vision-typed
  // fields (esp. cross-origin iframes) were typed but not read back. DOM-fallback
  // fields are read-back verified (verified:true).
  const unverified = filled.filter((f) => f.verified === false).map((f) => f.field);
  const out = { filled, missed, submitted };
  if (unverified.length) {
    out.unverified = unverified;
    out.note = `typed (unverified): ${unverified.length} field(s) were typed but a DOM read-back could NOT confirm the value landed — most likely a cross-origin iframe (unreadable from the page) but possibly a mis-target. Verify visually if it matters.`;
  }
  return out;
}

// Match a target description against snapshot items[], returning the matched
// element's CENTER in CSS px ({xCss,yCss}) or null. Tries exact label match,
// then substring, then all-words-present. Only considers items with full coords.
function matchItem(items, target) {
  // Normalize for matching: lowercase, collapse whitespace, and strip a trailing
  // ":" / "：" (+ whitespace). A <label> is commonly rendered "Delivery
  // instructions:" while the caller's target is "Delivery instructions" (or vice
  // versa) — without trimming the trailing colon those never match exactly, and
  // a colon-terminated query fails the substring test against a colon-less field.
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[:：\s]+$/, '').trim();
  const q = norm(target);
  if (!q) return null;
  const hasCoords = (it) => ['x', 'y', 'w', 'h'].every((k) => typeof it[k] === 'number');
  const fields = (it) => norm([it.text, it.label, it.ariaLabel, it.placeholder, it.name, it.role, it.href]
    .filter(Boolean).join(' '));
  let best = items.find((it) => hasCoords(it) && fields(it) === q);
  if (!best) best = items.find((it) => hasCoords(it) && fields(it).includes(q));
  if (!best) {
    const words = q.split(/\s+/).filter(Boolean);
    // Include the tag in the per-word search so a control phrased with its type
    // ("delivery instructions textarea", "submit button") still resolves — every
    // word must be present, so the tag only confirms an already-strong match.
    if (words.length) best = items.find((it) => {
      const f = (fields(it) + ' ' + norm(it.tag));
      return hasCoords(it) && words.every((w) => f.includes(w));
    });
  }
  if (!best) return null;
  return { xCss: Math.round(best.x + best.w / 2), yCss: Math.round(best.y + best.h / 2) };
}

// {xCss,yCss} center for each confident DOM match, or null where the DOM can't
// see the element (vision handles those). A hung/wedged snapshot collapses to
// "no DOM matches" via a 3s race so it can never stall the vision fallback.
const DOM_LOCATE_TIMEOUT_MS = 3000;
async function domLocate(targets) {
  try {
    const snapP = callExtension('fast_snapshot', { viewport: false });
    const timeoutP = new Promise((resolve) => setTimeout(() => resolve(null), DOM_LOCATE_TIMEOUT_MS));
    const snap = await Promise.race([snapP, timeoutP]);
    const items = snap?.result?.items;
    if (!Array.isArray(items)) return targets.map(() => null);
    return targets.map((t) => matchItem(items, String(t)));
  } catch {
    return targets.map(() => null);
  }
}

// Crop a SHORT horizontal band (CSS px) centered on the coarse point and zoom in,
// then re-point. The band is wide (keeps the field's label for context) but only
// ~1.5 field-heights tall, so it contains the target field and NOT its vertical
// neighbors — that was the bug (a 32%-tall crop held 2-3 stacked fields, so the
// zoom re-locked onto the wrong row). Coords map back via the CSS crop region.
async function refinePoint(target, xCss, yCss, full) {
  try {
    const viewport = await callExtension('fast_evaluate', {
      fn: '() => ({ w: window.innerWidth, h: window.innerHeight })',
    });
    const vp = viewport?.result;
    if (!vp) return null;
    const cw = Math.round(vp.w * 0.40);  // wide: include the label beside/above
    const ch = Math.round(vp.h * 0.16);  // short: ~1.5 fields tall, not 3
    const crop = {
      x: Math.max(0, Math.min(Math.round(xCss - cw / 2), vp.w - cw)),
      y: Math.max(0, Math.min(Math.round(yCss - ch / 2), vp.h - ch)),
      w: cw, h: ch,
    };
    const cap = await callExtension('fast_vision_capture', { crop, zoom: 3 });
    const z = cap?.result;
    if (cap?.error || !z?.dataUrl) return null;
    const { points } = await pointByImage({ targets: [target], base64: z.dataUrl });
    const p = points[0];
    if (!p || !p.found) return null;
    // Normalized within the crop → CSS via the CSS crop region.
    return {
      xCss: crop.x + (p.xNorm / 1000) * crop.w,
      yCss: crop.y + (p.yNorm / 1000) * crop.h,
    };
  } catch {
    return null;
  }
}

// The batch runner itself (every step runs, ifFound branches, one snapshot,
// nav settle) lives in batch.js — shared with the relay mirror.
const DIAGNOSTIC_ONLY_STEPS = new Set(['fast_status', 'fast_profile', 'fast_batch', 'fast_point', 'fast_fill_vision']);
const batchGate = (step) => DIAGNOSTIC_ONLY_STEPS.has(step.name)
  ? { error: `"${step.name}" is a diagnostic-only tool (not allowed as a batch step)` }
  : null;

function saveScreenshot(result) {
  const ext = (result.format || 'png').toLowerCase();
  const path = join(tmpdir(), `fastlink-screenshot-${Date.now()}.${ext}`);
  const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const bytes = Buffer.from(base64, 'base64');
  writeFileSync(path, bytes);
  sweepOldScreenshots();
  return { path, format: ext, bytes: bytes.length };
}

// Delete fastlink-screenshot-* files older than 24h. Cheap readdir on
// /tmp; runs once at startup and again after each save.
const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SCREENSHOT_PREFIX = 'fastlink-screenshot-';
export function sweepOldScreenshots() {
  const dir = tmpdir();
  const cutoff = Date.now() - SCREENSHOT_MAX_AGE_MS;
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith(SCREENSHOT_PREFIX)) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) unlinkSync(full);
    } catch {}
  }
}
