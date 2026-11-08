// Secure build: the sealed format and the lock's call gate (src/secure/).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.* for lock.js: storage.local and tabs.get.
const store = {};
const tabs = new Map();   // id -> { url, pendingUrl? }
globalThis.chrome = {
  storage: { local: {
    async get(k) { return { [k]: store[k] }; },
    async set(o) { Object.assign(store, JSON.parse(JSON.stringify(o))); },
    async remove(k) { for (const x of [].concat(k)) delete store[x]; },
  } },
  tabs: { async get(id) { if (!tabs.has(id)) throw new Error('no tab'); return { id, ...tabs.get(id) }; } },
};

const S = await import('../src/secure/sealed.js');
const L = await import('../src/secure/lock.js');

const CODE = S.newLockCode();
let keys;
let seq = 0;
const req = async (action, args = {}, over = {}) => S.seal(keys, 'req', { seq: ++seq, ts: Date.now(), action, args, ...over });
const open = async (reply, s = seq) => S.unseal(keys, 'res', reply.sealed, s);

const ran = [];
const run = async (action, args) => { ran.push({ action, args }); return { result: { ok: action }, tabId: args.tabId }; };
const target = async () => 1;
const call = async (action, args, over, r = run) => L.handleSealed(await req(action, args, over), r, target);

beforeEach(async () => {
  for (const k of Object.keys(store)) delete store[k];
  tabs.clear();
  tabs.set(1, { url: 'https://www.bank.example/accounts' });
  tabs.set(2, { url: 'https://evil.example/' });
  await L.setLock(CODE, ['www.bank.example', '*.mail.example']);
  keys = await S.deriveKeys(CODE);
  seq = 0;
  ran.length = 0;
});

test('sealed round trip; no plaintext on the wire; page actions pinned + site re-checked at run time', async () => {
  const frame = await req('fast_text', { selector: 'secret-password-123' });
  assert.ok(!JSON.stringify(frame).includes('secret-password-123'));
  assert.ok(!JSON.stringify(frame).includes('fast_text'));
  const reply = await L.handleSealed(frame, run, target);
  assert.deepEqual(Object.keys(reply), ['sealed']);
  assert.deepEqual(await open(reply), { result: { ok: 'fast_text' }, tabId: 1 });
  assert.equal(ran.at(-1).args.tabId, 1);
  assert.equal(ran.at(-1).args.expectOrigin, 'https://www.bank.example', 'siteGuard re-checks after the queue');
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
  await assert.rejects(S.unseal(keys, 'res', (await call('fast_text', {})).sealed, seq + 1), /authentication/, 'reply bound to its seq');
});

test('replay window, clock skew and deadline', async () => {
  const f = await req('fast_text');
  assert.ok((await L.handleSealed(f, run, target)).sealed);
  assert.match((await L.handleSealed(f, run, target)).error, /replayed/);
  seq = 50; const later = await req('fast_text'); seq = 10; const earlier = await req('fast_text');
  assert.ok((await L.handleSealed(later, run, target)).sealed, 'out of order is fine');
  assert.ok((await L.handleSealed(earlier, run, target)).sealed);
  for (let i = 0; i < L.SEEN_MAX; i++) { seq = 1000 + i; await call('fast_list', {}); }
  seq = 999;
  assert.match((await call('fast_list', {})).error, /replayed/, 'below a full window');
  seq = 5000;
  assert.match((await call('fast_text', {}, { ts: Date.now() - 120_000 })).error, /too old/);
  assert.match((await call('fast_text', {}, { deadline: Date.now() - 1 })).error, /after its deadline/);
  assert.ok((await call('fast_text', {}, { deadline: Date.now() + 5000 })).sealed);
});

test('the replay window survives a reload and re-saving the same code; a new code starts fresh', async () => {
  const f = await req('fast_text');
  await L.handleSealed(f, run, target);
  await L.loadLock();
  assert.match((await L.handleSealed(f, run, target)).error, /replayed/);
  await L.setLock(CODE, ['www.bank.example']);
  assert.match((await L.handleSealed(f, run, target)).error, /replayed/, 'same code: window kept');
  await L.setLock(S.newLockCode(), ['www.bank.example']);
  assert.match((await L.handleSealed(f, run, target)).error, /wrong lock key/);
});

test('allowlist: off-list tab, in-progress navigation, navigation targets, ports, http are refused before running', async () => {
  assert.equal((await open(await call('fast_text', { tabId: 2 }))).code, 'not_allowed');
  tabs.set(1, { url: 'https://www.bank.example/', pendingUrl: 'https://evil.example/' });
  assert.equal((await open(await call('fast_fill', { fields: { Password: 'x' } }))).code, 'not_allowed', 'pendingUrl checked');
  tabs.set(1, { url: 'https://www.bank.example/' });
  assert.equal((await open(await call('fast_nav', { url: 'https://evil.example/x' }))).code, 'not_allowed');
  assert.equal((await open(await call('fast_tab', { url: 'https://www.bank.example:8443/' }))).code, 'not_allowed', 'non-default port');
  assert.equal((await open(await call('fast_tab', { url: 'http://www.bank.example/' }))).code, 'not_allowed', 'http');
  assert.equal(ran.length, 0);
  assert.ok((await open(await call('fast_tab', { url: 'https://inbox.mail.example/' }))).result, 'wildcard subdomain');
});

test('fast_batch is refused; fast_evaluate only when the owner allows page JavaScript', async () => {
  assert.equal((await open(await call('fast_batch', { actions: [] }))).code, 'not_allowed');
  assert.match((await open(await call('fast_evaluate', { fn: '() => 1' }))).error, /off on this secure browser/);
  await L.setAllowlist(L.lockSettings().allowlist, { allowEval: true });
  assert.ok((await open(await call('fast_evaluate', { fn: '() => 1' }))).result);
});

