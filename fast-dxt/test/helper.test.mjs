// node --test — the helper against a fake relay: a real HTTP server in this process,
// a real helper process on stdio. Covers auth, browser/tabId injection, the pin,
// myTab learning/forgetting, the unpaired message, and pair/unpair file handling.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, statSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.js');
const TOKEN = 'fla_test_token';
const tmp = mkdtempSync(join(tmpdir(), 'fastlink-helper-test-'));

// ---- fake relay ----------------------------------------------------------
const calls = [];          // every tools/call the relay received: {name, arguments}
const inits = [];          // initialize params
const authSeen = [];       // Authorization headers
const sessionSeen = [];    // mcp-session-id headers
let nextTab = 100;
const liveTabs = new Set([7]);
let useSse = false;
let serveMeta = false;
let slowNext = 0;          // ms the fake relay waits before its next tools/call reply      // when true, results say which browser served them (relay _meta)

const BROWSERS = [
  { name: 'home', connected: true, lastSeen: 1 },
  { name: 'work', connected: false, lastSeen: 2 },
];
const TOOLS = [
  { name: 'fast_status', description: 's', inputSchema: { type: 'object', properties: { browser: { type: 'string' } } } },
  { name: 'fast_profile', description: 'old relay pin tool', inputSchema: { type: 'object', properties: {} } },
  { name: 'fast_snapshot', description: 'snap', inputSchema: { type: 'object', properties: { browser: { type: 'string' }, tabId: { type: 'number' }, depth: { type: 'number' } }, required: ['tabId'] } },
  { name: 'fast_switch', description: 'sw', inputSchema: { type: 'object', properties: { browser: { type: 'string' }, tabId: { type: 'number' }, match: { type: 'string' } } } },
  { name: 'fast_tab', description: 't', inputSchema: { type: 'object', properties: { browser: { type: 'string' }, url: { type: 'string' } } } },
  { name: 'fast_nav', description: 'n', inputSchema: { type: 'object', properties: { browser: { type: 'string' }, tabId: { type: 'number' }, url: { type: 'string' } } } },
];
const txt = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });

function toolResult(name, args) {
  if (name === 'fast_status') return txt({ browsers: BROWSERS, routedBrowser: args.browser || args.lastBrowser || 'home' });
  if (args.tabId != null && !liveTabs.has(args.tabId)) return txt({ error: `No tab with id: ${args.tabId}.` });
  if (name === 'fast_tab') { const id = nextTab++; liveTabs.add(id); return txt({ tabId: id, url: args.url }); }
  if (name === 'fast_nav') return txt({ tabId: args.tabId ?? 7, url: args.url });
  if (name === 'fast_switch') return txt({ tabId: args.tabId, switched: true });
  return txt({ ok: true, tabId: args.tabId ?? 7 });
}

// machines known to the fake relay's /agent/machines
const fleet = [];

const relay = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/agent/pair') {
    const { code, name } = JSON.parse(body);
    if (code !== 'GOOD-CODE') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'invalid or expired code' })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ agentToken: `fla_for_${name}` }));
  }
  if (req.url === '/agent/machines') {
    const self = String(req.headers.authorization || '').slice(7);
    const live = fleet.filter((m) => !m.revoked);
    const me = live.find((m) => m.token === self);
    if (!me) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"not_paired"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET') return res.end(JSON.stringify({ machines: live.map((m) => ({ id: m.id, name: m.name, createdAt: 1, lastSeen: null, self: m === me })) }));
    const { revoke } = JSON.parse(body);
    const hit = revoke === 'self' ? me : live.find((m) => m.id === revoke);
    hit.revoked = true;
    return res.end(JSON.stringify({ ok: true }));
  }
  authSeen.push(req.headers.authorization);
  sessionSeen.push(req.headers['mcp-session-id'] ?? null);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('unauthorized'); }
  const rpc = JSON.parse(body);
  let result; const headers = {};
  if (rpc.method === 'initialize') {
    inits.push(rpc.params);
    headers['mcp-session-id'] = 'sess-1';
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fastlink-relay', version: '1' }, instructions: 'relay instructions' };
  } else if (rpc.method === 'tools/list') {
    result = { tools: TOOLS };
  } else if (rpc.method === 'tools/call') {
    calls.push(rpc.params);
    if (slowNext) { const ms = slowNext; slowNext = 0; await new Promise((r) => setTimeout(r, ms)); }
    const a = rpc.params.arguments || {};
    result = toolResult(rpc.params.name, a);
    if (serveMeta) result = { ...result, _meta: { 'fastlink/browser': a.browser || a.lastBrowser || 'home' } };
  }
  const reply = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
  if (useSse) {
    res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
    return res.end(`event: message\ndata: ${reply}\n\n`);
  }
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(reply);
});
let RELAY_URL;

