// agentFile.js — this machine's pairing with the relay: { relay, agentToken, name, pairedAt }.
// One file per machine (~/.fastlink/agent.json, dir 0700, file 0600) covers every
// Claude Code session on it. FASTLINK_AGENT_FILE overrides the path (tests).
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_RELAY = 'https://relay.ytx.app';
export const PAIR_URL = `${DEFAULT_RELAY}/pair/new`;

export const agentFilePath = () => process.env.FASTLINK_AGENT_FILE || join(homedir(), '.fastlink', 'agent.json');

// The pairing, or null when this machine isn't paired (missing/unreadable/incomplete file).
export function loadAgent() {
  try {
    const a = JSON.parse(readFileSync(agentFilePath(), 'utf8'));
    return a && typeof a.agentToken === 'string' && typeof a.relay === 'string' ? a : null;
  } catch {
    return null;
  }
}

export function saveAgent(agent) {
  const file = agentFilePath();
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(file, JSON.stringify(agent, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600); // writeFileSync's mode only applies when it creates the file
  return file;
}

// true when a pairing was removed.
export function removeAgent() {
  const file = agentFilePath();
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

// POST /agent/pair {code, name} → {agentToken}. Throws with the relay's message on failure.
export async function pair({ code, name, relay = DEFAULT_RELAY }) {
  const base = relay.replace(/\/+$/, '');
  const res = await fetch(`${base}/agent/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
  const body = await res.text();
  let data = null;
  try { data = JSON.parse(body); } catch { /* not JSON */ }
  if (!res.ok || !data?.agentToken) {
    const why = data?.error_description || data?.error || body.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`pairing failed (${res.status}): ${why}`);
  }
  const agent = { relay: base, agentToken: data.agentToken, name, pairedAt: new Date().toISOString() };
  const file = saveAgent(agent);
  return { agent, file };
}
