// fast_type against a model of one focused field (fb#31/#32): key events that may be
// dropped (window not focused), and a browser-autofilled password that reads "" to
// page scripts until the first real input, then shows up in front of what was typed.
import test from 'node:test';
import assert from 'node:assert/strict';

function field({ type = 'text', hidden = '', keysWork = true } = {}) {
  const f = { type, visible: '', hidden, revealed: false, keysWork, keys: 0, inserts: 0 };
  const reveal = () => { if (!f.revealed) { f.visible = f.hidden + f.visible; f.revealed = true; } };
  globalThis.chrome = {
    tabs: { get: async (id) => ({ id, url: 'https://x.test/login', status: 'complete' }) },
    storage: { local: { get: async () => ({}) } },
    debugger: {
      onDetach: { addListener() {} },
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_t, method, p) => {
        if (method === 'Input.dispatchKeyEvent' && p.type === 'keyDown' && p.text) {
          f.keys++;
          if (f.keysWork) { reveal(); f.visible += p.text; }
        } else if (method === 'Input.insertText') { f.inserts++; reveal(); f.visible += p.text; }
        return {};
      },
    },
    scripting: {
      executeScript: async ({ func }) => {
        if (func.name === 'inspectFocusInFrame') {
          const v = f.visible;
          const pw = f.type === 'password';
          return [{ result: { tag: 'input', type: f.type, editable: true, readable: !pw, label: 'f', value: pw ? '•'.repeat(v.length) : v, valueLen: v.length, underPointer: true, ...(pw ? { reason: 'password field: value not readable' } : {}) } }];
        }
        if (func.name === 'clearFocusedInFrame') { f.visible = ''; return [{ result: 0 }]; }
        throw new Error('unexpected injection ' + func.name);
      },
    },
    webNavigation: { getAllFrames: async () => [] },
  };
  return f;
}

const { typeText } = await import('../src/actions/input.js');

test('keys reach the page: the text goes in as key presses, once', async () => {
  const f = field();
  const r = await typeText({ text: 'abc', tabId: 1 });
  assert.equal(r.verified, true);
  assert.equal(f.visible, 'abc');
  assert.equal(f.keys, 3);
  assert.equal(f.inserts, 0);
  assert.equal(r.keyPresses, undefined);
});

test('keys dropped, ordinary field: insertText once, reported keyPresses:false, no doubling', async () => {
  const f = field({ keysWork: false });
  const r = await typeText({ text: 'hello', tabId: 1, clear: true });
  assert.equal(f.visible, 'hello');
  assert.equal(f.inserts, 1);
  assert.equal(r.keyPresses, false);
  assert.equal(r.verified, true);
});

test('keys dropped, password field: refused, nothing written, field left empty (fb#32)', async () => {
  const f = field({ type: 'password', hidden: 'Saved-pw-123!', keysWork: false });
  const r = await typeText({ text: 'Saved-pw-123!', tabId: 1, clear: true });
  assert.equal(r.code, 'password_needs_key_presses');
  assert.equal(f.inserts, 0);
  assert.equal(f.visible, '');
});

test('hidden autofilled password + typing: refused as longer than typed, never reported as set (fb#31/#32)', async () => {
  const f = field({ type: 'password', hidden: 'Saved-pw-123!' });
  const r = await typeText({ text: 'Saved-pw-123!', tabId: 1 });
  assert.equal(f.visible.length, 26);
  assert.equal(r.verified, false);
  assert.equal(r.code, 'field_longer_than_typed');
  // the retry it advises (clear:true) leaves exactly the typed text
  const r2 = await typeText({ text: 'Saved-pw-123!', tabId: 1, clear: true });
  assert.equal(f.visible, 'Saved-pw-123!');
  assert.equal(r2.code, undefined);
});
