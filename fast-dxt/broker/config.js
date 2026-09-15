import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';

// Ports. Defaults are the shared production instance; FASTLINK_BROKER_PORT
// (mcp, same var the server reads) + FASTLINK_EXT_PORTS ("9876,9877") give a
// throwaway broker for tests. A non-default mcp port also suffixes the pid/log
// files and skips the cloudflared tunnel so it never clobbers the live broker.
const DEFAULT_MCP_PORT = 9870;
export const MCP_PORT = parseInt(process.env.FASTLINK_BROKER_PORT, 10) || DEFAULT_MCP_PORT;

// 'primary' 9876 = shared port for all custom labels (demuxed by hello label);
// 'secondary' 9877 = legacy. Port key = default install for no/blank-hello builds.
const extPorts = (process.env.FASTLINK_EXT_PORTS || '9876,9877').split(',').map(p => parseInt(p, 10));
export const EXT_PORTS = { primary: extPorts[0] || 9876, secondary: extPorts[1] || 9877 };

// Ext listener bind address. 0.0.0.0 is needed ONLY under WSL, where Windows
// Chrome falls back to the WSL VM IP when localhost-forwarding breaks (CLAUDE.md
// networking notes). Anywhere else (hvm rig, a container) it would expose an
// unauthenticated browser bridge to the LAN → loopback. FASTLINK_BROKER_BIND
// overrides. Pure resolver so the rule is unit-testable.
export function resolveExtBind(env = process.env, procVersion = '') {
  if (env.FASTLINK_BROKER_BIND) return { host: env.FASTLINK_BROKER_BIND, reason: 'FASTLINK_BROKER_BIND' };
  if (/microsoft|wsl/i.test(procVersion)) return { host: '0.0.0.0', reason: 'WSL detected in /proc/version (Windows Chrome may dial the VM IP)' };
  return { host: '127.0.0.1', reason: 'not WSL — loopback only' };
}
function procVersion() { try { return readFileSync('/proc/version', 'utf8'); } catch { return ''; } }
export const EXT_BIND = resolveExtBind(process.env, procVersion());

export const IS_DEFAULT_INSTANCE = MCP_PORT === DEFAULT_MCP_PORT;
const suffix = IS_DEFAULT_INSTANCE ? '' : `-${MCP_PORT}`;

// os.tmpdir() = %TEMP% on Windows, /tmp on macOS/Linux/WSL → portable.
export const PID_FILE = join(tmpdir(), `fastlink-broker${suffix}.pid`);
// One append-only log for the broker's own lines AND its stdout/stderr (the
// server spawns it with both fds pointed here — see server/brokerClient.js).
export const LOG_FILE = join(tmpdir(), `fastlink-broker${suffix}.log`);
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
