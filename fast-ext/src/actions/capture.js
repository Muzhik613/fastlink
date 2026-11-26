// capture.js — fast_capture: a tab's own network requests whose URL contains `url`, with the
// request headers as sent on the wire, the request body, the response headers and the
// response body. One watch kind ('request') in watch.js's registry; every finished request
// is one {kind:'request', …} event the relay keeps for fast_watch_read.
//
// Source: the Network domain on FastLink's shared debugger session (input.js cdp(), so no
// second attach and no banner flicker). webRequest can't read response bodies, so it is not
// used here. A service token's captures are limited to its allowed origins (the relay passes
// `origins`); a request to any other origin is never recorded.

import { cdp, onDebuggerAttach } from './input.js';
import { getInjectableTab } from '../util.js';
import { registerKind, addWatch, watchesOnTab, registrySync, pushEvents, endWatch, ready, originOf } from './watch.js';

export const BODY_MAX_DEFAULT = 2 * 1024 * 1024;
const POST_DATA_MAX = 64 * 1024;
const WATCH_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const IN_FLIGHT_MAX = 500;

// fast_capture args → {spec} or {error}.
export function checkCaptureSpec(args = {}) {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url || url.length > 500) return { error: 'fast_capture needs `url`: text the request URL contains (e.g. "/abs/pub/cart"), up to 500 characters' };
  const method = args.method == null ? null : String(args.method).toUpperCase();
  if (method && !/^[A-Z]{3,10}$/.test(method)) return { error: 'fast_capture `method` must be an HTTP method like GET or POST' };
  const maxBody = args.maxBody == null ? BODY_MAX_DEFAULT : Number(args.maxBody);
  if (!Number.isInteger(maxBody) || maxBody < 0 || maxBody > BODY_MAX_DEFAULT) return { error: `fast_capture \`maxBody\` must be 0-${BODY_MAX_DEFAULT} bytes` };
  const origins = Array.isArray(args.origins) ? args.origins.map(String) : null;
  return { spec: { url, method, body: args.body !== false, maxBody, origins } };
}

export function requestMatches(spec, url, method) {
  if (!url.includes(spec.url)) return false;
  if (spec.method && spec.method !== method) return false;
  if (spec.origins) { let o = ''; try { o = new URL(url).origin; } catch {} if (!spec.origins.includes(o)) return false; }
  return true;
}

// fast_capture {watchId, tabId, url, method?, body?, maxBody?, origins?}
export async function captureStart(args = {}) {
  const id = args.watchId;
  if (typeof id !== 'string' || !WATCH_ID_RE.test(id)) return { error: 'fast_capture: no watchId (the relay assigns it; update the relay)' };
  const chk = checkCaptureSpec(args);
  if (chk.error) return chk;
  const got = await getInjectableTab(args.tabId);
  if (got.error) return got;
  const tabId = got.tab.id;
  const origin = originOf(got.tab.url);
  if (!origin) return { error: 'fast_capture works only on an http(s) page' };
  if (chk.spec.origins && !chk.spec.origins.includes(origin)) return { error: `fast_capture: the tab is on ${origin}, not an allowed origin` };
  try { await cdp(tabId, 'Network.enable', { maxPostDataSize: POST_DATA_MAX }); }
  catch (e) { return { error: `fast_capture could not watch this tab's network: ${e?.message || e}`, ...(e?.code ? { code: e.code } : {}) }; }
  await addWatch(id, { kind: 'request', tabId, origin, spec: chk.spec });
  return { watchId: id, tabId, url: chk.spec.url, ...(chk.spec.method ? { method: chk.spec.method } : {}), body: chk.spec.body };
}

registerKind('request', {
  // the last capture on a tab turns the Network domain off again
  stop: async (_id, w) => {
    if (watchesOnTab(w.tabId, 'request').length) return;
    try { await cdp(w.tabId, 'Network.disable'); } catch { /* tab gone / detached */ }
  },
});

// A re-attached session (a restarted worker re-attaches) has Network off: turn it back on.
onDebuggerAttach(async (tabId) => {
  await ready;
  if (watchesOnTab(tabId, 'request').length) await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxPostDataSize: POST_DATA_MAX });
});

// requestId -> the request being recorded, until it finishes or fails.
const inFlight = new Map();
const extraHeaders = new Map();   // requestId -> wire headers that arrived before requestWillBeSent

