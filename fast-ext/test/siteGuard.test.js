// The extension refuses a relay-approved write when the tab moved to another site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExpectedSite } from '../src/siteGuard.js';

const urls = { 7: 'https://bank.test/pay', 9: 'https://evil.test/x' };
const tabUrl = async (id) => { if (!(id in urls)) throw new Error('No tab'); return urls[id]; };

test('same site: runs, expectOrigin stripped', async () => {
  const r = await checkExpectedSite('fast_click', { tabId: 7, text: 'Pay', expectOrigin: 'https://bank.test' }, tabUrl);
  assert.deepEqual(r, { args: { tabId: 7, text: 'Pay' } });
});

test('tab moved to another site: refused with siteChanged', async () => {
  const r = await checkExpectedSite('fast_click', { tabId: 9, expectOrigin: 'https://bank.test' }, tabUrl);
  assert.equal(r.error.siteChanged, true);
  assert.match(r.error.error, /evil\.test.*bank\.test/);
});

test('tab gone: refused', async () => {
  const r = await checkExpectedSite('fast_fill', { tabId: 99, expectOrigin: 'https://bank.test' }, tabUrl);
  assert.equal(r.error.siteChanged, true);
});

test('no expectOrigin: untouched', async () => {
  const args = { tabId: 9 };
  assert.equal((await checkExpectedSite('fast_text', args, tabUrl)).args, args);
});
