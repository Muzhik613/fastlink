// fast_batch runner — pure orchestration over an injected `call(name, args)`.
// Used by fast-dxt/server/handlers.js and MIRRORED at fastlink-relay/src/batch.js
// (keep both files identical; the relay wires consent/audit into `call`/`gate`).
//
// Contract (2026-09-15, "batching is the default path for forms"):
//  • every step runs — a miss never aborts the batch; the step result carries the
//    miss (error + candidates/hint) and the batch result LEADS with a summary line
//    ("5/6 steps ok; step 3 (fast_fill "Ocean") missed: …") so the model reads the
//    outcome first and the details second.
//  • intermediate steps are run with noSnapshot:true — only the LAST step returns
//    the page snapshot (one page state per round-trip, not N copies of it); a step
//    that sets noSnapshot itself keeps its own choice.
//  • conditional steps: { ifFound: "<text>" | "<css selector>", then:[…], else:[…] }
//    are decided here (one fast_wait probe, ≤ waitMs, default 1000) — no model
//    round-trip. A selector is a string starting with # . [ : * or containing > or [.
//  • steps that name fast_fill_form are rewritten to fast_fill (fill_form folded
//    into fast_fill {fields}).
//  • inter-step navigation settle (BUG-2) is unchanged: after a possibly-
//    navigating step that has a follower, watch the tab URL and wait for the new
//    document's readyState before dispatching the next step.

const SETTLE_READY_BUDGET_MS = 8000;     // wait for the NEW doc to become ready
const NAV_DETECT_MS = 2500;              // predicted/nav-action: window to observe the commit
const NAV_DETECT_UNPREDICTED_MS = 700;   // backstop window for a MISPREDICTED nav
const SETTLE_PROBE_TIMEOUT_MS = 1500;    // per readyState probe deadline (orphan, don't wait 30s)
const SETTLE_POLL_GAP_MS = 150;          // gap between polls
const SETTLE_INITIAL_GAP_MS = 100;       // let teardown/commit begin before first poll
const IF_FOUND_WAIT_MS = 1000;           // default probe budget for ifFound

