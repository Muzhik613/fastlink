// node --test — a stdio MCP server must die with its parent, however the parent dies.
// Real processes, no mocks: a parent spawns server/index.js on a stdio pipe, the test
// SIGKILLs the parent (no cleanup handler can run), and the orphaned server must be
// gone within a few seconds. hvm 2026-09-16: 350 orphans, 10.5 GB, before this held.
//
// Isolation: FASTLINK_BROKER_PORT points at a throwaway WebSocket server this test
// owns, so the child's startup getStatus() connects there — it never reaches the live
// broker on 9870 and never spawns a detached broker of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.js');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return pred();
};

test('a stdio server exits when its parent is SIGKILLed', async (t) => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  let connected = false;
  wss.on('connection', () => { connected = true; });   // accept, never answer: no broker needed
  t.after(() => wss.close());

  const parentSrc = `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, [${JSON.stringify(SERVER)}], { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
    process.stdout.write(String(c.pid) + '\\n');
    setInterval(() => {}, 1 << 30);
  `;
  const parent = spawn(process.execPath, ['-e', parentSrc], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, FASTLINK_BROKER_PORT: String(wss.address().port), FASTLINK_HTTP: '', FASTLINK_HOTRELOAD: '' },
  });
  const childPid = await new Promise((resolve, reject) => {
    let buf = '';
    parent.stdout.on('data', (d) => { buf += d; const m = buf.match(/^(\d+)\n/); if (m) resolve(Number(m[1])); });
    parent.on('exit', () => reject(new Error('parent exited before reporting the child pid')));
  });
  t.after(() => { if (alive(childPid)) process.kill(childPid, 'SIGKILL'); if (alive(parent.pid)) process.kill(parent.pid, 'SIGKILL'); });

  assert.ok(await waitFor(() => connected, 10_000), 'server started and dialed the (fake) broker');
  assert.ok(alive(childPid), 'server stays up while its parent lives');

  process.kill(parent.pid, 'SIGKILL');
  assert.ok(await waitFor(() => !alive(childPid), 5_000), `server pid ${childPid} outlived its SIGKILLed parent`);
});
