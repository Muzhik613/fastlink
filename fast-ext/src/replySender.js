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
// The biggest result frame sent to the relay (UTF-8 bytes). Bigger ones dropped the relay
// socket (and with it the caller's MCP connection: winshore 11-10, a 15 MB fast_text), so
// they are replaced by an error frame. fast_text stays far below it (2M chars per call).
export const FRAME_MAX_BYTES = 16 * 1024 * 1024;

// The frame as sent: itself, or an error in its place when it's too big to send.
export function encodeResult(frame) {
  const s = JSON.stringify(frame);
  // UTF-8 is at most 3 bytes per UTF-16 unit: only measure when it could be over.
  if (s.length * 3 <= FRAME_MAX_BYTES) return s;
  const bytes = new TextEncoder().encode(s).length;
  if (bytes <= FRAME_MAX_BYTES) return s;
  const mb = (n) => (n / 1048576).toFixed(1);
  const { type, id, origin, tabId } = frame;
  return JSON.stringify({ type, id, origin, tabId, error: `result too large to send (${mb(bytes)} MB; the limit is ${mb(FRAME_MAX_BYTES)} MB): ask for less (fast_text reads big text in pieces with offset/maxLen, or a narrower selector)` });
}

// onDrop(n): n held results expired undelivered (connLog.js).
export function createReplySender({ getCurrent, holdMs = HOLD_MS, now = Date.now, onDrop = () => {} }) {
  const held = [];   // [{ frame, at }]

  function trySend(ws, frame) {
    if (!ws || ws.readyState !== OPEN) return false;
    try { ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame)); return true; } catch { return false; }
  }

  // A result frame: current socket, else the arrival socket, else hold it.
  function sendResult(result, arrivalWs) {
    const frame = encodeResult(result);
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
    let dropped = 0;
    while (held.length) {
      const { frame, at } = held[0];
      if (at < cutoff) { held.shift(); dropped++; continue; }
      if (!trySend(ws, frame)) break;
      held.shift();
    }
    if (dropped) onDrop(dropped);
  }

  return { sendResult, sendProgress, flush, heldCount: () => held.length };
}
