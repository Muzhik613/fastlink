// node --test — fast_screenshot's one coordinate space (fast-ext/src/actions/screenshot.js
// cssFrame): every capture is resized so image pixels = fast_click_xy CSS pixels.
// Live (Azure, dpr 2): a 2880x1530 image of a ~1440px viewport; a click read off it at
// 320,145 landed on the page title. The real-capture check at dpr 2 runs in the headless
// harness (both captureVisibleTab and the CDP fresh path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../fast-ext/src/actions/screenshot.js', import.meta.url), 'utf8');
const i = src.indexOf('export function cssFrame');
const { cssFrame } = new Function(`${src.slice(i, src.indexOf('\n}\n', i) + 2).replace(/^export /, '')}\nreturn { cssFrame };`)();

test('dpr 2: a 2880x1530 capture of a 1440x765 tab maps to 1440x765 CSS px', () => {
  assert.deepEqual(cssFrame({ imgW: 2880, imgH: 1530, tabW: 1440, tabH: 765, zoom: 1 }), { cssWidth: 1440, cssHeight: 765, dpr: 2 });
});
test('dpr 1 is already CSS px; page zoom 150% shrinks the CSS viewport', () => {
  assert.deepEqual(cssFrame({ imgW: 1280, imgH: 720, tabW: 1280, tabH: 720, zoom: 1 }), { cssWidth: 1280, cssHeight: 720, dpr: 1 });
  assert.deepEqual(cssFrame({ imgW: 2560, imgH: 1440, tabW: 1280, tabH: 720, zoom: 1.5 }), { cssWidth: 853, cssHeight: 480, dpr: 3.001 });
  // height follows the image at the width's scale, whatever the tab reports
  assert.deepEqual(cssFrame({ imgW: 2800, imgH: 1514, tabW: 1400, tabH: 813, zoom: 1 }), { cssWidth: 1400, cssHeight: 757, dpr: 2 });
});
test('no tab size known: the image is left as it is, never guessed', () => {
  assert.deepEqual(cssFrame({ imgW: 2880, imgH: 1530, tabW: undefined, tabH: undefined, zoom: 1 }), { cssWidth: 2880, cssHeight: 1530, dpr: 1 });
});
test('both capture paths go through the one resize; no device-pixel helpers remain', () => {
  assert.match(src, /return await toCssPixels\(shot, await getActiveTab\(\), args\);/);
  assert.match(src, /return await toCssPixels\(shot, tab, args\);/);
  const util = readFileSync(new URL('../../fast-ext/src/util.js', import.meta.url), 'utf8');
  assert.doesNotMatch(util, /captureVisibleRetry|captureVisiblePinAware/);
});
