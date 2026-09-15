// node --test — broker routing / connection-history / log against fakes, then a
// throwaway broker on non-default ports (never the live 9870/9876/9877 instance).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';

// Throwaway instance: suffixed pid/log files, tunnel skipped (broker/config.js).
process.env.FASTLINK_BROKER_PORT = '19870';
process.env.FASTLINK_EXT_PORTS = '19876,19877';
const { state } = await import('../broker/state.js');
const { dispatchCall, dispatchReload, onExtensionResponse } = await import('../broker/router.js');
const { LOG_FILE, PID_FILE, resolveExtBind } = await import('../broker/config.js');

const fakeWs = () => ({ readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); } });

test('config: ext bind = env override → 0.0.0.0 under WSL → loopback elsewhere', () => {
  const wsl = 'Linux version 6.6.87.2-microsoft-standard-WSL2 (root@x) #1 SMP';
  assert.deepEqual(resolveExtBind({}, wsl), { host: '0.0.0.0', reason: 'WSL detected in /proc/version (Windows Chrome may dial the VM IP)' });
  assert.equal(resolveExtBind({}, 'Linux version 6.8.0-45-generic (buildd@lcy02) #45-Ubuntu').host, '127.0.0.1');
  assert.equal(resolveExtBind({}, '').host, '127.0.0.1', 'no /proc/version (macOS/Windows) → loopback');
  assert.deepEqual(resolveExtBind({ FASTLINK_BROKER_BIND: '10.0.0.5' }, wsl), { host: '10.0.0.5', reason: 'FASTLINK_BROKER_BIND' });
  assert.equal(resolveExtBind({ FASTLINK_BROKER_BIND: '' }, '').host, '127.0.0.1', 'empty override ignored');
});

test('state: per-slot recent ring keeps the last 20 events newest-first with reasons', () => {
  const ws = fakeWs();
  for (let i = 0; i < 12; i++) {
    state.setExtensionSocket('ringtest', ws, `hello#${i}`);
    state.clearExtensionSocket('ringtest', ws, `close 1006#${i}`);
  }
  state.noteSlotBusy('ringtest', 'newcomer rejected');
  const snap = state.snapshot().installs.ringtest;
  assert.equal(snap.totalConnections, 12);
  assert.equal(snap.recent.length, 20);
  assert.deepEqual(snap.recent[0], { t: snap.recent[0].t, event: 'slotBusy', reason: 'newcomer rejected' });
  assert.match(snap.recent[0].t, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snap.recent[1].event, 'disconnect');
  assert.equal(snap.recent[1].reason, 'close 1006#11');
  assert.equal(snap.recent[2].event, 'connect');
  assert.equal(snap.recent[2].reason, 'hello#11');
});

test('router: one slot → routes unpinned; two slots → unpinned refused, auto + label route', () => {
  const primary = fakeWs(), work = fakeWs(), mcp = fakeWs();
  state.setExtensionSocket('primary', primary, 'hello');
  dispatchCall(mcp, 'a', 'fast_snapshot', {}, undefined);
  assert.equal(primary.sent.length, 1, 'single connected slot serves an unpinned call');

  state.setExtensionSocket('work', work, 'hello');
  assert.deepEqual(state.snapshot().connectedInstalls, ['primary', 'work']);
  assert.equal(state.snapshot().pinRequired, true);
  dispatchCall(mcp, 'b', 'fast_snapshot', {}, undefined);
  const refusal = mcp.sent.at(-1);
  assert.equal(refusal.id, 'b');
  assert.match(refusal.error, /2 Chrome profiles are connected \(primary, work\)/);
  assert.match(refusal.error, /fast_profile \{install:"<label>"\}/);
  assert.deepEqual(refusal.connectedInstalls, ['primary', 'work']);
  assert.equal(primary.sent.length, 1, 'unpinned call did NOT land on primary');
  assert.equal(work.sent.length, 0);

  dispatchCall(mcp, 'c', 'fast_snapshot', {}, 'auto');
  assert.equal(primary.sent.length, 2, 'explicit auto → ACTIVE slot');
  dispatchCall(mcp, 'd', 'fast_snapshot', {}, 'work');
  assert.equal(work.sent.length, 1, 'label pin → that slot');

  state.clearExtensionSocket('work', work, 'close 1000');
  dispatchCall(mcp, 'e', 'fast_snapshot', {}, 'work');
  assert.match(mcp.sent.at(-1).error, /Install "work" is not connected/);
  state.clearExtensionSocket('primary', primary, 'close 1000');
  dispatchCall(mcp, 'f', 'fast_snapshot', {}, undefined);
  assert.equal(mcp.sent.at(-1).error, 'Chrome extension not connected.');
  // Ack the routed calls so their 30s timeout timers don't hold the runner open.
  for (const m of [...primary.sent, ...work.sent]) onExtensionResponse({ id: m.id, result: 1 });
});