// ---- stdio MCP client to a spawned helper --------------------------------
function startHelper(agentFile) {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, FASTLINK_AGENT_FILE: agentFile } });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m); waiting.delete(m.id);
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    waiting.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const json = (r) => JSON.parse(r.content[0].text);
  return { child, rpc, call, json, stop: () => child.kill() };
}

function writeAgent(file, extra = {}) {
  writeFileSync(file, JSON.stringify({ relay: RELAY_URL, agentToken: TOKEN, name: 'testbox', pairedAt: 'x', ...extra }));
  return file;
}

before(async () => {
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  RELAY_URL = `http://127.0.0.1:${relay.address().port}`;
});
after(() => { relay.close(); rmSync(tmp, { recursive: true, force: true }); });

test('initialize forwards with the helper clientInfo; tools/list hides routing args and adds fast_profile', async (t) => {
  const h = startHelper(writeAgent(join(tmp, 'a1.json')));
  t.after(h.stop);
  const init = await h.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1' } });
  assert.equal(init.result.instructions, 'relay instructions');
  assert.equal(init.result.serverInfo.name, 'fastlink-helper');
  assert.equal(inits.at(-1).clientInfo.name, `fastlink-helper@${hostname()}`);
  assert.match(inits.at(-1).clientInfo.version, /claude-code\/2\.1/);
  assert.equal(authSeen.at(-1), `Bearer ${TOKEN}`);

  const { tools } = (await h.rpc('tools/list', {})).result;
  assert.equal(sessionSeen.at(-1), 'sess-1', 'keeps the relay Mcp-Session-Id');
  const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(byName.fast_snapshot.inputSchema.properties), ['tabId', 'depth'], 'tabId visible (bug #21), browser hidden');
  assert.match(byName.fast_snapshot.inputSchema.properties.tabId.description, /this session/);
  assert.deepEqual(byName.fast_snapshot.inputSchema.required, []);
  assert.ok(!('browser' in byName.fast_status.inputSchema.properties));
  assert.ok('tabId' in byName.fast_switch.inputSchema.properties, 'fast_switch keeps its own tabId');
  assert.ok(!('browser' in byName.fast_switch.inputSchema.properties));
  assert.equal(tools.filter((x) => x.name === 'fast_profile').length, 1);
  assert.match(byName.fast_profile.description, /auto/);
});

test('pin, auto, and myTab learn/forget', async (t) => {
  const h = startHelper(writeAgent(join(tmp, 'a2.json')));
  t.after(h.stop);
  await h.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cc', version: '1' } });

  // No pin, no tab yet: nothing injected.
  await h.call('fast_snapshot');
  assert.deepEqual(calls.at(-1).arguments, {});

  // fast_tab result teaches the default browser's tab.
  const opened = h.json(await h.call('fast_tab', { url: 'https://a.test' }));
  assert.deepEqual(calls.at(-1).arguments, { url: 'https://a.test', scoped: true }, 'fast_tab: no tabId, always scoped (never moves the shared target)');
  await h.call('fast_snapshot');
  assert.deepEqual(calls.at(-1).arguments, { tabId: opened.tabId });

  // The model's own tabId wins.
  await h.call('fast_snapshot', { tabId: 7 });
  assert.equal(calls.at(-1).arguments.tabId, 7);

  // Unknown browser: refused, pin unchanged; the reply lists browsers by name.
  const bad = h.json(await h.call('fast_profile', { install: 'nope' }));
  assert.match(bad.error, /home, work \(offline\)/);
  await h.call('fast_snapshot');
  assert.equal(calls.at(-1).arguments.browser, undefined);

  // Pin via the `browser` alias; the pinned browser has no tab yet.
  const pinned = h.json(await h.call('fast_profile', { browser: 'Work' }));
  assert.equal(pinned.pinned, 'work');
  assert.deepEqual(pinned.browsers.map((b) => b.name), ['home', 'work']);
  assert.match(pinned.hint, /offline/);
  assert.equal(calls.at(-1).name, 'fast_status', 'validated against relay fast_status');
  await h.call('fast_snapshot');
  assert.deepEqual(calls.at(-1).arguments, { browser: 'work' });
  await h.call('fast_switch', { tabId: 7 });
  assert.deepEqual(calls.at(-1).arguments, { tabId: 7, browser: 'work' });
  await h.call('fast_snapshot');
  assert.deepEqual(calls.at(-1).arguments, { browser: 'work', tabId: 7 }, 'learned from fast_switch');

  // auto clears the pin; the default browser's tab is remembered separately.
  const auto = h.json(await h.call('fast_profile', { install: 'auto' }));
  assert.equal(auto.pinned, null);
  await h.call('fast_snapshot');
  assert.deepEqual(calls.at(-1).arguments, { tabId: opened.tabId });

  // The tab goes away: the error comes back, and the helper forgets it.
  liveTabs.delete(opened.tabId);
  const gone = await h.call('fast_snapshot');
  assert.match(gone.content[0].text, /No tab with id/);
  await h.call('fast_snapshot');
  assert.deepEqual(calls.at(-1).arguments, {}, 'forgot the dead tab');
});

