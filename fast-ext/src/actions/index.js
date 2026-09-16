import { handleTabAction, getTargetTab, getTargetTabId } from './tab.js';
import { takeScreenshot }  from './screenshot.js';
import { getText }         from './text.js';
import { evaluate }        from './evaluate.js';
import { clickXY, typeText } from './input.js';
import { waitForNetworkIdle, pendingNow } from './waitIdle.js';
import { isInjectableUrl } from '../util.js';

const TAB_ACTIONS  = new Set(['fast_tab', 'fast_nav', 'fast_list', 'fast_close', 'fast_switch']);
const PAGE_ACTIONS = new Set([
  'fast_snapshot', 'fast_click', 'fast_fill', 'fast_wait',
  'fast_select_option', 'fast_scroll',
  'fast_key_press',
]);

// Actions that can SUBMIT a form / follow a link / otherwise trigger a top-level
// navigation. When executeScript's ack is lost because the navigation tore down
// the MAIN-world frame before the click handler returned, the navigation ITSELF
// is the evidence the action fired — so for these we treat a frame-removal error
// as SUCCESS (navigated) instead of failing the step (BUG-2 sub-bug). READ
// actions (fast_snapshot, fast_evaluate, …) are deliberately excluded: a frame
// loss there is a real failure and must keep erroring. (Of these,
// fast_click / fast_select_option / fast_key_press flow through runBridge;
// fast_click_xy uses the CDP input path and never hits this code — listed
// here for completeness / future-proofing.)
const NAVIGATING_ACTIONS = new Set([
  'fast_click', 'fast_click_xy', 'fast_key_press', 'fast_select_option',
]);

// executeScript rejection messages that mean the MAIN-world FRAME was torn down
// (a navigation removed it) — as opposed to the TAB being gone/closed/restricted
// (TAB_GONE_RE). Matched case-insensitively against the RAW chrome error string.
const FRAME_REMOVED_RE = /frame with id \d+ was removed|frame was removed|no frame with id|frame.*detached/i;
const TAB_GONE_RE = /no tab with id|cannot access|chrome:\/\/|the tab was closed|tab was discarded/i;

let __evtSeq = 0;

// ---------------------------------------------------------------------------
// User "Stop" pause gate (SAFETY N2 kill-switch). The popup's Stop button sets
// chrome.storage.session['fastlink.drivingPaused']; while true, EVERY action is
// refused at this last line before the browser acts (covers BOTH transports —
// local broker + relay — and is instant). Cached in a module var and kept fresh
// via storage.onChanged so the hot path never awaits a storage read.
// ---------------------------------------------------------------------------
const PAUSE_KEY = 'fastlink.drivingPaused';
let drivingPaused = false;
try {
  chrome.storage.session.get(PAUSE_KEY).then((o) => { drivingPaused = !!o?.[PAUSE_KEY]; }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[PAUSE_KEY]) drivingPaused = !!changes[PAUSE_KEY].newValue;
  });
} catch {}
// Fire-and-forget overlay notification. Never blocks the action path: it routes
// through getTargetTabId() (the single source of truth) without await and
// swallows errors (overlay missing on chrome:// pages, etc.). The overlay must
// render on the tab Claude is DRIVING, not whatever tab the user is looking at
// — so it uses the same target resolution as the actions themselves.
function notifyOverlay(payload) {
  getTargetTabId().then((id) => {
    if (id == null) return;
    try { chrome.tabs.sendMessage(id, { fastlink: 'event', ...payload }, () => void chrome.runtime.lastError); } catch {}
  }).catch(() => {});
}

export async function dispatchAction(action, args) {
  // Hard stop: the user paused driving from the popup. Refuse every action with
  // a clear, Claude-relayable message until they resume. Checked before the
  // action runs so nothing touches the page while paused.
  if (drivingPaused) {
    return await withOrigin({ error: 'Paused by the user — driving is stopped. Resume it from the FastLink popup to continue.' });
  }
  const evtId = ++__evtSeq;
  notifyOverlay({ phase: 'start', id: evtId, action, args });
  try {
    const r = await runOne(action, args);
    // Pass error payloads through whole — diagnostics/available/etc. must survive to the LLM.
    if (r && typeof r === 'object' && 'error' in r && r.error !== undefined) {
      notifyOverlay({ phase: 'end', id: evtId, ok: false, error: r.error });
      return await withOrigin(r);
    }
    let result = r;
    if (args?.screenshot && typeof result === 'object' && result !== null) {
      try {
        // Companion screenshot rides the action's result, so it must show the tab
        // the action DROVE (the pinned/driven tab — backgrounded in relay mode),
        // not the user's foreground tab. preferTarget keeps that pin-aware capture;
        // only the standalone fast_screenshot tool defaults to the foreground tab.
        const shot = await takeScreenshot({ format: args.screenshotFormat, preferTarget: true });
        if (shot?.dataUrl) result.screenshot = shot;
      } catch (e) {
        result.screenshotError = e?.message || String(e);
      }
    }
    notifyOverlay({ phase: 'end', id: evtId, ok: true });
    return await withOrigin({ result });
  } catch (e) {
    const msg = e?.message || String(e);
    notifyOverlay({ phase: 'end', id: evtId, ok: false, error: msg });
    return await withOrigin({ error: msg });
  }
}

