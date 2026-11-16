// fast_upload on the relay: files checked before anything is sent, too-old extensions
// refused, never a batch step, refused in read-only consent like any write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRelay, fakeSocket, mcpCall, reply, tick } from './helpers.mjs';
import { checkUpload, UPLOAD_MAX_BYTES } from '../src/mcp.js';
import { TOOLS } from '../tools.js';

const b64 = (s) => Buffer.from(s).toString('base64');

test('fast_upload is listed with files required', () => {
  const t = TOOLS.find((x) => x.name === 'fast_upload');
  assert.ok(t);
  assert.deepEqual(t.inputSchema.required, ['files']);
  assert.ok(t.inputSchema.properties.tabId && t.inputSchema.properties.browser);
  assert.ok(t.description.length <= 300);
});

test('checkUpload: names, base64, count and size caps', () => {
  const ok = checkUpload({ files: [{ name: 'flyer.jpg', type: 'image/jpeg', data: b64('abc') }] });
  assert.deepEqual(ok.args.files, [{ name: 'flyer.jpg', type: 'image/jpeg', data: b64('abc') }]);
  assert.equal(checkUpload({ files: [{ name: 'x.bin', data: b64('a') }] }).args.files[0].type, 'application/octet-stream');
  assert.match(checkUpload({}).error, /needs `files`/);
  assert.match(checkUpload({ files: [{ name: '../etc/passwd', data: b64('a') }] }).error, /bad file name/);
  assert.match(checkUpload({ files: [{ name: 'a', data: 'not base64!' }] }).error, /base64/);
  assert.match(checkUpload({ files: Array.from({ length: 11 }, () => ({ name: 'a', data: b64('a') })) }).error, /at most 10 files/);
  const big = Buffer.alloc(UPLOAD_MAX_BYTES + 3).toString('base64');
  assert.match(checkUpload({ files: [{ name: 'big.mp4', data: big }] }).error, /at most 10 MB/);
  const exact = Buffer.alloc(UPLOAD_MAX_BYTES).toString('base64');
  assert.ok(checkUpload({ files: [{ name: 'ok.mp4', data: exact }] }).args);
});

test('a valid upload reaches the browser with the files; a bad one sends nothing', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.31');
  const { r } = await makeRelay({ devices: [{ name: 'mac', token: 'tokA' }], sockets: [a] });
  const bad = await mcpCall(r, 'fast_upload', { tabId: 7, files: [{ name: 'a/b', data: b64('x') }] });
  assert.match(JSON.stringify(bad), /bad file name/);
  assert.equal(a.sent.filter((m) => m.type === 'call').length, 0);

  const p = mcpCall(r, 'fast_upload', { tabId: 7, match: 'photo', files: [{ name: 'f.png', type: 'image/png', data: b64('PNG') }] });
  for (let i = 0; i < 200 && !a.lastCall(); i++) await tick();
  const call = a.lastCall();
  assert.equal(call.action, 'fast_upload');
  assert.equal(call.args.match, 'photo');
  assert.deepEqual(call.args.files, [{ name: 'f.png', type: 'image/png', data: b64('PNG') }]);
  await reply(r, a, call.id, { result: { uploaded: [{ name: 'f.png' }] }, origin: 'https://web.whatsapp.com', tabId: 7 });
  const out = await p;
  assert.equal(out.data.uploaded[0].name, 'f.png');
});

test('an extension older than 0.4.31 gets "update FastLink", never the call', async () => {
  const { versionAtLeast } = await import('../src/userRelay.js');
  assert.equal(versionAtLeast('0.4.31', '0.4.31'), true);
  assert.equal(versionAtLeast('0.4.30', '0.4.31'), false);
  const a = fakeSocket('tokA', Date.now(), '0.4.30');
  const { r } = await makeRelay({ devices: [{ name: 'mac', token: 'tokA' }], sockets: [a] });
  const out = await mcpCall(r, 'fast_upload', { tabId: 7, files: [{ name: 'f.png', data: b64('PNG') }] });
  assert.match(JSON.stringify(out), /needs 0\.4\.31 or newer/);
  assert.equal(a.sent.filter((m) => m.type === 'call').length, 0);
});

test('fast_upload is not a batch step', async () => {
  const a = fakeSocket('tokA', Date.now(), '0.4.31');
  const { r } = await makeRelay({ devices: [{ name: 'mac', token: 'tokA' }], sockets: [a] });
  const out = await mcpCall(r, 'fast_batch', { actions: [{ name: 'fast_upload', args: { files: [{ name: 'f.png', data: b64('x') }] } }] });
  assert.match(JSON.stringify(out), /fast_upload.*not allowed as a batch step/);
  assert.equal(a.sent.filter((m) => m.type === 'call' && m.action === 'fast_upload').length, 0);
});