test('event-stream responses are read too', async (t) => {
  useSse = true;
  t.after(() => { useSse = false; });
  const h = startHelper(writeAgent(join(tmp, 'a3.json')));
  t.after(h.stop);
  const { tools } = (await h.rpc('tools/list', {})).result;
  assert.ok(tools.some((x) => x.name === 'fast_snapshot'));
  assert.deepEqual(h.json(await h.call('fast_nav', { url: 'https://b.test' })), { tabId: 7, url: 'https://b.test' });
});

test('a rejected token says how to re-pair', async (t) => {
  const h = startHelper(writeAgent(join(tmp, 'a4.json'), { agentToken: 'fla_revoked' }));
  t.after(h.stop);
  const r = await h.call('fast_snapshot');
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /401.*pair/s);
});

test('unpaired: minimal tools/list, every call explains pairing', async (t) => {
  const h = startHelper(join(tmp, 'missing.json'));
  t.after(h.stop);
  const before = calls.length;
  const init = await h.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cc', version: '1' } });
  assert.match(init.result.instructions, /pair\/new/);
  const { tools } = (await h.rpc('tools/list', {})).result;
  assert.deepEqual(tools.map((x) => x.name).sort(), ['fast_profile', 'fast_status']);
  for (const name of ['fast_status', 'fast_snapshot', 'fast_profile']) {
    const text = (await h.call(name)).content[0].text;
    assert.match(text, /https:\/\/relay\.ytx\.app\/pair\/new/);
    assert.ok(text.includes(`${SERVER} pair <CODE>`), text);
  }
  assert.equal(calls.length, before, 'nothing reached the relay');
});

test('pair writes agent.json 0600 in a 0700 dir; unpair removes it', async () => {
  const run = promisify(execFile);
  const file = join(tmp, 'pairdir', 'nested', 'agent.json');
  const env = { ...process.env, FASTLINK_AGENT_FILE: file };

  await assert.rejects(run(process.execPath, [SERVER, 'pair', 'BAD', '--relay', RELAY_URL], { env }), /invalid or expired code/);
  assert.ok(!existsSync(file));

  const out = await run(process.execPath, [SERVER, 'pair', 'GOOD-CODE', '--name', 'laptop', '--relay', RELAY_URL], { env });
  assert.match(out.stdout, /Paired "laptop"/);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.agentToken, 'fla_for_laptop');
  assert.equal(saved.relay, RELAY_URL);
  assert.equal(saved.name, 'laptop');
  assert.ok(saved.pairedAt);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);

  assert.match((await run(process.execPath, [SERVER, 'unpair'], { env })).stdout, /Unpaired/);
  assert.ok(!existsSync(file));
  assert.match((await run(process.execPath, [SERVER, 'unpair'], { env })).stdout, /Not paired/);
});

