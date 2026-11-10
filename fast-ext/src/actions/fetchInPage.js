// fast_fetch (service tokens only; the relay checks the token's allowed origins and builds the
// request): ONE fixed fetch() in the tab's own page context, so it carries that site's cookies and
// passes its bot checks. Same origin as the tab only. No other code runs; nothing here takes code.
import { getInjectableTab } from '../util.js';

const BODY_MAX = 512 * 1024;   // the relay socket carries ~1 MB; keep well under it

// Runs in the page (MAIN world). Self-contained: chrome.scripting serializes it.
async function pageFetch(url, method, headers, body, max) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { method, headers, body, credentials: 'include', signal: ctl.signal, redirect: 'follow' });
    const text = method === 'HEAD' ? '' : await r.text();
    return {
      status: r.status, ok: r.ok, url: r.url, redirected: r.redirected,
      contentType: r.headers.get('content-type') || '',
      length: text.length, truncated: text.length > max, body: text.length > max ? text.slice(0, max) : text,
    };
  } catch (e) {
    return { error: `fetch failed: ${e && e.name === 'AbortError' ? 'timed out after 25 s' : (e && e.message) || e}` };
  } finally { clearTimeout(t); }
}

export async function fetchInPage({ tabId, url, method = 'GET', headers = {}, body } = {}) {
  if (typeof tabId !== 'number') return { error: 'fast_fetch: tabId is required' };
  const got = await getInjectableTab(tabId);
  if (got.error) return got;
  let want, have;
  try { want = new URL(url); have = new URL(got.tab.url); } catch { return { error: 'fast_fetch: bad url' }; }
  if (want.origin !== have.origin) return { error: `fast_fetch: the tab is on ${have.origin}, not ${want.origin}; nothing was sent` };
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: got.tab.id, frameIds: [0] }, world: 'MAIN', func: pageFetch,
    args: [want.href, method, headers, body === undefined ? null : body, BODY_MAX],
  });
  return result && typeof result === 'object' ? { ...result, tabId: got.tab.id } : { error: 'fast_fetch: no result from the page' };
}
