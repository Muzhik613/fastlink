// fast_evaluate: run a JS function the user's assistant wrote, in the page.
//
// ONE path: chrome.userScripts.execute (Chrome 135+), the Web Store's sanctioned API for
// running user-provided code. The user turns it on per browser ("Allow User Scripts" on
// FastLink's details page); until then this tool explains how and does nothing. The code
// runs in the page's MAIN world, so it sees page variables. The extension itself never
// evaluates strings (no eval / new Function / CDP Runtime.evaluate).
import { getInjectableTab } from '../util.js';   // installed as src/actions/evaluate.js by scripts/build-secure.sh

export const USER_SCRIPTS_OFF =
  'fast_evaluate is off in this browser. To allow it: chrome://extensions → FastLink → Details → turn on "Allow User Scripts".';

// true when the user has allowed user scripts for FastLink (the API throws otherwise).
export function userScriptsAllowed() {
  try { return typeof chrome.userScripts?.execute === 'function'; } catch { return false; }
}

export async function evaluate({ fn, args, tabId }) {
  if (typeof fn !== 'string' || !fn.trim()) return { error: 'fast_evaluate: `fn` must be a function source string' };
  if (!userScriptsAllowed()) return { error: USER_SCRIPTS_OFF, code: 'user_scripts_off' };
  const got = await getInjectableTab(tabId);
  if (got.error) return got;
  const userArgs = Array.isArray(args) ? args : [];
  // The result crosses as a JSON string so the value comes back exactly (key order, nulls).
  const code = `(async () => { try { const __fn = (${fn}); const v = await __fn(...${JSON.stringify(userArgs)}); return JSON.stringify({ ok: v === undefined ? null : v }); } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); } })()`;
  let res;
  try {
    res = await chrome.userScripts.execute({ target: { tabId: got.tab.id }, js: [{ code }], world: 'MAIN', injectImmediately: true });
  } catch (e) {
    return { error: `fast_evaluate: ${e?.message || e}` };
  }
  const r = res && res[0];
  if (!r) return { error: 'fast_evaluate: no result from the page' };
  if (r.error) return { error: String(r.error) };
  let out;
  try { out = JSON.parse(r.result); } catch { return { error: 'fast_evaluate: the result could not be read (not JSON-serializable?)' }; }
  return out.err !== undefined ? { error: out.err } : out.ok;
}
