// Renaming a browser onto a name held by another browser of the same account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers.mjs';
import { createDevice, renameDevice } from '../src/db.js';

async function seed() {
  const db = fakeD1();
  db.raw.prepare(`INSERT INTO users (user_id, email, created_at) VALUES (?, ?, ?)`).run('u1', 'a@example.com', Date.now());
  await createDevice(db, 'u1', 'tok-old', 'mac1');   // this browser before remove + reload
  await createDevice(db, 'u1', 'tok-new', 'mac');    // the same browser, re-paired
  return db;
}
const label = (db, t) => ({ ...db.raw.prepare('SELECT label, revoked FROM devices WHERE device_token = ?').get(t) });

test('a name held by an ONLINE browser is never taken', async () => {
  const db = await seed();
  const r = await renameDevice(db, 'u1', 'tok-new', 'mac1', { replace: true, liveTokens: new Set(['tok-old']) });
  assert.deepEqual(r, { ok: false, error: 'name_taken' });
  assert.deepEqual(label(db, 'tok-old'), { label: 'mac1', revoked: 0 });
});

test('a name held by an OFFLINE browser: offered first, replaced only on request', async () => {
  const db = await seed();
  const r1 = await renameDevice(db, 'u1', 'tok-new', 'mac1', { liveTokens: new Set() });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'name_taken_offline');
  assert.deepEqual(label(db, 'tok-old'), { label: 'mac1', revoked: 0 });
  const r2 = await renameDevice(db, 'u1', 'tok-new', 'mac1', { replace: true, liveTokens: new Set() });
  assert.deepEqual(r2, { ok: true, name: 'mac1' });
  assert.equal(label(db, 'tok-old').revoked, 1);
  assert.deepEqual(label(db, 'tok-new'), { label: 'mac1', revoked: 0 });
});