// Inherently-navigating actions whose result carries no willNavigate flag.
const NAV_ACTIONS = new Set(['fast_nav', 'fast_reload']);
// Steps that can drive a SAME-TAB navigation. Read-only / tab-switching steps are
// excluded so they add zero latency and never trigger a false "navigated".
const POSSIBLY_NAVIGATING = new Set([
  'fast_click', 'fast_click_xy', 'fast_key', 'fast_key_press',
  'fast_nav', 'fast_reload', 'fast_select_option', 'fast_drag', 'fast_drag_xy',
]);
const STEP_RENAMES = { fast_fill_form: 'fast_fill' };
const SELECTOR_RE = /^[#.[:*]|[>[]/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isSelectorProbe = (s) => SELECTOR_RE.test(String(s));

// One bounded readyState probe: the readyState string, or null on timeout/error.
function probeReadyState(call, ms) {
  const p = Promise.resolve().then(() => call('fast_evaluate', { fn: '() => document.readyState' }));
  p.catch(() => {});
  return Promise.race([
    p.then((r) => (r && typeof r === 'object' ? r.result : null)).catch(() => null),
    sleep(ms).then(() => null),
  ]);
}

// Target tab URL via fast_list (no debugger attach). '' on any failure.
async function tabUrl(call) {
  try {
    const r = await call('fast_list', {});
    const tabs = r?.result;
    if (!Array.isArray(tabs)) return '';
    const t = tabs.find((x) => x && x.targetTab) || tabs.find((x) => x && x.active);
    return t?.url || '';
  } catch { return ''; }
}

// After a possibly-navigating step: did the tab URL change? If so, wait (bounded)
// for the new document. The trigger is the OBSERVED change; hints only widen the window.
async function settleIfNavigated(call, stepName, urlBefore, willNavigateHint) {
  const isNavAction = NAV_ACTIONS.has(stepName);
  const predicted = willNavigateHint === true || isNavAction;
  const detectBudget = predicted ? NAV_DETECT_MS : NAV_DETECT_UNPREDICTED_MS;
  await sleep(SETTLE_INITIAL_GAP_MS);
  let navUrl = null;
  const detectDeadline = Date.now() + detectBudget;
  while (Date.now() < detectDeadline) {
    const url = await tabUrl(call);
    if (url && urlBefore && url !== urlBefore) { navUrl = url; break; }
    await sleep(SETTLE_POLL_GAP_MS);
  }
  if (!navUrl && !isNavAction) return null;
  const readyDeadline = Date.now() + SETTLE_READY_BUDGET_MS;
  while (Date.now() < readyDeadline) {
    const state = await probeReadyState(call, SETTLE_PROBE_TIMEOUT_MS);
    if (state === 'interactive' || state === 'complete') break;
    await sleep(SETTLE_POLL_GAP_MS);
  }
  return navUrl || (await tabUrl(call)) || urlBefore || '';
}

const stripSnapshot = (result) => {
  if (!result || typeof result !== 'object') return result;
  const { snapshot, snapshotFresh, snapshotStale, snapshotPartial, snapshotTimedOut, snapshotNote, ...rest } = result;
  return rest;
};

const missText = (r) => {
  const e = String(r?.error || 'failed').replace(/\s+/g, ' ');
  return e.length > 140 ? e.slice(0, 140) + '…' : e;
};
const stepLabel = (step) => {
  const a = step.args || {};
  const key = a.match ?? a.text ?? a.field ?? a.url ?? a.key ?? (a.fields && Object.keys(a.fields).join(',')) ?? '';
  return key ? `${step.name} ${JSON.stringify(String(key).slice(0, 40))}` : step.name;
};

/**
 * @param {object} args  { actions:[ {name,args} | {ifFound, then, else, waitMs} ] }
 * @param {object} io    { call(name,args) → {result}|{error…}, gate?(step) → null|{error…} }
 */
export async function runBatch(args, io) {
  const { call, gate } = io;
  const actions = Array.isArray(args?.actions) ? args.actions : [];
  const counts = { ok: 0, missed: 0, steps: 0 };
  const misses = [];   // { label, error }

  const runStep = async (step, index, hasFollower) => {
    const name = STEP_RENAMES[step.name] || step.name;
    counts.steps++;
    const label = `step ${index} (${stepLabel({ ...step, name })})`;
    const gated = gate ? await gate({ ...step, name }) : null;
    if (gated) {
      counts.missed++; misses.push({ label, error: missText(gated) });
      return { step: index, name, ok: false, ...gated };
    }
    // One page state per round-trip: only the last step carries a snapshot.
    const stepArgs = { ...(step.args || {}) };
    if (hasFollower && stepArgs.noSnapshot === undefined) stepArgs.noSnapshot = true;
    const navCandidate = hasFollower && POSSIBLY_NAVIGATING.has(name);
    const urlBefore = navCandidate ? await tabUrl(call) : null;
    let r;
    try { r = await call(name, stepArgs); }
    catch (e) { r = { error: e?.message || String(e) }; }
    if (r && r.error) {
      counts.missed++; misses.push({ label, error: missText(r) });
      return { step: index, name, ok: false, ...r };
    }
    counts.ok++;
    if (navCandidate) await settleIfNavigated(call, name, urlBefore, r?.result && r.result.willNavigate);
    return { step: index, name, ok: true, result: hasFollower ? stripSnapshot(r?.result) : r?.result };
  };

  const runList = async (list, parentHasFollower) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const step = list[i] || {};
      const hasFollower = i < list.length - 1 || parentHasFollower;
      if (step.ifFound !== undefined) {
        out.push(await runConditional(step, i, hasFollower));
        continue;
      }
      if (!step.name) {
        counts.steps++; counts.missed++; misses.push({ label: `step ${i}`, error: 'invalid step (missing name)' });
        out.push({ step: i, name: null, ok: false, error: 'invalid step (missing name)' });
        continue;
      }
      out.push(await runStep(step, i, hasFollower));
    }
    return out;
  };

  const runConditional = async (step, index, hasFollower) => {
    const probeArg = step.ifFound && typeof step.ifFound === 'object'
      ? step.ifFound
      : (isSelectorProbe(step.ifFound) ? { selector: String(step.ifFound) } : { text: String(step.ifFound) });
    const waitMs = typeof step.waitMs === 'number' ? step.waitMs : IF_FOUND_WAIT_MS;
    let found = false;
    try {
      const r = await call('fast_wait', { ...probeArg, timeoutMs: waitMs, noSnapshot: true });
      found = !!(r && !r.error && r.result && r.result.found && !r.result.emptyContainer);
    } catch { found = false; }
    const branch = found ? 'then' : 'else';
    const list = Array.isArray(step[branch]) ? step[branch] : [];
    const results = await runList(list, hasFollower);
    return { step: index, ifFound: step.ifFound, found, branch, ran: list.length, results };
  };

  const results = await runList(actions, false);
  const head = `${counts.ok}/${counts.steps} steps ok`;
  const summary = misses.length
    ? `${head}; ${misses.map((m) => `${m.label} missed: ${m.error}`).join(' | ')}`
    : head;
  return { summary, ok: counts.ok, missed: counts.missed, steps: counts.steps, results };
}
