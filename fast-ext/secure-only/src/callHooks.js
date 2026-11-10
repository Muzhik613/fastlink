// callHooks.js — SECURE BUILD version (scripts/build-secure.sh installs it over the normal
// src/callHooks.js; owner notes: secure-only/README.md). Same exports as the normal file.
//
// Sealed calls only (./secure/lock.js): every unsealed call, and every call before a lock
// is set, is refused. The lock is read once at start and again whenever the options page
// (or a sealed set_allowlist) changes it; the hello tells the relay whether this browser
// is locked and whether page JavaScript (fast_evaluate, which exists only here) is on.
import { loadLock, isLocked, lockKeyId, evaluateState, userScriptsAllowed, handleSealed, refuseUnsealed, STORE_KEY as LOCK_STORE } from './secure/lock.js';
import { evaluate } from './secure/evaluate.js';

let lockReady = loadLock();

// Chrome's "Allow User Scripts" switch fires no event, so it is re-read on this period
// and the hello is re-sent when it flips.
const USER_SCRIPTS_CHECK_MS = 30_000;

// `onChange()` re-sends the hello after the lock settings or the user-scripts switch change.
export function initCallHooks(onChange) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[LOCK_STORE]) return;
      lockReady = loadLock().then(onChange);
    });
  } catch {}
  let usOn = userScriptsAllowed();
  setInterval(() => {
    const now = userScriptsAllowed();
    if (now !== usOn) { usOn = now; onChange(); }
  }, USER_SCRIPTS_CHECK_MS);
}

// The hello waits for the lock to be read, so it reports the real lock state.
export function whenReady(fn) { lockReady.then(fn); }

export function helloFields() {
  return { secure: true, locked: isLocked(), keyId: lockKeyId(), evaluate: evaluateState(userScriptsAllowed()) };
}

// The sealed reply carries no origin/tabId in clear, so the relay learns nothing about the page.
export async function runCall(msg, submit, resolveTarget) {
  await lockReady;
  return msg.action === 'fast_sealed'
    ? handleSealed(msg.args, submit, resolveTarget)
    : refuseUnsealed();
}

// The panel lives in the page's DOM: never put call arguments or error text there.
export const showCallDetails = false;

export const extraActions = { fast_evaluate: evaluate };
