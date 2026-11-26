// watchOutbox.js — delivers watch events (fast_watch DOM changes, fast_capture requests) to the
// relay, which keeps them for fast_watch_read. Nothing is lost on a dropped socket:
//   push(watchId, events) → batch n (1, 2, … per watch) → {type:'watch', watchId, n, events}
//   relay → {type:'watch_ack', watchId, n}  drops batches ≤ n
//   relay → {type:'watch_gone', watchId}    the watch was stopped there: the owner stops it here
//   socket (re)open → every unacked batch is sent again in order (the relay ignores n it has)
// Unacked batches live in chrome.storage.session, so a service-worker restart keeps them.
//
// Pure apart from the injected `storage` (get/set of one key) and `send(frame) → bool`,
// so node tests drive it with stubs.

export const OUTBOX_KEY = 'fastlink.watchOutbox';
// Per watch: unacked events kept while the relay can't be reached. Past this the oldest
// batches go, and the first batch kept says how many events were dropped before it.
export const MAX_PENDING_EVENTS = 300;

export function createWatchOutbox({ storage, send, onGone = () => {} }) {
  let state = null;             // { [watchId]: { n, pending: [{n, events, dropped?}] } }
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

  async function load() {
    if (state) return state;
    try { state = (await storage.get(OUTBOX_KEY)) || {}; } catch { state = {}; }
    return state;
  }
  async function save() { try { await storage.set(OUTBOX_KEY, state); } catch { /* memory only */ } }
  const frame = (watchId, b) => ({ type: 'watch', watchId, n: b.n, events: b.events, ...(b.dropped ? { dropped: b.dropped } : {}) });

  return {
    push: (watchId, events) => serial(async () => {
      if (!events?.length) return;
      const s = await load();
      const w = (s[watchId] ||= { n: 0, pending: [] });
      const b = { n: ++w.n, events };
      w.pending.push(b);
      let total = w.pending.reduce((a, x) => a + x.events.length, 0);
      while (total > MAX_PENDING_EVENTS && w.pending.length > 1) {
        const old = w.pending.shift();
        total -= old.events.length;
        w.pending[0].dropped = (w.pending[0].dropped || 0) + (old.dropped || 0) + old.events.length;
      }
      await save();
      send(frame(watchId, b));
    }),
    ack: (watchId, n) => serial(async () => {
      const s = await load();
      const w = s[watchId];
      if (!w) return;
      w.pending = w.pending.filter((b) => b.n > n);
      await save();
    }),
    gone: (watchId) => serial(async () => {
      const s = await load();
      delete s[watchId];
      await save();
      onGone(watchId);
    }),
    // Forget a watch stopped here (its unacked events are moot: the relay deleted it).
    drop: (watchId) => serial(async () => {
      const s = await load();
      if (!(watchId in s)) return;
      delete s[watchId];
      await save();
    }),
    flush: () => serial(async () => {
      const s = await load();
      for (const [id, w] of Object.entries(s)) for (const b of w.pending) send(frame(id, b));
    }),
  };
}
