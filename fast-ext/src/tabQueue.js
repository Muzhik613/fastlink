// tabQueue.js — per-tab FIFO for relay calls (docs/PIN-REDESIGN.md §2-§3).
//
// One queue per resolved tab id: `args.tabId` when the call names a tab, else the
// current target tab resolved at enqueue. Calls on the same tab run one at a time
// in arrival order; calls on different tabs run in parallel. Browser-level actions
// that don't touch a page (fast_list, fast_tab opening a new tab) skip the queue.
//
// Progress frames for the relay's timers:
//   {type:'queued', id, position}  the call waits; position = calls ahead of it
//   {type:'started', id}           the call left the queue and runs
//
// A stuck call must not block its tab forever: the in-page deadlines (20-28 s)
// normally end it, and HARD_CAP_MS is the backstop after which the queue moves on
// and the call resolves with a 'page busy' error (its promise is abandoned).
//
// Pure: no chrome.* here, so node tests drive it with stubs.

// Under the relay's 30 s post-'started' timer, so the relay hears 'page busy'
// from the extension instead of timing the call out itself.
export const HARD_CAP_MS = 29_000;
export const UNQUEUED_ACTIONS = new Set(['fast_list', 'fast_tab']);

// run(action, args) -> Promise<reply>; resolveTabId() -> Promise<number|null>
// (the current target tab); send(frame) emits a progress frame.
export function createTabQueue({ run, resolveTabId, send, hardCapMs = HARD_CAP_MS }) {
  const lanes = new Map();          // key -> { busy: boolean, waiting: [job] }
  let keyChain = Promise.resolve(); // key resolution in arrival order keeps FIFO exact

  function keyFor(args) {
    if (typeof args?.tabId === 'number') return Promise.resolve(`tab:${args.tabId}`);
    return Promise.resolve()
      .then(resolveTabId)
      .then((id) => (typeof id === 'number' ? `tab:${id}` : 'tab:none'), () => 'tab:none');
  }

  function capped(call) {
    let timer;
    const cap = new Promise((resolve) => {
      timer = setTimeout(() => resolve({
        error: 'page busy',
        phase: call.action,
        hint: `${call.action} did not finish within ${Math.round(hardCapMs / 1000)}s, so the tab's queue moved on; the page may be frozen — read it before retrying.`,
      }), hardCapMs);
    });
    const work = Promise.resolve()
      .then(() => run(call.action, call.args || {}))
      .catch((err) => ({ error: err?.message || String(err) }));
    return Promise.race([work, cap]).finally(() => clearTimeout(timer));
  }

  function pump(key) {
    const lane = lanes.get(key);
    if (!lane || lane.busy) return;
    const job = lane.waiting.shift();
    if (!job) { lanes.delete(key); return; }
    lane.busy = true;
    send({ type: 'started', id: job.call.id });
    capped(job.call).then((reply) => {
      lane.busy = false;
      job.resolve(reply);
      pump(key);
    });
  }

  // Returns Promise<reply> for one {id, action, args} call.
  function submit(call) {
    if (UNQUEUED_ACTIONS.has(call.action)) return capped(call);
    return new Promise((resolve) => {
      keyChain = keyChain.then(() => keyFor(call.args)).then((key) => {
        let lane = lanes.get(key);
        if (!lane) { lane = { busy: false, waiting: [] }; lanes.set(key, lane); }
        lane.waiting.push({ call, resolve });
        const ahead = (lane.busy ? 1 : 0) + lane.waiting.length - 1;
        if (ahead > 0) send({ type: 'queued', id: call.id, position: ahead });
        pump(key);
      });
    });
  }

  return { submit, size: () => lanes.size };
}
