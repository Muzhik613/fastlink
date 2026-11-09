// callHooks.js — SECURE BUILD version (scripts/build-secure.sh installs it over the normal
// src/callHooks.js; owner notes: secure-only/README.md). Same exports as the normal file.
//
// Sealed calls only (./secure/lock.js): every unsealed call, and every call before a lock
// is set, is refused. The lock is read once at start and again whenever the options page
// (or a sealed set_allowlist) changes it; the hello tells the relay whether this browser
// is locked. Page JavaScript (fast_evaluate) exists only here.
import { loadLock, isLocked, lockKeyId, handleSealed, refuseUnsealed, STORE_KEY as LOCK_STORE } from './secure/lock.js';
import { evaluate } from './secure/evaluate.js';

let lockReady = loadLock();

// `onChange()` re-sends the hello after the lock settings change.
export function initCallHooks(onChange) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[LOCK_STORE]) return;
      lockReady = loadLock().then(onChange);
    });
  } catch {}
}

// The hello waits for the lock to be read, so it reports the real lock state.
export function whenReady(fn) { lockReady.then(fn); }

export function helloFields() {
  return { secure: true, locked: isLocked(), keyId: lockKeyId() };
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
