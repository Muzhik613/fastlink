// fastlink.js — the benchmark's OWN channel into the browser.
//
// WHY IN-PROCESS, NOT HTTP, NOT A SPAWNED STDIO SERVER:
// `handleCall` in fast-dxt/server/handlers.js is EXACTLY what the MCP transports
// (stdio + streamable HTTP) dispatch every tools/call to — transports.js does
// nothing but `handleCall(req.params.name, req.params.arguments)`. Importing it
// directly gives byte-identical behaviour with none of the failure modes:
//   • The HTTP interface (fast_status → httpEnabled/httpPort 9879) is only up when
//     a server was launched with --http, it binds 127.0.0.1 ONCE (a second server
//     hits EADDRINUSE and silently skips HTTP), and it is Bearer-gated on
//     FASTLINK_TOKEN. So "is 9879 mine?" depends on which unrelated Claude Code
//     session happened to start first. Unusable as a stable scripting path.
//   • Spawning our own stdio server means reimplementing JSON-RPC framing and
//     initialize handshaking to reach the same function.
// The broker multiplexes every connected MCP client onto the one extension
// socket, so this process is just one more client alongside whatever the chat is
// driving — reads here never contend with the run under test.
//
// SCORING IS DELIBERATELY OFF-TRANSPORT: a run may be driven over the cloud relay,
// but verification always comes back through the LOCAL broker. The verifier is an
// independent observer of the same Chrome, never the channel under test.
//
// TIMING-LOG NOTE: handlers.js logTiming appends this process's calls to
// /tmp/fastlink-timing.jsonl too. That log is not the measurement source for chat
// runs (relay traces are), and reset/scoring happen strictly outside the run's
// time window, so the rows never land inside a measured slice.
import { handleCall } from '../fast-dxt/server/handlers.js';

// Every FastLink handler returns { content: [{ type:'text', text: <JSON> }] }.
export async function fl(name, args = {}) {
  const res = await handleCall(name, args);
  const raw = res?.content?.[0]?.text;
  if (typeof raw !== 'string') return res;
  try { return JSON.parse(raw); } catch { return { raw }; }
}

/** Pin this process to one Chrome profile (install slot) so parallel cells
 *  against different profiles never cross-talk. `auto`/null releases the pin. */
export async function pinInstall(label) {
  if (!label || label === 'auto') return fl('fast_profile', { install: 'auto' });
  return fl('fast_profile', { install: label });
}

export async function tabs() {
  const r = await fl('fast_list', {});
  return Array.isArray(r) ? r : (r?.tabs || []);
}

/** Focus the tab whose URL/title contains `match`. Returns the tab, or null. */
export async function switchToTab(match) {
  const list = await tabs();
  const hit = list.find((t) => (t.url || '').includes(match))
    || list.find((t) => (t.title || '').toLowerCase().includes(match.toLowerCase()));
  if (!hit) return null;
  if (!hit.active) await fl('fast_switch', { tabId: hit.id });
  return hit;
}

/** Run JS in the tab matching `match` (or the active tab when match is falsy). */
export async function evalIn(match, fn, args = []) {
  if (match) {
    const t = await switchToTab(match);
    if (!t) return { __noTab: true, match };
  }
  const r = await fl('fast_evaluate', { fn, args });
  if (r && typeof r === 'object' && 'result' in r) return r.result;
  if (r && typeof r === 'object' && 'value' in r) return r.value;
  return r;
}

/** Close every tab whose URL contains any of `patterns`. Used by run reset so a
 *  cell never inherits a previous run's page (which would score as free credit). */
export async function closeMatching(patterns = []) {
  if (!patterns.length) return [];
  const closed = [];
  for (const t of await tabs()) {
    const url = t.url || '';
    if (!patterns.some((p) => url.includes(p))) continue;
    try { await fl('fast_close', { tabId: t.id }); closed.push(url); } catch { /* already gone */ }
  }
  return closed;
}

/** Wipe localStorage + sessionStorage for each origin, so a site that CACHES a
 *  previous run's work cannot hand the next run a pre-filled page as free credit.
 *  Closing tabs is NOT enough — this state outlives the tab.
 *  Confirmed live on 2026-08-06: once any run clicks Search, aa.com writes the
 *  submitted itinerary to `localStorage.AAFlightSearch` / `AA_FlightSearch` and
 *  re-populates From/To/Departure/Return from it on the NEXT page load — a fresh
 *  tab came up already reading JFK / LAX / 12/15/2026 / 12/22/2026. Wiping the
 *  origin brought the same form back to all-empty. */
export async function clearStorageFor(urls = []) {
  if (!urls.length) return [];
  const cleared = [];
  for (const url of urls) {
    let tab = null;
    try {
      tab = await fl('fast_tab', { url });
      // fast_tab returns before the document is on the target origin; fast_nav
      // waits for the load, so localStorage.clear() cannot run against about:blank.
      await fl('fast_nav', { url, waitMs: 20000 });
      await fl('fast_evaluate', { fn: '() => { localStorage.clear(); sessionStorage.clear(); return true; }' });
      cleared.push(url);
    } catch { /* site unreachable — then it cached nothing to clear */ }
    if (tab?.id) { try { await fl('fast_close', { tabId: tab.id }); } catch { /* already gone */ } }
  }
  return cleared;
}

export async function status() { return fl('fast_status', {}); }
