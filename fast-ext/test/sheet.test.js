// sheet.js with a stubbed chrome.debugger: snapshot reads a same-process frame through the frame
// tree, and fast_click / fast_click_xy send real mouse input at sheet coordinates (0.4.44 shipped
// without clickAt: every sheet click threw).
import test from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
const SHEET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
function snapJson(items, extra = {}) { return { result: { value: JSON.stringify({ url: 'https://pay.google.com/gp/p/ui/pay', title: 'Google Pay', items, text: '', ...extra }) } }; }
globalThis.chrome = {
  debugger: {
    onDetach: { addListener() {} }, onEvent: { addListener() {} },
    getTargets: async () => [{ id: SHEET, type: 'page', url: 'https://pay.google.com/gp/p/ui/pay?x', title: 'Google Pay' }],
    attach: async () => {},
    sendCommand: async (dbg, method, params) => {
      sent.push([method, params]);
      if (method === 'Runtime.evaluate' && !params.contextId) return snapJson([], { crossOriginFrames: [{ src: 'https://payments.google.com/gp/w/u/0/buyflow2?a=1', x: 10, y: 20, w: 600, h: 300 }] });
      if (method === 'Runtime.evaluate' && params.contextId === 7) return snapJson([{ i: 0, tag: 'div', role: 'button', label: 'Visa ••0298', x: 100, y: 50 }, { i: 1, tag: 'button', label: 'Pay', x: 300, y: 250 }]);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F0', url: 'https://pay.google.com/gp/p/ui/pay' }, childFrames: [{ frame: { id: 'F1', url: 'https://payments.google.com/gp/w/u/0/buyflow2?a=1' } }] } };
      if (method === 'Page.createIsolatedWorld') { assert.equal(params.frameId, 'F1'); return { executionContextId: 7 }; }
      return {};
    },
  },
};
const { sheetAction } = await import('../src/actions/sheet.js');

test('snapshot reads the same-process frame, shifted into sheet coordinates', async () => {
  const r = await sheetAction('fast_snapshot', { targetId: SHEET, sheetHosts: ['pay.google.com', 'payments.google.com'] });
  assert.deepEqual(r.items.map((x) => [x.label, x.x, x.y, x.frame]), [['Visa ••0298', 110, 70, 'payments.google.com'], ['Pay', 310, 270, 'payments.google.com']]);
});

test('fast_click by id and by text, and fast_click_xy, send mouse events at sheet coordinates', async () => {
  sent.length = 0;
  const a = await sheetAction('fast_click', { targetId: SHEET, id: '0', sheetHosts: ['pay.google.com', 'payments.google.com'] });
  assert.equal(a.clicked, 'Visa ••0298');
  const mouse = sent.filter(([m]) => m === 'Input.dispatchMouseEvent').map(([, p]) => [p.type, p.x, p.y]);
  assert.deepEqual(mouse, [['mouseMoved', 110, 70], ['mousePressed', 110, 70], ['mouseReleased', 110, 70]]);
  const b = await sheetAction('fast_click', { targetId: SHEET, text: '0298' });
  assert.equal(b.clicked, 'Visa ••0298');
  const c = await sheetAction('fast_click_xy', { targetId: SHEET, x: 5, y: 6 });
  assert.deepEqual(c.clicked, { x: 5, y: 6 });
});

test('a service token never reaches a frame on another host', async () => {
  const r = await sheetAction('fast_snapshot', { targetId: SHEET, sheetHosts: ['pay.google.com'] });
  assert.equal(r.items.length, 0);
  assert.equal(r.framesNotRead[0].host, 'payments.google.com');
});
