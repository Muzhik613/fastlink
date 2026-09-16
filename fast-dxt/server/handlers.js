import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Buffer } from 'buffer';
import { callExtension, getStatus, getBrokerLinkInfo, setSelectedInstall, getSelectedInstall } from './brokerClient.js';
import { runBatch } from './batch.js';

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
const CAPTURE_TOOLS = new Set(['fast_screenshot']);
// NON-IDEMPOTENT actions must NEVER be auto-retried — a re-fire double-writes
// (double-typed values, double clicks/submits). This matters specifically after
// BUG-4: a fill can succeed in the page while its ack is lost/slow and the call
// surfaces as a timeout — retrying that would silently write the value twice.
// callCapture today only runs for CAPTURE_TOOLS (read-only screenshot/vision, so
// safe to repeat), but guard explicitly so a future edit that adds a write tool
// to CAPTURE_TOOLS can't silently start double-writing. (BUG-4)
const NON_IDEMPOTENT = new Set([
  'fast_fill', 'fast_type',
  'fast_click', 'fast_click_xy', 'fast_select_option',
  'fast_key_press', 'fast_nav',
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
//   durMs = server+extension time spent inside THIS call
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
    const payload = CAPTURE_TOOLS.has(name)
      ? await callCapture(name, args || {})
      : await callExtension(name, args || {});
    // Tool-level errors come back as resolved payloads with `error` set, plus
    // any extras (diagnostics, available, etc.). Surface them as text so the
    // LLM sees everything, not just the message.
    if (payload && typeof payload === 'object' && 'error' in payload) { const { origin, ...err } = payload; return text(err); }   // origin is the relay's consent key, not the model's
    let result = payload?.result ?? null;
    if (name === 'fast_screenshot' && result?.dataUrl) return screenshotContent(result);
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
    hint: hints.join(' '),
  };
}

// The batch runner itself (every step runs, ifFound branches, one snapshot,
// nav settle) lives in batch.js — shared with the relay mirror.
const DIAGNOSTIC_ONLY_STEPS = new Set(['fast_status', 'fast_profile', 'fast_batch']);
const batchGate = (step) => DIAGNOSTIC_ONLY_STEPS.has(step.name)
  ? { error: `"${step.name}" is a diagnostic-only tool (not allowed as a batch step)` }
  : null;

// The screenshot IS the result: an MCP image item the caller's model sees directly (the relay
// already answers this way), plus one text item with the coordinate contract. A temp-file path
// was useless to any caller that can't read this machine's disk — Grok on the local transport
// never saw a single screenshot through it (live Azure run f654d4a4, 2026-09-16).
// cssWidth/cssHeight/dpr/scale:1 — the image's pixels are fast_click_xy's CSS pixels.
function screenshotContent(result) {
  const m = /^data:(image\/\w+);base64,/.exec(result.dataUrl);
  const mimeType = m ? m[1] : `image/${(result.format || 'png').toLowerCase()}`;
  const data = result.dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const { cssWidth, cssHeight, dpr, scale } = result;
  const meta = { format: mimeType.slice(6), bytes: Buffer.byteLength(data, 'base64'), ...(cssWidth ? { cssWidth, cssHeight, dpr, scale } : {}) };
  return { content: [{ type: 'image', data, mimeType }, { type: 'text', text: JSON.stringify(meta) }] };
}
