// fast_evaluate: run a JS function the user's assistant wrote, in the page.
//
// ONE path: chrome.userScripts.execute (Chrome 135+), the Web Store's sanctioned API for
// running user-provided code. The user turns it on per browser ("Allow User Scripts" on
// FastLink's details page); until then this tool explains how and does nothing. The code
// runs in the page's MAIN world, so it sees page variables. The extension itself never
// evaluates strings (no eval / new Function / CDP Runtime.evaluate).
import { getInjectableTab } from '../util.js';   // installed as src/secure/evaluate.js by scripts/build-secure.sh and build-operator.sh

// true when the user has allowed user scripts for FastLink (the API throws otherwise).
export function userScriptsAllowed() {
  try { return typeof chrome.userScripts?.execute === 'function'; } catch { return false; }
}

// Under the tab queue's 29 s cap and the relay's 30 s call limit.
export const EVAL_DEADLINE_MS = 25_000;
export const EVAL_TIMEOUT_MSG = `fast_evaluate: the function did not settle within ${EVAL_DEADLINE_MS / 1000}s`;

export const USER_SCRIPTS_OFF =
  'fast_evaluate is off in this browser. To allow it: chrome://extensions → FastLink → Details → turn on "Allow User Scripts".';

export async function evaluate({ fn, args, tabId }) {
  if (typeof fn !== 'string' || !fn.trim()) return { error: 'fast_evaluate: `fn` must be a function source string' };
  if (!userScriptsAllowed()) return { error: USER_SCRIPTS_OFF, code: 'user_scripts_off' };
  const got = await getInjectableTab(tabId);
  if (got.error) return got;
  const userArgs = Array.isArray(args) ? args : [];
  // The result crosses as a JSON string so the value comes back exactly (key order, nulls).
  // A function that never settles (it awaits something the page never does) answers at
  // EVAL_DEADLINE_MS in the page, like every other page action; only a page whose main
  // thread is frozen is left to the tab queue's cap (tabQueue.js, feedback #24).
  const code = `(async () => { try { const __fn = (${fn}); const v = await Promise.race([__fn(...${JSON.stringify(userArgs)}), new Promise((_, rej) => setTimeout(() => rej(new Error(${JSON.stringify(EVAL_TIMEOUT_MSG)})), ${EVAL_DEADLINE_MS}))]); return JSON.stringify({ ok: v === undefined ? null : v }); } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); } })()`;
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
