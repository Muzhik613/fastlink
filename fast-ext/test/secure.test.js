// Secure build: the sealed format and the lock's call gate (src/secure/).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.* for lock.js: storage.local and tabs.get.
const store = {};
const tabs = new Map();
globalThis.chrome = {
  storage: { local: {
    async get(k) { return { [k]: store[k] }; },
    async set(o) { Object.assign(store, JSON.parse(JSON.stringify(o))); },
    async remove(k) { delete store[k]; },
  } },
  tabs: { async get(id) { if (!tabs.has(id)) throw new Error('no tab'); return { id, url: tabs.get(id) }; } },
};

const S = await import('../src/secure/sealed.js');
const L = await import('../src/secure/lock.js');

const CODE = S.newLockCode();
let keys;
let seq = 0;
const req = async (action, args = {}, over = {}) => S.seal(keys, 'req', { seq: ++seq, ts: Date.now(), action, args, ...over });
const open = async (reply, s = seq) => S.unseal(keys, 'res', reply.sealed, s);

beforeEach(async () => {
  for (const k of Object.keys(store)) delete store[k];
  tabs.clear();
  tabs.set(1, 'https://www.bank.example/accounts');
  tabs.set(2, 'https://evil.example/');
  await L.setLock(CODE, ['www.bank.example', '*.mail.example']);
  keys = await S.deriveKeys(CODE);
  seq = 0;
});

const ran = [];
const run = async (action, args) => { ran.push({ action, args }); return { result: { ok: action }, tabId: args.tabId }; };
const target = async () => 1;

test('sealed round trip; the frame carries no plaintext', async () => {
  const frame = await req('fast_text', { selector: 'secret-password-123' });
  assert.ok(!JSON.stringify(frame).includes('secret-password-123'));
  assert.ok(!JSON.stringify(frame).includes('fast_text'));
  const reply = await L.handleSealed(frame, run, target);
  assert.deepEqual(Object.keys(reply), ['sealed']);
  assert.deepEqual(await open(reply), { result: { ok: 'fast_text' }, tabId: 1 });
  assert.equal(ran.at(-1).args.tabId, 1, 'pinned to the checked tab');
});

test('tampered, wrong-key and wrong-direction frames are refused without content', async () => {
  const frame = await req('fast_text');
  const bad = { ...frame, ct: frame.ct.slice(0, -2) + (frame.ct.endsWith('A') ? 'B' : 'A') + frame.ct.slice(-1) };
  assert.match((await L.handleSealed(bad, run, target)).error, /authentication/);
  const other = await S.deriveKeys(S.newLockCode());
  const foreign = await S.seal(other, 'req', { seq: 99, ts: Date.now(), action: 'fast_text', args: {} });
  assert.match((await L.handleSealed(foreign, run, target)).error, /wrong lock key/);
  const asRes = await S.seal(keys, 'res', { seq: 50, ts: Date.now(), action: 'fast_text', args: {} }, undefined);
  assert.match((await L.handleSealed(asRes, run, target)).error, /authentication/);
});

test('a response is bound to its request seq', async () => {
  const reply = await L.handleSealed(await req('fast_text'), run, target);
  await assert.rejects(S.unseal(keys, 'res', reply.sealed, seq + 1), /authentication/);
});

test('replayed, out-of-order and stale requests are refused', async () => {
  const f = await req('fast_text');
  assert.ok((await L.handleSealed(f, run, target)).sealed);
  assert.match((await L.handleSealed(f, run, target)).error, /replayed/);
  // Out of order is fine (two scripts at once); a repeat is not.
  seq = 50; const later = await req('fast_text'); seq = 10; const earlier = await req('fast_text');
  assert.ok((await L.handleSealed(later, run, target)).sealed);
  assert.ok((await L.handleSealed(earlier, run, target)).sealed);
  assert.match((await L.handleSealed(earlier, run, target)).error, /replayed/);
  // Below a full window: refused.
  for (let i = 0; i < L.SEEN_MAX; i++) { seq = 1000 + i; await L.handleSealed(await req('fast_list'), run, target); }
  seq = 999;
  assert.match((await L.handleSealed(await req('fast_list'), run, target)).error, /replayed/);
  seq = 5000;
  assert.match((await L.handleSealed(await req('fast_text', {}, { ts: Date.now() - 120_000 }), run, target)).error, /too old/);
});

test('allowlist: off-list tab, navigation and batch step are refused before running', async () => {
  ran.length = 0;
  const r1 = await open(await L.handleSealed(await req('fast_text', { tabId: 2 }), run, target));
  assert.equal(r1.code, 'not_allowed');
  const r2 = await open(await L.handleSealed(await req('fast_nav', { url: 'https://evil.example/x' }), run, target));
  assert.equal(r2.code, 'not_allowed');
  const r3 = await open(await L.handleSealed(await req('fast_batch', { steps: [{ action: 'fast_nav', args: { url: 'http://www.bank.example/' } }] }), run, target));
  assert.equal(r3.code, 'not_allowed', 'http is not allowed');
  assert.equal(ran.length, 0);
  const ok = await open(await L.handleSealed(await req('fast_tab', { url: 'https://inbox.mail.example/' }), run, target));
  assert.ok(ok.result, 'wildcard subdomain allowed');
});

test('a redirect off the allowlist never returns page content', async () => {
  const leaky = async (action, args) => { tabs.set(1, 'https://evil.example/landing'); return { result: { text: 'PAGE CONTENT' }, tabId: args.tabId }; };
  const r = await open(await L.handleSealed(await req('fast_click', { selector: '#go' }), leaky, target));
  assert.equal(r.code, 'left_allowlist');
  assert.ok(!JSON.stringify(r).includes('PAGE CONTENT'));
});

test('sealed set_allowlist: removing is allowed, adding needs the owner (remoteAdd)', async () => {
  const add = await open(await L.handleSealed(await req('set_allowlist', { allowlist: ['www.bank.example', 'new.bank.example'] }), run, target));
  assert.equal(add.code, 'not_allowed');
  assert.deepEqual(L.currentAllowlist(), ['www.bank.example', '*.mail.example']);
  await L.setAllowlist(L.currentAllowlist(), { remoteAdd: true });   // owner allows adding
  const r = await open(await L.handleSealed(await req('set_allowlist', { allowlist: ['https://new.bank.example/login', 'junk'] }), run, target));
  assert.deepEqual(r.result.allowlist, ['new.bank.example']);
  await L.loadLock();
  assert.deepEqual(L.currentAllowlist(), ['new.bank.example']);
  assert.equal(L.isLocked(), true);
  // lastSeq persisted: the same seq is still a replay after reload.
  seq -= 1;
  assert.match((await L.handleSealed(await req('fast_list'), run, target)).error, /replayed/);
});

test('unlocked: everything refused; unsealed calls refused while locked', async () => {
  assert.equal(L.refuseUnsealed().code, 'locked');
  await L.clearLock();
  assert.equal(L.isLocked(), false);
  assert.equal((await L.handleSealed(await req('fast_list'), run, target)).code, 'locked');
});

test('allowlist entries normalize; bad lock codes are rejected', async () => {
  assert.deepEqual(L.normalizeAllowlist('https://A.Bank.example/x\n*.Mail.example, nodot, '), ['a.bank.example', '*.mail.example']);
  assert.equal(L.urlAllowed('https://mail.example/', ['*.mail.example']), true);
  assert.equal(L.urlAllowed('https://evilmail.example/', ['*.mail.example']), false);
  await assert.rejects(S.deriveKeys('short'), /43 characters/);
});
