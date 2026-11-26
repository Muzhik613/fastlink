// Manual e2e (not in npm test): node fast-ext/test/e2e-watch.mjs <fast-ext dir> <chromium binary>  — Chromium with the unpacked extension dials this fake relay.
// Local e2e: Chromium + unpacked fast-ext, dialing this fake relay; drives fast_watch / fast_capture / fast_text limit.
import { createRequire } from 'node:module';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire('/home/dev/code/products/frondesk/browser/fastlink/fastlink-relay/package.json');
const { WebSocketServer } = require('ws');

const EXT = process.argv[2];
const CHROME = process.argv[3];
const PORT = 18777, CDP = 9339;
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const PAGE = `<!doctype html><html><body><ul id=l></ul><script>
let n = 0;
const add = (who, s) => { const li = document.createElement('li'); li.className = 'row'; li.dataset.id = who; li.innerHTML = '<b class=who>'+who+'</b> <i class=s>'+s+'</i>'; document.getElementById('l').prepend(li); };
add('Ann', 'hello'); add('Bob', 'hi');
if (!location.search.includes('quiet')) {
  setTimeout(() => { add('Cat', 'new one'); }, 1500);
  // two changes to Ann in quick succession (separate tasks) must be two events
  setTimeout(() => { document.querySelector('[data-id=Ann] .s').textContent = 'msg 1'; }, 2500);
  setTimeout(() => { document.querySelector('[data-id=Ann] .s').textContent = 'msg 2'; }, 2510);
  setTimeout(() => { document.querySelector('[data-id=Bob]').remove(); }, 3000);
}
setInterval(() => fetch('/api/cart?i=' + (n++), { headers: { authorization: 'Bearer SECRET-' + n, 'x-app': 'test' } }), 700);
</script></body></html>`;

const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/cart')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ cart: [1, 2, 3], q: req.url, auth: req.headers.authorization })); return; }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
});
const wss = new WebSocketServer({ noServer: true });
srv.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req)));
srv.listen(PORT);

let ws = null;
const pending = new Map();
const watchFrames = [];
let seq = 0;
const hellos = [];
wss.on('connection', (s) => {
  log('ext connected');
  ws = s;
  s.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.ping) { s.send('{"pong":true}'); return; }
    if (m.type === 'hello') { hellos.push(m); log('hello', JSON.stringify(m)); return; }
    if (m.type === 'result') { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.type === 'watch') { watchFrames.push(m); s.send(JSON.stringify({ type: 'watch_ack', watchId: m.watchId, n: m.n })); return; }
  });
});
const call = (action, args, ms = 25000) => new Promise((res, rej) => {
  const id = 'c' + (++seq);
  pending.set(id, res);
  ws.send(JSON.stringify({ type: 'call', id, action, args }));
  setTimeout(() => rej(new Error('timeout ' + action)), ms);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(100); } return false; };
const eventsOf = (id) => watchFrames.filter((f) => f.watchId === id).flatMap((f) => f.events);

