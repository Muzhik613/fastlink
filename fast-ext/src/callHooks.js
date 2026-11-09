// callHooks.js — how a relay call reaches the tab queue, and what the hello reports.
// relayClient.js and actions/index.js call these; this module runs every call as sent.

// `onChange()` re-sends the hello; nothing here changes, so it is never called.
export function initCallHooks(_onChange) {}

// Run `fn` once the hooks are ready (now).
export function whenReady(fn) { fn(); }

// Extra fields for the hello frame.
export function helloFields() { return {}; }

// Run one relay call: `submit(action, args)` queues it on its tab.
export function runCall(msg, submit, _resolveTarget) {
  return submit(msg.action, msg.args || {});
}

// The on-page panel shows each call's arguments and error text.
export const showCallDetails = true;

// Tools beyond the built-in set: { action: (args) => reply }.
export const extraActions = {};
