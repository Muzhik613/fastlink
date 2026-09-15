// Slots keyed by arbitrary `hello` label → N profiles concurrent. An MCP session
// pins a slot via fast_profile (envelope `install`); "auto" = FASTLINK_ACTIVE
// (default 'primary') then any-connected. Unpinned + >1 slot connected =
// ambiguous → router.js refuses (never lands on the owner's main profile).
// Custom labels learned from `hello` → `slots`.
import { EXT_PORTS } from './config.js';

const LISTENER_INSTALLS = Object.keys(EXT_PORTS);
const ACTIVE = (process.env.FASTLINK_ACTIVE || LISTENER_INSTALLS[0]).toLowerCase();

// A slot's incumbent is "live" if it connected or pinged within this window.
// > the extension's 20s app-ping cycle so one missed ping doesn't read as dead.
const LIVENESS_MS = 30_000;
// Per-slot ring of the last N connect/disconnect/slotBusy events (fast_status
// `recent`), so lifetime `totalConnections` is never read as a burst.
const RECENT_MAX = 20;

const slots = new Map(); // installId -> { ws, lastConnectedAt, lastDisconnectedAt, lastPingAt, totalConnections, recent[] }

function ensureSlot(installId) {
  let s = slots.get(installId);
  if (!s) {
    s = { ws: null, lastConnectedAt: null, lastDisconnectedAt: null, lastPingAt: null, totalConnections: 0, recent: [] };
    slots.set(installId, s);
  }
  return s;
}

// Newest first; {t: ISO, event: 'connect'|'disconnect'|'slotBusy', reason}.
function noteEvent(s, event, reason) {
  s.recent.unshift({ t: new Date().toISOString(), event, reason: reason || null });
  if (s.recent.length > RECENT_MAX) s.recent.length = RECENT_MAX;
}

const ago = (t) => t ? `${Math.round((Date.now() - t) / 1000)}s ago` : 'never';
const isOpen = (s) => !!(s?.ws && s.ws.readyState === 1);

export const state = {
  getActiveInstall() { return ACTIVE; },
  // Fixed listener slots ∪ every custom label seen live this lifetime (tracked
  // in `slots`). Listeners first. Gates routing (router.js) + status output.
  knownInstalls() { return [...new Set([...LISTENER_INSTALLS, ...slots.keys()])]; },
  connectedInstalls() { return [...slots.entries()].filter(([, s]) => isOpen(s)).map(([id]) => id); },

  setExtensionSocket(installId, ws, reason) {
    const s = ensureSlot(installId);
    s.ws = ws;
    s.lastConnectedAt = Date.now();
    s.totalConnections += 1;
    noteEvent(s, 'connect', reason);
  },
  clearExtensionSocket(installId, ws, reason) {
    const s = slots.get(installId);
    if (s && s.ws === ws) {
      s.ws = null;
      s.lastDisconnectedAt = Date.now();
      noteEvent(s, 'disconnect', reason);
    }
  },
  // A newcomer was refused because a live incumbent holds the slot.
  noteSlotBusy(installId, reason) {
    noteEvent(ensureSlot(installId), 'slotBusy', reason);
  },
  notePing(installId) {
    const s = ensureSlot(installId);
    s.lastPingAt = Date.now();
  },
  // "auto" resolution: ACTIVE if connected, else any connected slot, else null.
  // Only used for sessions explicitly pinned to "auto" (router.js) and for the
  // idle watchdog / status; an unpinned session with >1 slot up never gets here.
  getRoutedInstall() {
    if (isOpen(slots.get(ACTIVE))) return ACTIVE;
    for (const [id, s] of slots.entries()) {
      if (isOpen(s)) return id;
    }
    return null;
  },
  getExtensionSocket() {
    const id = state.getRoutedInstall();
    return id ? slots.get(id).ws : null;
  },
  getSocketForInstall(installId) {
    const s = slots.get(installId);
    return s?.ws || null;
  },
  // Is this install slot held by a LIVE socket right now? "Live" = OPEN and
  // showing recent activity (connected or app-pinged within LIVENESS_MS). Used
  // by extBridge to tell a same-slot COLLISION (two live profiles → reject the
  // newcomer) from a SERVICE-WORKER RESPAWN (stale prev socket → adopt the
  // newcomer). The window is generous (> one 20s extension ping cycle) so a
  // briefly-laggy healthy incumbent is never mistaken for dead and evicted —
  // we bias toward protecting a working profile over fast respawn adoption (a
  // truly-dead half-open socket still ages out and gets replaced).
  isInstallLive(installId) {
    const s = slots.get(installId);
    if (!isOpen(s)) return false;
    const last = Math.max(s.lastConnectedAt || 0, s.lastPingAt || 0);
    return Date.now() - last < LIVENESS_MS;
  },
  // Returns every connected socket — used to broadcast badge updates so both
  // installs' badges reflect the same client count.
  *allConnectedSockets() {
    for (const s of slots.values()) {
      if (isOpen(s)) yield s.ws;
    }
  },
  isExtensionConnected() {
    return !!state.getExtensionSocket();
  },
  snapshot() {
    const installs = {};
    for (const id of state.knownInstalls()) {
      const s = slots.get(id);
      installs[id] = {
        connected: isOpen(s),
        totalConnections: s?.totalConnections ?? 0,
        lastConnectedAt: s?.lastConnectedAt ? new Date(s.lastConnectedAt).toISOString() : null,
        lastConnectedAgo: ago(s?.lastConnectedAt),
        lastDisconnectedAgo: ago(s?.lastDisconnectedAt),
        lastPingAgo: ago(s?.lastPingAt),
        recent: s?.recent ? [...s.recent] : [],
      };
    }
    // Top-level fields reflect the "auto" target (routedInstall). With >1 slot
    // connected, `pinRequired:true` says unpinned calls are refused instead.
    const routed = state.getRoutedInstall();
    const routedSnap = routed ? installs[routed] : null;
    const connectedInstalls = state.connectedInstalls();
    return {
      connected: !!routedSnap?.connected,
      totalConnections: routedSnap?.totalConnections ?? 0,
      lastConnectedAt: routedSnap?.lastConnectedAt ?? null,
      lastConnectedAgo: routedSnap?.lastConnectedAgo ?? 'never',
      lastDisconnectedAgo: routedSnap?.lastDisconnectedAgo ?? 'never',
      lastPingAgo: routedSnap?.lastPingAgo ?? 'never',
      activeInstall: ACTIVE,
      routedInstall: routed,
      connectedInstalls,
      pinRequired: connectedInstalls.length > 1,
      installs,
    };
  },
};
