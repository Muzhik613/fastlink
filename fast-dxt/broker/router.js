import { randomUUID } from 'crypto';
import { state } from './state.js';
import { log } from './lifecycle.js';

const REQUEST_TIMEOUT_MS = 30_000;
const pending = new Map();

// Resolve the ext socket for a call. `install` (envelope, set by fast_profile):
//   label  → exactly that slot, no fallback (BUG-5): unreachable = clear error.
//   'auto' → ACTIVE-then-any-connected (explicit opt-in only).
//   absent → one slot connected: use it. >1: refuse and name them — a session
//            that never pinned must not land on someone else's profile.
function resolveSocket(install) {
  if (install && install !== 'auto') {
    if (!state.knownInstalls().includes(install)) {
      return { error: `Unknown install "${install}". Known installs: ${state.knownInstalls().join(', ')}.` };
    }
    const ext = state.getSocketForInstall(install);
    if (!ext || ext.readyState !== 1) {
      return {
        error: `Install "${install}" is not connected — open/reload FastLink in that Chrome profile, or switch to a connected slot with fast_profile.`,
        routedInstall: null,
        installs: state.snapshot().installs,
      };
    }
    return { ext };
  }
  const connected = state.connectedInstalls();
  if (!connected.length) return { error: 'Chrome extension not connected.' };
  if (install !== 'auto' && connected.length > 1) {
    return {
      error: `${connected.length} Chrome profiles are connected (${connected.join(', ')}) and this session has not pinned one — call fast_profile {install:"<label>"} first (or install:"auto" for the active slot "${state.getRoutedInstall()}").`,
      routedInstall: null,
      connectedInstalls: connected,
      installs: state.snapshot().installs,
    };
  }
  return { ext: state.getExtensionSocket() };
}

export function dispatchCall(mcpClient, mcpId, action, args, install) {
  const { ext, ...refusal } = resolveSocket(install);
  if (!ext) return reply(mcpClient, mcpId, refusal);
  const extId = randomUUID();
  const timer = setTimeout(() => {
    if (!pending.has(extId)) return;
    pending.delete(extId);
    reply(mcpClient, mcpId, { error: `Timeout waiting for browser response (${REQUEST_TIMEOUT_MS}ms)` });
  }, REQUEST_TIMEOUT_MS);
  // Track which socket sent this so a stale socket's close doesn't fail requests
  // routed via a fresh one (extension service workers respawn).
  pending.set(extId, { mcpClient, mcpId, timer, socket: ext });
  try {
    ext.send(JSON.stringify({ id: extId, action, args: args || {} }));
  } catch (e) {
    pending.delete(extId);
    clearTimeout(timer);
    reply(mcpClient, mcpId, { error: `Send to extension failed: ${e.message}` });
  }
}

export function onExtensionResponse(msg) {
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  clearTimeout(entry.timer);
  reply(entry.mcpClient, entry.mcpId, msg);
}

export function failPendingForSocket(socket) {
  for (const [extId, entry] of pending) {
    if (entry.socket !== socket) continue;
    clearTimeout(entry.timer);
    pending.delete(extId);
    reply(entry.mcpClient, entry.mcpId, { error: 'Extension disconnected before response' });
  }
}

export function dropPendingForClient(mcpClient) {
  for (const [extId, entry] of pending) {
    if (entry.mcpClient !== mcpClient) continue;
    clearTimeout(entry.timer);
    pending.delete(extId);
  }
}

function reply(mcpClient, mcpId, payload) {
  if (!mcpClient || mcpClient.readyState !== 1) return;
  // Pass through every field except the routing id — preserves diagnostics,
  // available, headers, screenshot, etc. on error/success payloads.
  const { id, ...rest } = payload || {};
  try { mcpClient.send(JSON.stringify({ type: 'result', id: mcpId, ...rest })); }
  catch (e) { log(`reply send failed: ${e.message}`); }
}
