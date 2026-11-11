// node --test — every way a stdio helper ends leaves a line in its log FILE, because stderr
// is often gone by then (Alex b1 11-11: a helper vanished overnight, nothing in the MCP log).
// Real processes; FASTLINK_AGENT_FILE points at a missing file, so no relay is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.js');

function start() {
  const dir = mkdtempSync(join(tmpdir(), 'fastlink-deathlog-'));
  const logFile = join(dir, 'helper.log');
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, FASTLINK_AGENT_FILE: join(dir, 'missing.json'), FASTLINK_LOG_FILE: logFile },
  });
  const up = new Promise((r) => child.stdout.once('data', r));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const read = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
  return { child, up, exited, read };
}

test('closing stdin is logged to the file with the reason', async () => {
  const h = start();
  await h.up;
  assert.match(h.read(), /helper 2\.\d+\.\d+ up \(node v/);
  h.child.stdin.end();
  await h.exited;
  assert.match(h.read(), /exiting: stdin (ended|closed)/);
  assert.match(h.read(), /exit code 0 after/);
});

test('SIGTERM is logged to the file', async () => {
  const h = start();
  await h.up;
  h.child.kill('SIGTERM');
  await h.exited;
  assert.match(h.read(), /exiting: got SIGTERM/);
});
