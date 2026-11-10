// tabQueue.js — per-tab FIFO for relay calls (docs/PIN-REDESIGN.md §2-§3).
//
// One queue per resolved tab id: `args.tabId` when the call names a tab, else the
// current target tab resolved at enqueue. Calls on the same tab run one at a time
// in arrival order; calls on different tabs run in parallel. Actions that never
// touch the page skip the queue (UNQUEUED_ACTIONS): fast_list, fast_tab opening a
// new tab, fast_switch pinning one, fast_close closing one (the way out of a
// frozen tab, so it must never wait behind it).
//
// Progress frames for the relay's timers:
//   {type:'queued', id, position}  the call waits; position = calls ahead of it
//   {type:'started', id}           the call left the queue and runs
//
// A stuck tab answers, it never hangs (feedback #24). The in-page deadlines
// (20-28 s) normally end a call; HARD_CAP_MS is the backstop. A call that hits
// the cap is abandoned (its promise can't be cancelled) and its tab is marked
// STUCK until that abandoned work settles, the tab commits a new page, or the tab
// closes (resetTab). While a tab is stuck, every call waiting on it and every new
// one is answered at once with code 'tab_stuck', instead of each waiting out
// another cap behind a page that is not answering. fast_nav still runs: loading
// the page again is the cure.
//
// Pure: no chrome.* here, so node tests drive it with stubs.

// Under the relay's 30 s post-'started' timer, so the relay hears the error from
// the extension instead of timing the call out itself.
export const HARD_CAP_MS = 29_000;
export const UNQUEUED_ACTIONS = new Set(['fast_list', 'fast_tab', 'fast_switch', 'fast_close']);
const RUNS_ON_STUCK_TAB = new Set(['fast_nav']);

// run(action, args) -> Promise<reply>; resolveTabId() -> Promise<number|null>
// (the current target tab); send(frame) emits a progress frame.
export function createTabQueue({ run, resolveTabId, send, hardCapMs = HARD_CAP_MS, now = Date.now }) {
  const lanes = new Map();          // key -> { busy: boolean, waiting: [job] }
  const stuck = new Map();          // key -> { action, since, token } while abandoned work is pending
  let keyChain = Promise.resolve(); // key resolution in arrival order keeps FIFO exact

  function keyFor(args) {
    if (typeof args?.tabId === 'number') return Promise.resolve(`tab:${args.tabId}`);
    return Promise.resolve()
      .then(resolveTabId)
      .then((id) => (typeof id === 'number' ? `tab:${id}` : 'tab:none'), () => 'tab:none');
  }

  function stuckReply(action, s) {
    const secs = Math.round((now() - s.since) / 1000);
    return {
      error: 'tab stuck',
      code: 'tab_stuck',
      phase: action,
      hint: `an earlier ${s.action} on this tab has not returned for ${secs}s, so the page is not answering and ${action} was not run. Open the page in a new tab, or fast_nav this tab to load it again; fast_close closes it.`,
    };
  }

  // Run one call under the cap. With a key, a call that hits the cap marks its tab stuck.
  function capped(call, key) {
    let timer;
    let settled = false;
    const work = Promise.resolve()
      .then(() => run(call.action, call.args || {}))
      .catch((err) => ({ error: err?.message || String(err) }))
      .finally(() => { settled = true; });
    const cap = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), hardCapMs);
    });
    const since = now();
    return Promise.race([work, cap]).then((reply) => {
      clearTimeout(timer);
      if (reply !== null || settled) return reply ?? work;
      if (key) {
        const token = {};
        stuck.set(key, { action: call.action, since, token });
        work.then(() => { if (stuck.get(key)?.token === token) stuck.delete(key); });
      }
      return {
        error: 'tab stuck',
        code: 'tab_stuck',
        phase: call.action,
        hint: `${call.action} did not finish within ${Math.round(hardCapMs / 1000)}s: the page is not answering. Calls to this tab now fail fast until it loads a new page; open it in a new tab, or fast_nav this tab to load it again.`,
      };
    });
  }

  function pump(key) {
    const lane = lanes.get(key);
    if (!lane || lane.busy) return;
    let job;
    while ((job = lane.waiting.shift())) {
      const s = stuck.get(key);
      if (s && !RUNS_ON_STUCK_TAB.has(job.call.action)) { job.resolve(stuckReply(job.call.action, s)); continue; }
      break;
    }
    if (!job) { lanes.delete(key); return; }
    lane.busy = true;
    send({ type: 'started', id: job.call.id });
    capped(job.call, key).then((reply) => {
      lane.busy = false;
      job.resolve(reply);
      pump(key);
    });
  }

  // Returns Promise<reply> for one {id, action, args} call.
  function submit(call) {
    if (UNQUEUED_ACTIONS.has(call.action)) return capped(call, null);
    return new Promise((resolve) => {
      keyChain = keyChain.then(() => keyFor(call.args)).then((key) => {
        let lane = lanes.get(key);
        if (!lane) { lane = { busy: false, waiting: [] }; lanes.set(key, lane); }
        lane.waiting.push({ call, resolve });
        const ahead = (lane.busy ? 1 : 0) + lane.waiting.length - 1;
        if (ahead > 0 && !stuck.has(key)) send({ type: 'queued', id: call.id, position: ahead });
        pump(key);
      });
    });
  }

  // The tab committed a new page or closed: whatever was stuck belonged to the old page.
  function resetTab(tabId) { stuck.delete(`tab:${tabId}`); }

  return { submit, resetTab, size: () => lanes.size, isStuck: (tabId) => stuck.has(`tab:${tabId}`) };
}
