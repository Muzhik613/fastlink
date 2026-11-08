import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAutoName, defaultBaseName, suggestName } from '../src/browserName.js';

test('auto names: browser-N and device-kind defaults are "unnamed"', () => {
  for (const n of ['browser-1', 'mac', 'mac-2', 'windows-pc', 'windows-pc-3', 'linux-pc', 'chromebook', 'my-browser']) assert.equal(isAutoName(n), true, n);
  for (const n of ['alex-main', 'win1', 'macbook', 'mac-air', 'fastlinkchrome', '']) assert.equal(isAutoName(n), n === '' ? false : false, n);
});

test('default name comes from the platform and is unique in suggestions', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel' }, configurable: true });
  try {
    assert.equal(defaultBaseName(), 'mac');
    assert.equal(suggestName([{ name: 'mac' }, { name: 'mac-2' }]), 'mac-3');
    assert.equal(suggestName([{ name: 'mac', self: true }]), 'mac');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator;
  }
});