test('state: hello build lands in the snapshot; awaitHello resolves on the next connect or null on timeout', async () => {
  const ws = fakeWs();
  state.setExtensionSocket('buildtest', ws, 'hello', 'abc1234');
  assert.equal(state.snapshot().installs.buildtest.build, 'abc1234');
  assert.equal(state.getBuild('buildtest'), 'abc1234');
  assert.equal(await state.awaitHello('buildtest', 30), null, 'no connect → null');
  const p = state.awaitHello('buildtest', 5000);
  state.setExtensionSocket('buildtest', fakeWs(), 'hello', 'def5678');
  assert.deepEqual(await p, { build: 'def5678' });
  state.clearExtensionSocket('buildtest', ws, 'close 1000');
});

test('router: ext-reload refuses unpinned/auto, sends {type:reload} to the pinned slot and answers on its next hello', async () => {
  const mcp = fakeWs(), old = fakeWs();
  state.setExtensionSocket('reloadme', old, 'hello', 'v1');
  await dispatchReload(mcp, 'r0', undefined);
  assert.match(mcp.sent.at(-1).error, /pinned to ONE profile label/);
  await dispatchReload(mcp, 'r1', 'auto');
  assert.match(mcp.sent.at(-1).error, /pinned to ONE profile label/);
  await dispatchReload(mcp, 'r2', 'nosuch');
  assert.match(mcp.sent.at(-1).error, /Unknown install "nosuch"/);
  assert.equal(old.sent.length, 0, 'refusals send nothing to the extension');

  const done = dispatchReload(mcp, 'r3', 'reloadme');
  assert.deepEqual(old.sent.at(-1), { type: 'reload' });
  assert.equal(old.__closeReason, 'reload requested (fast_ext_reload)');
  state.clearExtensionSocket('reloadme', old, old.__closeReason);
  state.setExtensionSocket('reloadme', fakeWs(), 'hello', 'v2');
  await done;
  const r = mcp.sent.at(-1);
  assert.equal(r.id, 'r3');
  assert.equal(r.result.reloaded, true);
  assert.equal(r.result.build, 'v2');
  assert.equal(r.result.previousBuild, 'v1');
  assert.ok(typeof r.result.ms === 'number');
});

// ── throwaway broker ──
const here = dirname(fileURLToPath(import.meta.url));
let broker;
after(() => { try { broker?.kill(); } catch {} for (const f of [LOG_FILE, PID_FILE]) rmSync(f, { force: true }); });

const open = (url) => new Promise((res, rej) => { const s = new WebSocket(url); s.once('open', () => res(s)); s.once('error', rej); });
const next = (ws) => new Promise((res) => ws.once('message', (d) => res(JSON.parse(d.toString()))));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)); } };
// An ext fake that says hello (with a build id) and echoes every call as
// {id, result:{via:label}}; on {type:'reload'} it drops the socket and re-dials
// 300ms later as build "<build>.1", like a real SW reload.
const respawned = [];
async function fakeExt(label, build = 'v1') {
  const ws = await open('ws://127.0.0.1:19876');
  ws.send(JSON.stringify({ type: 'hello', installId: label, build }));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'reload') { ws.close(1001, 'reloading'); setTimeout(() => fakeExt(label, build + '.1').then((s) => respawned.push(s)), 300); return; }
    if (m.id && m.action) ws.send(JSON.stringify({ id: m.id, result: { via: label } }));
  });
  return ws;
}
const rpc = (mcp, msg) => { const id = Math.random().toString(36).slice(2); const p = new Promise((res) => { const h = (d) => { const m = JSON.parse(d.toString()); if (m.id === id) { mcp.off('message', h); res(m); } }; mcp.on('message', h); }); mcp.send(JSON.stringify({ ...msg, id })); return p; };

