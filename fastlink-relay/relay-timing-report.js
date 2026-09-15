#!/usr/bin/env node
// relay-timing-report.js — render a CLOUD-RELAY tool-call timing trace in the
// SAME format as the local server's `node fast-dxt/server/timing-report.js`, so a
// relay run (Claude / Grok / GPT driving through relay.ytx.app) and a local run
// compare line for line. Both render through fast-dxt/server/timing-format.js.
//
// Auth: the relay's /trace endpoint is device-token-authed (same token the
// FastLink extension already holds — the same credential /consent and
// /settings/gemini-key use). Get it from the extension's service worker console:
//   chrome.storage.local.get('deviceToken', console.log)
//
// Usage:
//   FASTLINK_DEVICE_TOKEN=<token> node relay-timing-report.js               # list sessions
//   FASTLINK_DEVICE_TOKEN=<token> node relay-timing-report.js latest        # newest session
//   FASTLINK_DEVICE_TOKEN=<token> node relay-timing-report.js <sessionId>
//   node relay-timing-report.js --token <token> latest
// Options: --base <url> (default https://relay.ytx.app), --limit <n>
import { formatTimingReport } from '../fast-dxt/server/timing-format.js';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v ?? fallback;
};

const base = (opt('--base', process.env.FASTLINK_RELAY_BASE || 'https://relay.ytx.app')).replace(/\/+$/, '');
const token = opt('--token', process.env.FASTLINK_DEVICE_TOKEN || '');
const limit = opt('--limit', '');
const session = argv[0] || '';

if (!token) {
  console.error('Missing device token. Set FASTLINK_DEVICE_TOKEN or pass --token <token>.');
  console.error("Get it in the FastLink extension service worker console: chrome.storage.local.get('deviceToken', console.log)");
  process.exit(1);
}

const url = new URL(`${base}/trace`);
url.searchParams.set('deviceToken', token);
if (session) url.searchParams.set('session', session);
if (limit) url.searchParams.set('limit', limit);

const res = await fetch(url);
const body = await res.json().catch(() => null);
if (!res.ok || !body || body.error) {
  console.error(`relay /trace failed (${res.status}): ${body?.error || 'unreadable response'}`);
  process.exit(1);
}

// No session argument → list what's stored so you can pick one.
if (body.sessions) {
  if (!body.sessions.length) {
    console.log('No relay traces stored yet — drive the browser through the relay first.');
    process.exit(0);
  }
  console.log('  started              calls  client                     session');
  console.log('  -------------------  -----  -------------------------  -------');
  for (const s of body.sessions) {
    const when = new Date(s.startedAt).toISOString().replace('T', ' ').slice(0, 19);
    const client = [s.client?.name, s.client?.version].filter(Boolean).join(' ') || s.ua || 'unknown';
    console.log(`  ${when}  ${String(s.calls).padStart(5)}  ${client.slice(0, 25).padEnd(25)}  ${s.id}`);
  }
  console.log('\n  Render one:  node relay-timing-report.js <sessionId>   (or "latest")');
  process.exit(0);
}

const s = body.session || {};
const client = [s.client?.name, s.client?.version].filter(Boolean).join(' ') || s.ua || 'unknown-client';
console.log(formatTimingReport(body.rows || [], {
  label: s.client?.name || 'Model',
  header: `  cloud relay — client "${client}"  session ${s.id}  started ${new Date(s.startedAt).toISOString()}\n`,
}));