function capturesFor(tabId) {
  return registrySync() ? watchesOnTab(tabId, 'request') : [];
}
function trimMap(m) { while (m.size > IN_FLIGHT_MAX) m.delete(m.keys().next().value); }

async function finish(tabId, requestId, failure) {
  const rec = inFlight.get(requestId);
  inFlight.delete(requestId);
  extraHeaders.delete(requestId);
  if (!rec) return;
  const live = capturesFor(tabId).filter(([id]) => rec.watchIds.includes(id));
  if (!live.length) return;
  let body = null;
  if (!failure && live.some(([, w]) => w.spec.body && w.spec.maxBody > 0)) {
    try { body = await cdp(tabId, 'Network.getResponseBody', { requestId }); }
    catch (e) { body = { error: e?.message || String(e) }; }
  }
  const base = {
    kind: 'request', url: rec.url, method: rec.method, resourceType: rec.type,
    requestHeaders: rec.requestHeaders, ...(rec.postData != null ? { postData: rec.postData } : {}),
    ...(failure ? { failed: failure } : { status: rec.status, responseHeaders: rec.responseHeaders, mimeType: rec.mimeType }),
  };
  for (const [id, w] of live) {
    const ev = { ...base };
    if (body && w.spec.body && w.spec.maxBody > 0) {
      if (body.error) ev.bodyError = body.error;
      else {
        const raw = String(body.body ?? '');
        const cap = body.base64Encoded ? Math.floor(w.spec.maxBody / 3) * 4 : w.spec.maxBody;
        ev.body = raw.length > cap ? raw.slice(0, cap) : raw;
        ev.bodyLength = raw.length;
        if (body.base64Encoded) ev.base64 = true;
        if (raw.length > cap) ev.truncated = true;
      }
    }
    pushEvents(id, [ev]).catch(() => {});
  }
}

try {
  chrome.debugger.onEvent.addListener((src, method, p) => {
    const tabId = src?.tabId;
    if (typeof tabId !== 'number' || !p) return;
    const caps = capturesFor(tabId);
    if (!caps.length) return;
    if (method === 'Network.requestWillBeSent') {
      const url = p.request?.url || '';
      const m = String(p.request?.method || 'GET').toUpperCase();
      // only requests made by a page on the watch's own origin (never the next site's document)
      const doc = originOf(p.documentURL || '');
      const ids = caps.filter(([, w]) => doc === w.origin && requestMatches(w.spec, url, m)).map(([id]) => id);
      if (!ids.length) { inFlight.delete(p.requestId); return; }   // a redirect off the pattern
      const wire = extraHeaders.get(p.requestId);
      inFlight.set(p.requestId, {
        watchIds: ids, url, method: m, type: p.type || null,
        requestHeaders: { ...(p.request?.headers || {}), ...(wire || {}) },
        postData: p.request?.postData != null ? String(p.request.postData).slice(0, POST_DATA_MAX) : null,
      });
      trimMap(inFlight);
    } else if (method === 'Network.requestWillBeSentExtraInfo') {
      const rec = inFlight.get(p.requestId);
      if (rec) rec.requestHeaders = { ...rec.requestHeaders, ...(p.headers || {}) };
      else { extraHeaders.set(p.requestId, p.headers || {}); trimMap(extraHeaders); }
    } else if (method === 'Network.responseReceived') {
      const rec = inFlight.get(p.requestId);
      if (!rec) return;
      rec.status = p.response?.status ?? null;
      rec.responseHeaders = p.response?.headers || {};
      rec.mimeType = p.response?.mimeType || null;
    } else if (method === 'Network.loadingFinished') {
      finish(tabId, p.requestId, null);
    } else if (method === 'Network.loadingFailed') {
      finish(tabId, p.requestId, p.canceled ? 'canceled' : (p.errorText || 'failed'));
    }
  });
  // DevTools opened on the tab, or the user dismissed the debugging banner: captures end.
  chrome.debugger.onDetach.addListener(async (src, reason) => {
    if (typeof src?.tabId !== 'number') return;
    await ready;
    for (const [id] of watchesOnTab(src.tabId, 'request')) endWatch(id, `debugger detached (${reason || 'unknown'})`).catch(() => {});
  });
} catch { /* node tests: no chrome */ }
