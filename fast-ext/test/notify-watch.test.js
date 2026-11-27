// fast_watch {notifications:true}: the in-page hook announces every notification the page
// shows (both APIs), leaves the page's own call unchanged, and installs only once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { notifyMatches } from '../src/actions/watch.js';

// The hook file as Chrome injects it: its completion value is the JSON answer.
const HOOK = fs.readFileSync(new URL('../src/notifyHook.js', import.meta.url), 'utf8');
const installNotifyHook = () => (0, eval)(HOOK);

function fakePage() {
  const shown = [];
  const heard = [];
  class SWR { showNotification(title, opts) { shown.push(['sw', title, opts?.body]); return Promise.resolve('shown'); } }
  function Notification(title, opts) { this.title = title; shown.push(['n', title, opts?.body]); }
  Notification.permission = 'granted';
  const doc = { readyState: 'loading', dispatchEvent: (e) => { heard.push(JSON.parse(e.detail)); return true; } };
  const saved = { SWR: globalThis.ServiceWorkerRegistration, N: globalThis.Notification, d: globalThis.document, h: globalThis.__fastlinkNotifyHooked, CE: globalThis.CustomEvent };
  delete globalThis.__fastlinkNotifyEarly;
  Object.assign(globalThis, { ServiceWorkerRegistration: SWR, Notification, document: doc });
  globalThis.CustomEvent ||= class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  delete globalThis.__fastlinkNotifyHooked;
  const restore = () => { globalThis.ServiceWorkerRegistration = saved.SWR; globalThis.Notification = saved.N; globalThis.document = saved.d; globalThis.__fastlinkNotifyHooked = saved.h; globalThis.CustomEvent = saved.CE; };
  return { SWR, shown, heard, restore };
}

test('a burst of three is three events; the page still shows each', async () => {
  const p = fakePage();
  try {
    assert.deepEqual(JSON.parse(installNotifyHook()), { permission: 'granted', early: true });
    const reg = new p.SWR();
    for (const b of ['one', 'two', 'three']) assert.equal(await reg.showNotification('Tack', { body: b, tag: 'conv-1', data: { id: 'c1' } }), 'shown');
    assert.deepEqual(p.heard.map((e) => [e.via, e.title, e.body, e.tag, e.data?.id]), [
      ['showNotification', 'Tack', 'one', 'conv-1', 'c1'], ['showNotification', 'Tack', 'two', 'conv-1', 'c1'], ['showNotification', 'Tack', 'three', 'conv-1', 'c1']]);
    assert.equal(p.shown.length, 3);
    const n = new Notification('Bo', { body: 'hi' });
    assert.equal(n.title, 'Bo');
    assert.ok(n instanceof Notification);
    assert.equal(Notification.permission, 'granted');
    assert.deepEqual(p.heard.at(-1), { via: 'Notification', title: 'Bo', body: 'hi', tag: null, timestamp: null, data: null });
  } finally { p.restore(); }
});

test('installing twice wraps once', async () => {
  const p = fakePage();
  try {
    installNotifyHook(); installNotifyHook();
    await new p.SWR().showNotification('x', { body: 'y' });
    assert.equal(p.heard.length, 1);
  } finally { p.restore(); }
});

test('a page that captured Notification at startup is covered when the hook ran first', () => {
  const p = fakePage();
  try {
    installNotifyHook();                       // document_start content script
    const ko = globalThis.Notification;        // the app keeps this reference (Messages: this.ko)
    globalThis.document.readyState = 'complete';
    assert.equal(JSON.parse(installNotifyHook()).early, true, 'a later install reports the early hook');
    new ko('Tack', { body: 'burst', tag: 'c' });
    assert.equal(p.heard.length, 1);
  } finally { p.restore(); }
});

test('the page-start hook is registered only on origins with a notify watch', () => {
  assert.deepEqual(notifyMatches({
    a: { kind: 'notify', origin: 'https://messages.google.com' }, b: { kind: 'notify', origin: 'https://messages.google.com' },
    c: { kind: 'dom', origin: 'https://x.test' }, d: { kind: 'request', origin: 'https://y.test' },
  }), ['https://messages.google.com/*']);
  assert.deepEqual(notifyMatches({}), []);
});
