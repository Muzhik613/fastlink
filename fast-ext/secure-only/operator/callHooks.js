// callHooks.js — the OPERATOR build (scripts/build-operator.sh): the normal build plus
// fast_evaluate (secure-only/src/secure/evaluate.js). Only for browsers of an account the
// relay flags users.allow_evaluate (mac1/mac2, 11-10); never in the CRX, feed or Web Store.
// Calls run unsealed, exactly as in the normal build; the hello says evaluate:"on" or why
// not, and the relay lists and forwards fast_evaluate only when it says "on".
import { evaluate, userScriptsAllowed } from './secure/evaluate.js';

const USER_SCRIPTS_CHECK_MS = 30_000;
const EVAL_OFF_USER_SCRIPTS = 'off: turn on "Allow User Scripts" (chrome://extensions → FastLink → Details)';

// `onChange()` re-sends the hello when Chrome's "Allow User Scripts" switch flips.
export function initCallHooks(onChange) {
  let on = userScriptsAllowed();
  setInterval(() => {
    const now = userScriptsAllowed();
    if (now !== on) { on = now; onChange(); }
  }, USER_SCRIPTS_CHECK_MS);
}

export function whenReady(fn) { fn(); }

export function helloFields() { return { evaluate: userScriptsAllowed() ? 'on' : EVAL_OFF_USER_SCRIPTS }; }

export function runCall(msg, submit, _resolveTarget) {
  return submit(msg.action, msg.args || {});
}

export const showCallDetails = true;

export const extraActions = { fast_evaluate: evaluate };
