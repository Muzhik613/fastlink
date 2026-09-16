import { WebSocketServer } from 'ws';
import { state } from './state.js';
import { EXT_PORTS, EXT_BIND } from './config.js';
import { log, onFatalListenError } from './lifecycle.js';
import { onExtensionResponse, failPendingForSocket } from './router.js';
import { mcpClientCount } from './mcpBridge.js';
import { attachHeartbeat, startHeartbeatLoop } from './heartbeat.js';

// Binds EXT_PORTS. 'primary' 9876 = shared port for custom labels (demuxed by
// `hello` label → N profiles/port); 'secondary' 9877 + no-hello → port default.

// 2s grace for {type:'hello', installId}; absent → port default.
const HELLO_TIMEOUT_MS = 2_000;

// Slot key: lowercase [a-z0-9_-], alnum first, ≤32. null → port default.
function sanitizeInstallId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[-_]+/, '').slice(0, 32);
  return id || null;
}
// Build id from the hello (git short sha / "dev"); null for an older extension.
function sanitizeBuild(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(raw) ? raw : null;
}

const extSockets = {
  *[Symbol.iterator]() { yield* state.allConnectedSockets(); },
};

export function startExtBridge() {
  log(`ext listeners bind ${EXT_BIND.host} — ${EXT_BIND.reason}`);
  startHeartbeatLoop(extSockets);
  for (const [defaultId, port] of Object.entries(EXT_PORTS)) {
    startOne(defaultId, port);
  }
}

function startOne(defaultId, port) {
  // Host per config.js EXT_BIND: 0.0.0.0 only under WSL (the extension falls
  // back to the WSL VM IP when localhost-forwarding dies after a host sleep;
  // WSL2 NAT keeps that off the LAN), loopback everywhere else.
  const wss = new WebSocketServer({ port, host: EXT_BIND.host });
  wss.on('listening', () => log(`ext WS listening on ${port} (default install: ${defaultId})`));
  wss.on('error', (e) => onFatalListenError('ext', port, e));
  wss.on('connection', (ws, req) => {
    log(`ext socket opened on :${port} from ${req.socket.remoteAddress}`);
    let installId = null;
    const helloTimer = setTimeout(() => {
      if (installId) return;
      log(`no hello on :${port}, defaulting to install "${defaultId}"`);
      assign(defaultId, ws, 'no-hello-default');
    }, HELLO_TIMEOUT_MS);

    // `reason` rides into the slot's recent[] ring + the log line; `build` into the slot.
    function assign(id, socket, reason, build = null) {
      if (installId) return;
      // Same-slot arbitration. A prior socket on this install is EITHER a stale
      // socket from a service-worker respawn (adopt the newcomer, replace it) OR
      // a second live Chrome profile that defaulted to the same slot (a real
      // COLLISION — must NOT evict the incumbent, or both profiles ping-pong the
      // slot in an endless reconnect war). isInstallLive() distinguishes them.
      const prevForId = state.getSocketForInstall(id);
      if (prevForId && prevForId !== socket && state.isInstallLive(id)) {
        // Live incumbent owns the slot → tell the newcomer to switch slots and
        // close it, leaving the working profile untouched.
        log(`slotBusy install="${id}" — live incumbent holds the slot; rejecting newcomer on :${port} from ${req.socket.remoteAddress}`);
        state.noteSlotBusy(id, `newcomer on :${port} rejected, live incumbent`);
        socket.__closeReason = 'slotBusy';
        try { socket.send(JSON.stringify({ type: 'slotBusy', install: id, knownInstalls: state.knownInstalls() })); } catch {}
        // Give the frame a tick to flush before closing.
        setTimeout(() => { try { socket.close(); } catch {} }, 50);
        return; // do NOT adopt — installId stays null so this socket owns no slot
      }
      installId = id;
      // Stale prev (respawn) → replace. Distinct labels = distinct slots even on
      // shared port 9876, so cross-install never collides.
      if (prevForId && prevForId !== socket) {
        prevForId.__closeReason ||= 'replaced by respawn';   // keeps an earlier reason (ext-reload)
        reason += ' (replaced stale socket)';
        try { prevForId.close(); } catch {}
      }
      state.setExtensionSocket(id, socket, reason, build);
      log(`connect install="${id}" on :${port} reason=${reason} build=${build ?? 'n/a'}`);
      attachHeartbeat(socket);
      try { socket.send(JSON.stringify({ type: 'mcpClients', count: mcpClientCount() })); } catch {}
    }

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'hello' && typeof msg.installId === 'string') {
        clearTimeout(helloTimer);
        // Sanitizable label → dynamic slot; empty/garbage → port default.
        const id = sanitizeInstallId(msg.installId);
        const build = sanitizeBuild(msg.build);
        log(`hello install="${id ?? defaultId}" raw="${msg.installId}" build=${build ?? 'n/a'} on :${port}`);
        if (!id) {
          log(`unusable installId "${msg.installId}" on :${port}, falling back to "${defaultId}"`);
          assign(defaultId, ws, `hello unusable "${msg.installId}" → port default`, build);
        } else {
          assign(id, ws, 'hello', build);
        }
        return;
      }
      if (msg.ping) {
        if (installId) state.notePing(installId);
        // Echo a pong so the extension can detect a half-open socket (no inbound
        // for >N ping cycles => dead path) and self-heal. Additive + backward
        // compatible: older extensions ignore unknown inbound frames.
        try { ws.send(JSON.stringify({ pong: true })); } catch {}
        return;
      }
      onExtensionResponse(msg);
    });
    ws.on('close', (code, reasonBuf) => {
      clearTimeout(helloTimer);
      // 1006 = no close frame (SW killed, WSL forwarding died, heartbeat terminate).
      const reason = ws.__closeReason || `close ${code}${reasonBuf?.length ? ' ' + reasonBuf : ''}`;
      if (installId) {
        state.clearExtensionSocket(installId, ws, reason);
        log(`disconnect install="${installId}" on :${port} reason=${reason}`);
      } else {
        log(`ext socket closed on :${port} before owning a slot reason=${reason}`);
      }
      failPendingForSocket(ws);
    });
    ws.on('error', (e) => log(`ext ws error on :${port}: ${e.message}`));
  });
}
