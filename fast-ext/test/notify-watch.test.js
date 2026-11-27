// fast_watch {notifications:true}: the in-page hook announces every notification the page
// shows (both APIs), leaves the page's own call unchanged, and installs only once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installNotifyHook } from '../src/actions/watch.js';

function fakePage() {
  const shown = [];
  const heard = [];
  class SWR { showNotification(title, opts) { shown.push(['sw', title, opts?.body]); return Promise.resolve('shown'); } }
  function Notification(title, opts) { this.title = title; shown.push(['n', title, opts?.body]); }
  Notification.permission = 'granted';
  const doc = { dispatchEvent: (e) => { heard.push(JSON.parse(e.detail)); return true; } };
  const saved = { SWR: globalThis.ServiceWorkerRegistration, N: globalThis.Notification, d: globalThis.document, h: globalThis.__fastlinkNotifyHooked, CE: globalThis.CustomEvent };
  Object.assign(globalThis, { ServiceWorkerRegistration: SWR, Notification, document: doc });
  globalThis.CustomEvent ||= class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  delete globalThis.__fastlinkNotifyHooked;
  const restore = () => { globalThis.ServiceWorkerRegistration = saved.SWR; globalThis.Notification = saved.N; globalThis.document = saved.d; globalThis.__fastlinkNotifyHooked = saved.h; globalThis.CustomEvent = saved.CE; };
  return { SWR, shown, heard, restore };
}

test('a burst of three is three events; the page still shows each', async () => {
  const p = fakePage();
  try {
    assert.deepEqual(JSON.parse(installNotifyHook()), { permission: 'granted' });
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
