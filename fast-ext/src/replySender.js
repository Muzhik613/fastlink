// replySender.js — deliver call results on the LIVE relay socket (PIN-REDESIGN §2,
// bug fix 1). A call's result goes out on the CURRENT socket, not the one the call
// arrived on: the relay matches results by id across the device's sockets, so a
// result finished after a redial still lands. The arrival socket is used only when
// there is no current one. With no open socket at all, the result is held for up
// to HOLD_MS and flushed on the next open.
//
// Pure: no chrome.* or WebSocket globals (readyState 1 = OPEN), for node tests.

export const HOLD_MS = 10_000;
const OPEN = 1;

export function createReplySender({ getCurrent, holdMs = HOLD_MS, now = Date.now }) {
  const held = [];   // [{ frame, at }]

  function trySend(ws, frame) {
    if (!ws || ws.readyState !== OPEN) return false;
    try { ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  // A result frame: current socket, else the arrival socket, else hold it.
  function sendResult(frame, arrivalWs) {
    if (trySend(getCurrent(), frame)) return true;
    if (trySend(arrivalWs, frame)) return true;
    held.push({ frame, at: now() });
    return false;
  }

  // A progress frame (queued/started): only worth sending live, never held.
  function sendProgress(frame) {
    return trySend(getCurrent(), frame);
  }

  // Called when a socket opens: deliver held results still within the window.
  function flush() {
    const ws = getCurrent();
    const cutoff = now() - holdMs;
    while (held.length) {
      const { frame, at } = held[0];
      if (at < cutoff) { held.shift(); continue; }
      if (!trySend(ws, frame)) return;
      held.shift();
    }
  }

  return { sendResult, sendProgress, flush, heldCount: () => held.length };
}