test('machines lists the account, revoke <name> revokes another, unpair revokes self and deletes the file', async () => {
  const run = promisify(execFile);
  const file = join(tmp, 'fleet', 'agent.json');
  const env = { ...process.env, FASTLINK_AGENT_FILE: file };
  mkdirSync(join(tmp, 'fleet'), { recursive: true });
  writeFileSync(file, JSON.stringify({ relay: RELAY_URL, agentToken: 'fla_me', name: 'laptop', pairedAt: 'x' }));
  fleet.push({ id: 'aaaaaaaaaaaa', name: 'laptop', token: 'fla_me' }, { id: 'bbbbbbbbbbbb', name: 'old-mac', token: 'fla_old' });
  const ls = (await run(process.execPath, [SERVER, 'machines'], { env })).stdout;
  assert.match(ls, /aaaaaaaaaaaa\s+laptop.*\(this machine\)/);
  assert.match(ls, /bbbbbbbbbbbb\s+old-mac/);
  await assert.rejects(run(process.execPath, [SERVER, 'revoke', 'laptop'], { env }), /this machine.*unpair/s);
  assert.match((await run(process.execPath, [SERVER, 'revoke', 'old-mac'], { env })).stdout, /Revoked "old-mac"/);
  assert.equal(fleet[1].revoked, true);
  assert.match((await run(process.execPath, [SERVER, 'unpair'], { env })).stdout, /Unpaired\. Revoked on the relay\./);
  assert.equal(fleet[0].revoked, true);
  assert.equal(existsSync(file), false);
});

test('no pin: the browser that served the last call is sent as the lastBrowser hint, per session and per machine', async (t) => {
  serveMeta = true;
  t.after(() => { serveMeta = false; });
  const dir = join(tmp, 'hint'); mkdirSync(dir, { recursive: true });
  const agentFile = writeAgent(join(dir, 'agent.json'));
  const a = startHelper(agentFile); t.after(a.stop);
  await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cc', version: '1' } });

  // Fresh machine: no hint. The relay picked 'home' (the only one online).
  await a.call('fast_snapshot');
  assert.deepEqual(calls.at(-1).arguments, {});
  // From now on this session hints 'home'.
  await a.call('fast_snapshot');
  assert.deepEqual(calls.at(-1).arguments, { lastBrowser: 'home' });
  // The machine remembers it for the NEXT session.
  assert.equal(JSON.parse(readFileSync(join(dir, 'last-browser.json'), 'utf8')).browser, 'home');
  assert.equal(statSync(join(dir, 'last-browser.json')).mode & 0o777, 0o600);
  const b = startHelper(agentFile); t.after(b.stop);
  await b.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cc', version: '1' } });
  await b.call('fast_snapshot');
  assert.deepEqual(calls.at(-1).arguments, { lastBrowser: 'home' }, 'second session starts from the machine hint');

  // A pin is hard and replaces the hint; the model's explicit browser wins over both.
  await a.call('fast_profile', { install: 'work' });
  await a.call('fast_snapshot');
  assert.deepEqual(calls.at(-1).arguments, { browser: 'work' });
  await a.call('fast_snapshot', { browser: 'home' });
  assert.deepEqual(calls.at(-1).arguments, { browser: 'home' });

  // 'auto' drops the pin; the hint is now the last browser that served this session.
  const auto = a.json(await a.call('fast_profile', { install: 'auto' }));
  assert.equal(auto.pinned, null);
  assert.match(auto.hint, /only online browser/);
  await a.call('fast_snapshot');
  assert.deepEqual(calls.at(-1).arguments, { lastBrowser: 'home' });
});

test('call.js: scripts call FastLink with the machine pairing, browser on every call, broker-like replies', async () => {
  const file = writeAgent(join(tmp, 'script-agent.json'));
  const prev = process.env.FASTLINK_AGENT_FILE;
  process.env.FASTLINK_AGENT_FILE = file;
  try {
    const { connect } = await import('../server/call.js');
    const fl = await connect({ browser: 'home', client: 'costar-sweep' });
    assert.match(inits.at(-1).clientInfo.version, /costar-sweep/);
    const tab = await fl.call('fast_tab', { url: 'https://x.test' });
    assert.deepEqual(calls.at(-1).arguments, { url: 'https://x.test', browser: 'home' });
    assert.equal(typeof tab.result.tabId, 'number');
    const ok = await fl.call('fast_snapshot', { tabId: tab.result.tabId });
    assert.deepEqual(calls.at(-1).arguments, { tabId: tab.result.tabId, browser: 'home' });
    assert.equal(ok.result.ok, true);
    const bad = await fl.call('fast_snapshot', { tabId: 99999 });
    assert.match(bad.error, /No tab with id/);
    assert.equal('result' in bad, false);
    slowNext = 300;
    await assert.rejects(fl.call('fast_snapshot', { tabId: tab.result.tabId }, { timeoutMs: 50 }), /timeout fast_snapshot/);
  } finally {
    if (prev === undefined) delete process.env.FASTLINK_AGENT_FILE; else process.env.FASTLINK_AGENT_FILE = prev;
  }
});