test('throwaway broker: log file records hello/connect/disconnect with reasons; status carries recent[]; unpinned call refused with 2 slots', async () => {
  rmSync(LOG_FILE, { force: true });
  broker = spawn(process.execPath, [join(here, '..', 'broker', 'index.js')], { env: { ...process.env }, stdio: 'ignore' });
  await until(() => existsSync(LOG_FILE) && readFileSync(LOG_FILE, 'utf8').includes('broker ready'));
  assert.ok(readFileSync(LOG_FILE, 'utf8').includes('ext WS listening on 19876'));

  const mcp = await open('ws://127.0.0.1:19870');
  const p = await fakeExt('primary');
  await until(async () => (await rpc(mcp, { type: 'status' })).data.installs.primary?.connected);
  assert.deepEqual((await rpc(mcp, { type: 'call', action: 'fast_snapshot', args: {} })).result, { via: 'primary' }, 'one slot → unpinned routes');

  const w = await fakeExt('work');
  await until(async () => (await rpc(mcp, { type: 'status' })).data.installs.work?.connected);
  const refused = await rpc(mcp, { type: 'call', action: 'fast_snapshot', args: {} });
  assert.match(refused.error, /2 Chrome profiles are connected \(primary, work\)/);
  assert.deepEqual((await rpc(mcp, { type: 'call', action: 'fast_snapshot', args: {}, install: 'work' })).result, { via: 'work' });
  assert.deepEqual((await rpc(mcp, { type: 'call', action: 'fast_snapshot', args: {}, install: 'auto' })).result, { via: 'primary' });

  // slotBusy: a second live "work" newcomer is rejected and told so.
  const dup = await open('ws://127.0.0.1:19876');
  const busyMsg = next(dup);
  dup.send(JSON.stringify({ type: 'hello', installId: 'work' }));
  assert.equal((await busyMsg).type, 'slotBusy');

  w.close(1000, 'test done');
  // readyState flips to CLOSING before the broker's 'close' handler runs → poll the ring, not `connected`.
  const status = await until(async () => { const s = (await rpc(mcp, { type: 'status' })).data; return s.installs.work.recent[0]?.event === 'disconnect' && s; });
  assert.equal(status.pinRequired, false);
  assert.deepEqual(status.connectedInstalls, ['primary']);
  const ev = status.installs.work.recent.map(e => e.event);
  assert.deepEqual(ev, ['disconnect', 'slotBusy', 'connect']);
  assert.equal(status.installs.work.recent[0].reason, 'close 1000 test done');
  assert.equal(status.installs.work.recent[2].reason, 'hello');

  // ext-reload: unpinned refused; pinned → the ext drops, re-hellos as v1+1, the
  // call answers with the new build and status shows it.
  assert.equal(status.installs.primary.build, 'v1');
  assert.match((await rpc(mcp, { type: 'call', action: 'fast_ext_reload', args: {} })).error, /pinned to ONE profile label/);
  const reloaded = await rpc(mcp, { type: 'call', action: 'fast_ext_reload', args: {}, install: 'primary' });
  assert.equal(reloaded.result.reloaded, true);
  assert.equal(reloaded.result.previousBuild, 'v1');
  assert.equal(reloaded.result.build, 'v1.1');
  assert.ok(reloaded.result.ms >= 300 && reloaded.result.ms < 5000, `ms=${reloaded.result.ms}`);
  assert.equal((await rpc(mcp, { type: 'status' })).data.installs.primary.build, 'v1.1');

  const logText = readFileSync(LOG_FILE, 'utf8');
  const iso = /\[broker\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
  for (const needle of ['hello install="work" raw="work" build=v1', 'connect install="work" on :19876 reason=hello build=v1', 'slotBusy install="work"', 'disconnect install="work" on :19876 reason=close 1000 test done',
    'ext-reload install="primary" sent (build v1)', 'disconnect install="primary" on :19876 reason=reload requested (fast_ext_reload)', 'hello install="primary" raw="primary" build=v1.1', 'ext-reload install="primary" back in']) {
    const line = logText.split('\n').find(l => l.includes(needle));
    assert.ok(line, `log has: ${needle}`);
    assert.match(line, iso);
  }
  p.close(); mcp.close(); dup.close();
  for (const s of respawned) s.close();
  broker.kill();
});