// --- start chrome, point the extension at us via its service worker ---
const udd = mkdtempSync(path.join(tmpdir(), 'fl-e2e-'));
const chrome = spawn(CHROME, [`--user-data-dir=${udd}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, `--remote-debugging-port=${CDP}`, '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d; });

async function swTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
      const sw = t.find((x) => x.type === 'service_worker' && x.url.endsWith('background.js'));
      if (sw) return sw;
    } catch {}
    await sleep(200);
  }
  throw new Error('no service worker target');
}
async function swEval(expr) {
  const sw = await swTarget();
  const c = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((r) => c.addEventListener('open', r));
  const out = await new Promise((r) => {
    c.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m); });
    c.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
  c.close();
  return out;
}

const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); log(ok ? 'PASS' : 'FAIL', name, detail); };
try {
  const sw = await swTarget();
  const extId = new URL(sw.url).host;
  const pg = await (await fetch(`http://127.0.0.1:${CDP}/json/new?chrome-extension://${extId}/options.html`, { method: 'PUT' })).json();
  await sleep(1500);
  const pc = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r) => pc.addEventListener('open', r));
  let pid = 0;
  const pending2 = new Map();
  pc.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending2.get(m.id)?.(m); });
  globalThis.pageEval = (expression) => new Promise((r) => { const id = ++pid; pending2.set(id, r); pc.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  log('set', JSON.stringify(await pageEval(`chrome.storage.local.set({ deviceToken: 'tok', relayWssUrl: 'ws://127.0.0.1:${PORT}/ext', relayEnabled: true }).then(() => 1)`)));
  log('page ws', JSON.stringify(await pageEval(`new Promise((r) => { const w = new WebSocket('ws://127.0.0.1:${PORT}/probe'); w.onopen = () => { w.close(); r('open'); }; w.onerror = () => r('error'); })`)));
  ws = null; hellos.length = 0;
  log('wins', JSON.stringify(await pageEval(`chrome.windows.getAll({}).then((w) => w.map((x) => x.type))`)));
  log('paired', JSON.stringify(await pageEval("chrome.runtime.sendMessage({type:'fastlink:relay-paired'})")));
  if (!(await until(() => ws && hellos.length, 12000))) {
    const cl = await pageEval(`chrome.storage.local.get('fastlink.connLog').then((o) => JSON.stringify(o['fastlink.connLog']))`);
    log('connLog', JSON.stringify(cl).slice(0, 1500));
    throw new Error('extension never dialed');
  }
  await until(() => hellos.some((h) => Array.isArray(h.watches)), 5000);
  check('hello carries watches[]', hellos.some((h) => Array.isArray(h.watches)));

  const tab = await call('fast_tab', { url: `http://127.0.0.1:${PORT}/page`, background: true, noSnapshot: true });
  const tabId = tab.result?.tabId ?? tab.tabId;
  log('tab', tabId);

  const w = await call('fast_watch', { watchId: 'w-test-000001', tabId, selector: '.row', fields: { name: '.who', s: '.s', id: '@data-id' }, key: 'name' });
  log('watch start', JSON.stringify(w));
  check('watch returns items with own field names', w.result?.items?.length === 2 && w.result.items[0].name === 'Bob', JSON.stringify(w.result?.items));

  const txt = await call('fast_text', { tabId, selector: '.row', limit: 1 });
  check('fast_text limit', txt.result?.items?.length === 1 && txt.result.matches >= 2, JSON.stringify(txt.result));

  const c = await call('fast_capture', { watchId: 'c-test-000001', tabId, url: '/api/cart' });
  log('capture start', JSON.stringify(c));
  check('capture started', c.result?.watchId === 'c-test-000001', JSON.stringify(c));

  await until(() => eventsOf('w-test-000001').some((e) => e.kind === 'remove'), 8000);
  const ev = eventsOf('w-test-000001');
  log('dom events', JSON.stringify(ev.map((e) => [e.kind, e.key, e.item?.s])));
  check('add Cat', ev.some((e) => e.kind === 'add' && e.key === 'Cat'));
  check('Ann msg 1 AND msg 2 both seen', ev.some((e) => e.kind === 'change' && e.item.s === 'msg 1') && ev.some((e) => e.kind === 'change' && e.item.s === 'msg 2'));
  check('remove Bob', ev.some((e) => e.kind === 'remove' && e.key === 'Bob'));

  await until(() => eventsOf('c-test-000001').length >= 2, 8000);
  const req = eventsOf('c-test-000001');
  const r0 = req[0] || {};
  log('request event', JSON.stringify({ ...r0, body: r0.body?.slice(0, 80) }));
  check('request: auth header captured', /SECRET-/.test(r0.requestHeaders?.authorization || r0.requestHeaders?.Authorization || ''));
  check('request: body captured', /"cart":\[1,2,3\]/.test(r0.body || '') && r0.status === 200);

  // reload: the watch comes back, only real changes are reported (page state resets to Ann/Bob)
  const before = eventsOf('w-test-000001').length;
  await call('fast_nav', { tabId, url: `http://127.0.0.1:${PORT}/page?quiet`, noSnapshot: true });
  await sleep(2500);
  const after = eventsOf('w-test-000001').slice(before);
  log('after reload', JSON.stringify(after.map((e) => [e.kind, e.key, e.item?.s])));
  check('reload: diff vs last list (Bob back, Cat gone, Ann reset), not a full re-add', after.length === 3 && after.some((e) => e.kind === 'add' && e.key === 'Bob') && after.some((e) => e.kind === 'remove' && e.key === 'Cat'));
  // the page after reload still reports
  const n0 = eventsOf('c-test-000001').length;
  await sleep(2000);
  check('capture continues after reload', eventsOf('c-test-000001').length > n0);

  // service-worker restart keeps watches (registry in session storage)
  const st = await pageEval(`chrome.storage.session.get('fastlink.watches').then((o) => Object.keys(o['fastlink.watches'] || {}))`);
  check('registry persisted', JSON.stringify((st.result?.result?.value || []).sort()) === JSON.stringify(['c-test-000001', 'w-test-000001']), JSON.stringify(st.result?.result?.value));

  // kill the service worker: the page's observer wakes a new one, events keep flowing
  {
    const swt = await swTarget();
    const bt = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
    const bc = new WebSocket(bt.webSocketDebuggerUrl);
    await new Promise((r) => bc.addEventListener('open', r));
    bc.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: swt.id } }));
    await sleep(800);
    bc.close();
    const k0 = eventsOf('w-test-000001').length;
    const tabsNow = await pageEval(`chrome.tabs.query({}).then((t) => t.map((x) => x.id))`);
    log('tabs', JSON.stringify(tabsNow.result?.result?.value));
    await pageEval(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => { document.querySelector('[data-id=Ann] .s').textContent = 'after sw death'; } }).then(() => 1)`);
    await until(() => eventsOf('w-test-000001').length > k0, 10000);
    const ev2 = eventsOf('w-test-000001').slice(k0);
    log('after sw kill', JSON.stringify(ev2.map((e) => [e.kind, e.key, e.item?.s])));
    check('events after service-worker restart', ev2.some((e) => e.item?.s === 'after sw death'));
    const r0 = eventsOf('c-test-000001').length;
    await sleep(2000);
    check('capture after service-worker restart', eventsOf('c-test-000001').length > r0);
  }
  const s1 = await call('fast_watch_stop', { watchId: 'w-test-000001' });
  const s2 = await call('fast_watch_stop', { watchId: 'c-test-000001' });
  check('stop', s1.result?.stopped === true && s2.result?.stopped === true, JSON.stringify([s1, s2]));
  const nAfterStop = watchFrames.length;
  await sleep(1500);
  check('no frames after stop', watchFrames.length === nAfterStop);

  // tab close ends a watch
  await call('fast_watch', { watchId: 'w-test-000002', tabId, selector: '.row' });
  await call('fast_close', { tabId });
  await until(() => eventsOf('w-test-000002').some((e) => e.kind === 'ended'), 5000);
  check('tab close → ended', eventsOf('w-test-000002').some((e) => e.kind === 'ended' && /tab closed/.test(e.reason)));
} catch (e) {
  log('ERROR', e.stack || e);
  results.push(['harness', false]);
} finally {
  chrome.kill();
  srv.close();
  const bad = results.filter(([, ok]) => !ok);
  log(`${results.length - bad.length}/${results.length} passed`);
  if (/Uncaught|SyntaxError/.test(chromeErr)) log('chrome stderr:', chromeErr.slice(-2000));
  process.exit(bad.length ? 1 : 0);
}
