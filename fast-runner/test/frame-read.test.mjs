// node --test — fast_frame_read (fast-ext/src/actions/frames.js): read labelled
// field values inside the frames whose URL matches, cross-origin included.
// Each fake frame is its own jsdom document; the stubbed executeScript runs the
// REAL injected function against every frame's globals, like allFrames:true does.
// Pages: a shop checkout with a Stripe-style cross-origin card iframe (non-Azure),
// and the Azure create-VM blade holding today's doubled VM name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const frames = [];
globalThis.chrome = {
  storage: { session: { get: async () => ({}) } },
  tabs: { query: async () => [{ id: 1, url: 'https://shop.example/checkout' }] },
  scripting: {
    executeScript: async ({ target, func, args }) => {
      assert.equal(target.allFrames, true);
      return frames.map((f, frameId) => {
        const w = f.window;
        const bound = new Function('location', 'document', 'getComputedStyle', 'NodeFilter', `return (${func.toString()});`)(
          w.location, w.document, w.getComputedStyle.bind(w), w.NodeFilter);
        return { frameId, result: bound(...args) };
      });
    },
  },
};
const { frameRead } = await import('../../fast-ext/src/actions/frames.js');
const setFrames = (...pages) => { frames.length = 0; for (const [url, html] of pages) frames.push(new JSDOM(html, { url })); };

const SHOP = ['https://shop.example/checkout', `<body>
  <label for="email">Email</label><input id="email" value="a@b.com">
  <iframe src="https://js.stripe.com/v3/elements-inner-card.html"></iframe></body>`];
const STRIPE = ['https://js.stripe.com/v3/elements-inner-card.html', `<body><form>
  <input aria-label="Card number" placeholder="1234 1234 1234 1234" value="">
  <label for="zip">Postal code</label><input id="zip" value="94107">
  <label>Country <select><option>United States</option><option selected>Canada</option></select></label>
  <input type="password" aria-label="CVC" value="123">
  <input aria-label="Email" value="card@b.com">
</form></body>`];
const BLADE = ['https://sandbox-1.reactblade.portal.azure.net/blade/create-vm', `<body>
  <div class="row"><div><label id="l1">Virtual machine name <span>*</span><button aria-label="info">i</button></label></div>
    <div><input aria-labelledby="l1" value="fastlink-bench-vmany validany valid "></div></div>
  <div class="row"><div><label id="l2">Region</label></div>
    <div role="combobox" aria-labelledby="l2 t2"><span id="t2">(Asia Pacific) Japan East</span><span class="icon">&#xE70D;</span></div></div>
  <div class="row"><div><label id="l3">Image</label></div>
    <div role="combobox" aria-labelledby="l3"><span class="ms-Dropdown-title ms-Dropdown-titleIsPlaceHolder">Select an image</span></div></div>
  <div class="row"><div>Resource group <span>*</span></div>
    <div><select><option>fastlink-bench-rg</option></select></div></div>
  <div class="row"><div>Tags</div><div><input value="a"><input value="b"></div></div>
  <input aria-label="Size" value="Standard_B1s"><input aria-label="Size" value="Standard_B2s">
  <div style="display:none"><label for="hid">Admin</label><input id="hid" value="x"></div>
</body>`];

test('Azure blade: the doubled VM name reads back EXACTLY — not trimmed, so an EQUALS check fails it', async () => {
  setFrames(['https://portal.azure.com/#create', '<body><iframe></iframe></body>'], BLADE);
  const r = await frameRead({ frame: 'reactblade.portal.azure.net', fields: ['Virtual machine name', 'Region', 'Image', 'Resource group'] });
  assert.deepEqual(r.frames, ['https://sandbox-1.reactblade.portal.azure.net/blade/create-vm']);
  const vm = r.fields['Virtual machine name'];
  assert.deepEqual(vm, { found: true, count: 1, value: 'fastlink-bench-vmany validany valid ', tag: 'input', role: '' });
  assert.notEqual(vm.value, 'fastlink-bench-vm');
  assert.equal(r.fields.Region.value, '(Asia Pacific) Japan East', 'aria-labelledby, icon glyph dropped');
  assert.equal(r.fields.Region.role, 'combobox');
  assert.equal(r.fields.Image.value, '', 'a placeholder is not a value');
  assert.equal(r.fields['Resource group'].value, 'fastlink-bench-rg', 'form-row text → the row\'s <select>');
});

test('ambiguity is refused: two controls with one label → count 2, value null', async () => {
  setFrames(BLADE);
  const r = await frameRead({ frame: 'reactblade', fields: ['Size', 'Tags', 'Admin', 'Nope'] });
  assert.deepEqual(r.fields.Size, { found: true, count: 2, value: null, tag: 'input', role: '' });
  assert.equal(r.fields.Tags.count, 2);
  assert.equal(r.fields.Tags.value, null);
  assert.deepEqual(r.fields.Admin, { found: false, count: 0, value: null }, 'a hidden control is not a field');
  assert.deepEqual(r.fields.Nope, { found: false, count: 0, value: null });
});

test('non-Azure: a Stripe-style cross-origin card frame is read; the top page\'s same-named field is not', async () => {
  setFrames(SHOP, STRIPE);
  const r = await frameRead({ frame: 'js.stripe.com', fields: ['Card number', 'Postal code', 'Country', 'CVC', 'Email'] });
  assert.deepEqual(r.frames, ['https://js.stripe.com/v3/elements-inner-card.html']);
  assert.equal(r.fields['Card number'].value, '', 'placeholder is not a value');
  assert.equal(r.fields['Postal code'].value, '94107');
  assert.equal(r.fields.Country.value, 'Canada', 'wrapping <label>, option text not part of the label');
  assert.equal(r.fields.CVC.value, null);
  assert.match(r.fields.CVC.reason, /password/);
  assert.equal(r.fields.Email.value, 'card@b.com');
  assert.equal(r.fields.Email.count, 1, 'the top frame did not match the frame filter');
});

test('the same label in two MATCHING frames is ambiguous across frames', async () => {
  setFrames(SHOP, STRIPE, ['https://js.stripe.com/v3/elements-inner-address.html', '<body><label for="e">Email</label><input id="e" value="x@y.z"></body>']);
  const r = await frameRead({ frame: 'js.stripe.com', fields: ['Email'] });
  assert.equal(r.frames.length, 2);
  assert.equal(r.fields.Email.count, 2);
  assert.equal(r.fields.Email.value, null);
});

test('no matching frame: error listing every frame URL on the page', async () => {
  setFrames(SHOP, STRIPE);
  const r = await frameRead({ frame: 'reactblade', fields: ['Email'] });
  assert.match(r.error, /no frame URL contains "reactblade"/);
  assert.deepEqual(r.frames, ['https://shop.example/checkout', 'https://js.stripe.com/v3/elements-inner-card.html']);
});

test('bad arguments are refused before anything is injected', async () => {
  assert.match((await frameRead({ fields: ['x'] })).error, /frame/);
  assert.match((await frameRead({ frame: 'x', fields: [] })).error, /fields/);
});