test('tab actions: list is filtered to allowed tabs, switch/close need an allowed tabId', async () => {
  const lister = async () => ({ result: [{ id: 1, url: 'https://www.bank.example/a', trail: [{ url: 'x' }] }, { id: 2, url: 'https://evil.example/', title: 'secret mail subject' }] });
  const listed = await open(await call('fast_list', {}, {}, lister));
  assert.deepEqual(listed.result, [{ id: 1, url: 'https://www.bank.example/a' }]);
  assert.equal((await open(await call('fast_switch', { match: 'evil' }))).code, 'not_allowed');
  assert.equal((await open(await call('fast_switch', { tabId: 2 }))).code, 'not_allowed');
  assert.ok((await open(await call('fast_close', { tabId: 1 }))).result);
});

test('round 2: match is refused on tab actions; the deadline travels to run time; clearing mid-call still replies', async () => {
  assert.equal((await open(await call('fast_close', { tabId: 1, match: 'mail' }))).code, 'not_allowed');
  const dl = Date.now() + 5000;
  await call('fast_text', {}, { deadline: dl });
  assert.equal(ran.at(-1).args.notAfter, dl, 'dispatchAction re-checks it after the queue');
  const clearing = async (action, args) => { await L.clearLock(); return { result: { ok: 1 }, tabId: args.tabId }; };
  const r = await call('fast_text', {}, {}, clearing);
  assert.ok(r.sealed, 'sealed with the snapshot taken at entry, no hang');
});

test('fb#20: a new tab whose navigation has not committed (url "", pendingUrl allowed) is fine; a blank tab is not ready', async () => {
  const opener = (pending) => async (action, args) => { tabs.set(9, { url: '', ...(pending ? { pendingUrl: pending } : {}) }); return { result: { id: 9 }, tabId: 9 }; };
  const ok = await open(await call('fast_tab', { url: 'https://www.bank.example/' }, {}, opener('https://www.bank.example/')));
  assert.deepEqual(ok, { result: { id: 9 }, tabId: 9 }, 'pending allowed URL: no false left_allowlist');
  const blank = await open(await call('fast_tab', { url: 'https://www.bank.example/' }, {}, opener(null)));
  assert.ok(blank.result, 'nothing committed yet: nothing to withhold');
  const off = await open(await call('fast_tab', { url: 'https://www.bank.example/' }, {}, opener('https://evil.example/')));
  assert.equal(off.code, 'left_allowlist', 'a pending off-list destination is still caught');
  tabs.set(9, { url: 'about:blank' });
  assert.equal((await open(await call('fast_text', { tabId: 9 }))).code, 'not_ready');
  // Fail closed outside that case: a page action whose tab ends blank or is gone after the call.
  const blanker = async (action, args) => { tabs.set(1, { url: '' }); return { result: { text: 'X' }, tabId: args.tabId }; };
  assert.equal((await open(await call('fast_text', {}, {}, blanker))).code, 'left_allowlist');
  tabs.set(1, { url: 'https://www.bank.example/' });
  const closer = async (action, args) => { tabs.delete(1); return { result: { text: 'X' }, tabId: args.tabId }; };
  assert.equal((await open(await call('fast_text', {}, {}, closer))).code, 'left_allowlist');
});

test('a redirect off the allowlist never returns page content', async () => {
  const leaky = async (action, args) => { tabs.set(1, { url: 'https://evil.example/landing' }); return { result: { text: 'PAGE CONTENT' }, tabId: args.tabId }; };
  const r = await open(await call('fast_click', { selector: '#go' }, {}, leaky));
  assert.equal(r.code, 'left_allowlist');
  assert.ok(!JSON.stringify(r).includes('PAGE CONTENT'));
});

test('sealed set_allowlist: removing is allowed, adding needs the owner; flags are owner-only', async () => {
  assert.equal((await open(await call('set_allowlist', { allowlist: ['www.bank.example', 'new.bank.example'] }))).code, 'not_allowed');
  assert.deepEqual((await open(await call('set_allowlist', { allowlist: ['www.bank.example'] }))).result.allowlist, ['www.bank.example']);
  await L.setAllowlist(['www.bank.example'], { remoteAdd: true });
  assert.deepEqual((await open(await call('set_allowlist', { allowlist: ['https://new.bank.example/login', 'junk'] }))).result.allowlist, ['new.bank.example']);
  assert.deepEqual((await open(await call('get_allowlist', {}))).result, { allowlist: ['new.bank.example'], remoteAdd: true, allowEval: false });
});

test('unlocked: everything refused; unsealed calls refused while locked', async () => {
  assert.equal(L.refuseUnsealed().code, 'locked');
  store.deviceToken = 'tok';
  await L.clearLock();
  assert.equal(L.isLocked(), false);
  assert.equal(store.deviceToken, undefined, 'unlocking unpairs');
  assert.equal((await call('fast_list', {})).code, 'locked');
});

test('allowlist entries normalize; bad lock codes are rejected', async () => {
  assert.deepEqual(L.normalizeAllowlist('https://A.Bank.example/x\n*.Mail.example, nodot, '), ['a.bank.example', '*.mail.example']);
  assert.equal(L.urlAllowed('https://mail.example/', ['*.mail.example']), true);
  assert.equal(L.urlAllowed('https://evilmail.example/', ['*.mail.example']), false);
  await assert.rejects(S.deriveKeys('short'), /43 characters/);
});
