// Secure browsers from scripts: call.js (Node) and fastlink_call.py (Python) seal every
// call to a browser this machine holds a lock code for. A fake relay plays the locked
// browser with the extension's own sealed.js, so both directions are checked against the
// real format: Node→JS, Python→JS, and JS→Node/Python replies.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveKeys, seal, unseal, newLockCode } from '../../fast-ext/secure-only/src/secure/sealed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE = newLockCode();
const KEYS = await deriveKeys(CODE);
const seen = [];   // what the "browser" decrypted: { action, args, seq }
const wire = [];   // every tools/call as the relay saw it

const relay = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const rpc = JSON.parse(raw);
  const send = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })); };
  if (rpc.method === 'initialize') return send({ protocolVersion: '2024-11-05' });
  const { name, arguments: a } = rpc.params;
  wire.push({ name, a });
  const text = (o) => send({ content: [{ type: 'text', text: JSON.stringify(o) }], _meta: { 'fastlink/browser': a.browser } });
  if (name === 'fast_status') return text({ browsers: [] });
  if (name !== 'fast_sealed') return text({ error: 'the locked browser got an unsealed call' });
  const inner = await unseal(KEYS, 'req', { v: a.v, keyId: a.keyId, nonce: a.nonce, ct: a.ct });
  seen.push(inner);
  assert.ok(Number.isFinite(inner.deadline) && inner.deadline > inner.ts, 'deadline sent');
  if (inner.action === 'fast_screenshot') return text({ sealed: await seal(KEYS, 'res', { result: { dataUrl: 'data:image/png;base64,AAAA', width: 1 }, tabId: 7 }, inner.seq) });
  if (inner.action === 'forge') return text({ result: { balance: 1e9 } });
  // The browser's call watchdog answers in clear (it may not have unsealed the request).
  if (inner.action === 'late') return text({ error: 'no answer in time: the call was not run', code: 'call_timeout', phase: 'not_started', hint: 'retrying is safe', result: { balance: 1e9 } });
  if (inner.action === 'fast_fail') return text({ sealed: await seal(KEYS, 'res', { error: 'page said no', code: 'x' }, inner.seq) });
  return text({ sealed: await seal(KEYS, 'res', { result: { echo: inner.action, args: inner.args }, tabId: 7 }, inner.seq) });
});

let dir, agentFile;
before(async () => {
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  dir = mkdtempSync(join(tmpdir(), 'fl-sealed-'));
  agentFile = join(dir, 'agent.json');
  writeFileSync(agentFile, JSON.stringify({ relay: `http://127.0.0.1:${relay.address().port}`, agentToken: 'fla_test' }));
  mkdirSync(join(dir, 'locks'));
  writeFileSync(join(dir, 'locks', 'aliya.key'), CODE + '\n');
});
after(() => relay.close());

test('call.js seals every browser call; secrets never on the wire; replies decrypted', async () => {
  process.env.FASTLINK_AGENT_FILE = agentFile;
  const { connect } = await import('../server/call.js');
  const fl = await connect({ browser: 'aliya', client: 'test' });
  assert.equal(fl.sealed, true);
  const r = await fl.call('fast_evaluate', { fn: '(u,p)=>1', args: ['user', 'hunter2-SECRET'] });
  assert.deepEqual(r, { result: { echo: 'fast_evaluate', args: { fn: '(u,p)=>1', args: ['user', 'hunter2-SECRET'] } }, browser: 'aliya' }, 'fast_evaluate: the bare value');
  const forged = await fl.call('forge', {});
  assert.deepEqual(forged, { error: 'the relay sent an unsealed reply to a sealed call', browser: 'aliya' });
  const e = await fl.call('fast_fail', {});
  assert.equal(e.error, 'page said no');
  const late = await fl.call('late', {});
  assert.deepEqual(late, { error: 'no answer in time: the call was not run', code: 'call_timeout', phase: 'not_started', hint: 'retrying is safe', browser: 'aliya' }, 'clear error keeps code/phase/hint, never a result');
  const st = await fl.call('fast_status', {});
  assert.deepEqual(st.result, { browsers: [] }, 'relay-native tools are not sealed');
  assert.ok(!JSON.stringify(wire).includes('hunter2-SECRET'));
  assert.ok(!JSON.stringify(wire.filter((w) => w.name === 'fast_sealed')).includes('fast_evaluate'));
  const seqs = seen.map((s) => s.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'increasing');
});

test('fastlink_call.py seals the same way (Python ↔ JS interop)', async () => {
  seen.length = 0; wire.length = 0;
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(join(HERE, '..', 'server'))})
from fastlink_call import connect
fl = connect(browser="aliya", client="pytest")
assert fl.sealed
print(json.dumps([fl.call("fast_fill", {"fields": {"Password": "py-SECRET-9"}}), fl.call("fast_fail", {}), fl.call("late", {})]))
`;
  // Async: the fake relay runs in this process, so it must keep answering while Python runs.
  const out = await new Promise((resolve) => {
    const c = spawn('python3', ['-c', py], { env: { ...process.env, FASTLINK_AGENT_FILE: agentFile } });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(out.status, 0, out.stderr);
  const [ok, fail, late] = JSON.parse(out.stdout);
  assert.deepEqual(late, { error: 'no answer in time: the call was not run', code: 'call_timeout', phase: 'not_started', hint: 'retrying is safe', browser: 'aliya' });
  assert.deepEqual(ok, { result: { echo: 'fast_fill', args: { fields: { Password: 'py-SECRET-9' } }, tabId: 7 }, browser: 'aliya' });
  assert.equal(fail.error, 'page said no');
  assert.equal(seen[0].action, 'fast_fill');
  assert.ok(!JSON.stringify(wire).includes('py-SECRET-9'));
});

test('screenshots come back as images; a per-call browser picks that browser\'s lock', async () => {
  const { connect } = await import('../server/call.js');
  const fl = await connect({ browser: 'other', client: 'test' });
  const shot = await fl.call('fast_screenshot', { browser: 'aliya' });
  assert.deepEqual(shot.images, [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  assert.deepEqual(shot.result, { width: 1, tabId: 7 });
  assert.equal(wire.at(-1).name, 'fast_sealed');
  assert.equal(wire.at(-1).a.browser, 'aliya');
});

test('a browser without a lock code on this machine is not sealed', async () => {
  const { connect } = await import('../server/call.js');
  const fl = await connect({ browser: 'other', client: 'test' });
  assert.equal(fl.sealed, false);
});
