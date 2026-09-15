#!/usr/bin/env node
// relay-login.mjs — one-time relay sign-in + smoke check.
//   node relay-login.mjs [--reset] [--browser <name>]
// --reset wipes ~/.config/fastrun/relay-token.json first (re-register + re-login).
import { connectRelay, clearStore, TOKEN_FILE } from './relay-transport.mjs';

const argv = process.argv.slice(2);
const has = (n) => { const i = argv.indexOf(n); if (i === -1) return false; argv.splice(i, 1); return true; };
const flag = (n) => { const i = argv.indexOf(n); if (i === -1) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };

if (has('--reset')) { clearStore(); console.error(`[fastrun] cleared ${TOKEN_FILE}`); }
const browser = flag('--browser');

const relay = await connectRelay({ browser });
const tools = await relay.listTools();
const status = await relay.callTool('fast_status', {});
console.log(JSON.stringify({ tools: tools.map((t) => t.name), status: JSON.parse(status.content[0].text) }, null, 2));
await relay.close();