// Stamp the authoritative active-tab origin onto every action-result envelope
// (SIGNUP-SPEC §5.2). The relay caches this as `lastOrigin` and the per-origin
// consent gate + audit log consult it; it also closes the eval-TOCTOU gap (the
// origin is captured from the SAME target resolution the action ran against).
// Best-effort: never let origin resolution fail an action — omit it on error.
async function withOrigin(envelope) {
  try {
    const tab = await getTargetTab();
    if (tab?.url && /^https?:/.test(tab.url)) envelope.origin = new URL(tab.url).origin;
  } catch {}
  return envelope;
}

async function runOne(action, args) {
  if (TAB_ACTIONS.has(action))      return handleTabAction(action, args);
  if (action === 'fast_screenshot') return takeScreenshot(args);
  if (action === 'fast_text')       return getText(args);
  if (action === 'fast_evaluate')   return evaluate(args);
  if (action === 'fast_click_xy')   return clickXY(args);
  if (action === 'fast_type')       return typeText(args);
  if (action === 'fast_wait' && (args?.networkIdle || args?.domready)) {
    // text/selector + networkIdle: the text is the real signal (SPAs long-poll,
    // so pure idle can time out forever); resolve on it and REPORT the network
    // state instead of waiting for it. A bare networkIdle wait still times out.
    if (args.text || args.selector) {
      const r = await injectPageAction('fast_wait', { ...args, timeoutMs: args.timeoutMs || 10000 });
      if (r && typeof r === 'object' && !r.error) { const pending = await pendingNow(); return { ...r, networkIdle: pending === 0, pending }; }
      return r;
    }
    return waitForNetworkIdle(args);
  }
  if (PAGE_ACTIONS.has(action))     return injectPageAction(action, args);
  return { error: `Unknown action: ${action}` };
}

// Tiny bridge: page.js is pre-injected as a MAIN-world content script and
// self-attaches window.__fastlink.run. This 1-line ship replaces the old
// ~640-line runPageAction serialization on every call. When page.js isn't
// attached it returns a SENTINEL ({__fastlinkMissing}) rather than a human
// error string, so injectPageAction can distinguish "script gone" (→ reinject
// + retry) from a real page-action error and self-heal silently.
// The result crosses executeScript as a JSON STRING, not an object: Chrome
// marshals returned objects through base::Value dicts, which SORT keys
// alphabetically — the leading `verified` / `truncated` / `url` fields the model
// must read first would land after `snapshot`. A string keeps the page's order.
// Args cross as a JSON string for the same reason: `fields:{…}` must be filled
// (and reported) in the caller's order, not alphabetically.
function pageBridge(action, argsJson) {
  if (!window.__fastlink || !window.__fastlink.run) {
    return { __fastlinkMissing: true };
  }
  let args = {}; try { args = JSON.parse(argsJson) || {}; } catch {}
  return Promise.resolve(window.__fastlink.run(action, args)).then((r) => (r === undefined ? null : JSON.stringify(r)));
}

// Fallback re-injection list for when the pre-injected page.js went stale or
// missing (the extension was reloaded after the tab opened). ONLY page.js —
// it is the one file DOM tools need (window.__fastlink).
const MAIN_WORLD_FILES = ['src/actions/page.js'];

// Run the page bridge in the target tab's MAIN world. Returns the bridge's
// value, OR a {__injectError} sentinel when executeScript itself throws (tab
// closed / navigated to a restricted URL mid-flight).
// Wall-clock deadline on the in-page script: a stuck page action must not
// outlive the broker/relay's 30s call timeout, or the NEXT call queues behind
// it. A deadline, not a retry — the caller gets a structured "page busy".
const BRIDGE_DEADLINE_MS = 20000;
const BRIDGE_DEADLINE_MAX_MS = 28000;   // under the broker/relay 30s call limit
async function runBridge(tabId, action, args) {
  const t0 = Date.now();
  // fast_wait legitimately runs to its own timeoutMs; give it that plus slack.
  const deadlineMs = action === 'fast_wait'
    ? Math.min(BRIDGE_DEADLINE_MAX_MS, Math.max(BRIDGE_DEADLINE_MS, (Number(args?.timeoutMs) || 5000) + 3000))
    : BRIDGE_DEADLINE_MS;
  try {
    const exec = chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: pageBridge, args: [action, JSON.stringify(args || {})],
    });
    const raced = await Promise.race([exec, new Promise((r) => setTimeout(() => r({ __deadline: true }), deadlineMs))]);
    if (raced && raced.__deadline) {
      exec.catch(() => {});
      return { error: 'page busy', phase: action, elapsedMs: Date.now() - t0, hint: `${action} did not return within ${Math.round(deadlineMs / 1000)}s — the page is re-rendering or frozen; fast_wait for text of the settled view, then retry` };
    }
    const [{ result }] = raced;
    return typeof result === 'string' ? JSON.parse(result) : result;
  } catch (e) {
    // Keep the raw chrome message ALONGSIDE the human-readable wrapper so the
    // caller can classify the failure (frame-teardown-on-navigation vs the tab
    // genuinely being gone) without re-matching against our own wrapper text.
    const raw = e?.message || String(e);
    return { __injectError: `${action}: could not inject into target tab ${tabId} (${raw}). The tab may have been closed or navigated to a restricted URL.`, __injectRaw: raw };
  }
}

// Re-inject the manifest's MAIN-world content script (page.js) by file — the
// same fallback navigateTab uses. Returns true if the inject call succeeded;
// the caller re-runs the bridge to confirm window.__fastlink.run is now live.
async function reinjectPageScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: MAIN_WORLD_FILES });
    return true;
  } catch {
    return false;
  }
}

async function injectPageAction(action, args) {
  // Resolve the tab to act on through the single source of truth (pinned target
  // if set & alive, else the active tab) and inject by explicit id, so
  // snapshots/clicks/fills land on the tab Claude is driving even when the
  // user's focus has snapped back to another tab.
  const target = await getTargetTab();
  if (!target?.id) return { error: 'No tab to act on (no pinned target and no active tab).' };
  if (!isInjectableUrl(target.url)) return { error: `Restricted URL: ${target.url}` };

  let result = await runBridge(target.id, action, args);

  // HEALTH-CHECK / AUTO-REINJECT. After an extension reload the MAIN-world
  // page.js is gone from already-open tabs (window.__fastlink undefined) while
  // the broker/relay control channel stays UP — so fast_status reads "connected"
  // and the tab looks healthy, but page actions would silently no-op (empty
  // snapshot, indexing:true, no error). The bridge reports that as
  // {__fastlinkMissing}; re-inject page.js and retry ONCE so the tab self-heals.
  if (result && result.__fastlinkMissing) {
    const ok = await reinjectPageScript(target.id);
    if (ok) result = await runBridge(target.id, action, args);
    // Still not attached (restricted URL, crashed renderer, inject blocked) →
    // return a DISTINCT, machine-readable error instead of a silent empty
    // result, so Claude/the relay can tell the user to reload the tab.
    if (!ok || (result && result.__fastlinkMissing)) {
      return {
        error: 'content_script_not_live',
        hint: 'Reload the target tab to resume — FastLink\'s content script is not running in it (the extension was reloaded after this tab opened) and could not be re-injected.',
      };
    }
  }

  // executeScript itself failed (tab closed / restricted mid-flight).
  if (result && result.__injectError) {
    const raw = String(result.__injectRaw || result.__injectError);
    // BUG-2 sub-bug: a NAVIGATING action (e.g. a Submit click / link-follow)
    // makes the page navigate, which removes the MAIN-world frame BEFORE the
    // injected handler's ack returns — so executeScript rejects with "Frame with
    // ID 0 was removed." even though the action fired and the page navigated
    // correctly. For navigating actions, a frame-teardown is PROOF the action
    // worked, not a failure: report SUCCESS (navigated:true) so the step is
    // ok and a fast_batch continues (the server-side settle re-binds the next
    // step on the new page). Guard rails: only when the TAB itself isn't gone
    // (TAB_GONE_RE still errors), and only for NAVIGATING_ACTIONS — a frame loss
    // during a READ action stays an error so we never mask a real failure.
    if (NAVIGATING_ACTIONS.has(action) && FRAME_REMOVED_RE.test(raw) && !TAB_GONE_RE.test(raw)) {
      return { ok: true, navigated: true, note: 'action triggered navigation; old frame torn down before ack' };
    }
    return { error: result.__injectError };
  }

  // null/undefined from the injected script means it threw before returning.
  // Surface that as an error rather than guessing what happened (the old
  // "click probably fired, navigatedAway: true" hack masked real bugs).
  if (result == null) {
    return { error: `${action}: injected script returned no value — likely an exception in the page context. Try fast_evaluate or check chrome://extensions service worker logs.` };
  }
  return result;
}
