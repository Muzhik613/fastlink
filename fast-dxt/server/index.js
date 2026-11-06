#!/usr/bin/env node
// FastLink helper — one per Claude Code session (MCP over stdio), forwarding to the relay.
//
//   node index.js                                  MCP stdio server (what Claude Code runs)
//   node index.js pair <CODE> [--name <machine>] [--relay <url>]
//                                                  pair this machine once (code: https://relay.ytx.app/pair/new)
//   node index.js unpair                           revoke this machine on the relay and forget it
//   node index.js machines                         list this account's paired machines
//   node index.js revoke <id|name>                 revoke another machine (e.g. a lost laptop)
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadAgent, pair, removeAgent, agentFilePath, listMachines, revokeMachine, lastBrowserStore, DEFAULT_RELAY, PAIR_URL } from './agentFile.js';
import { createHelper } from './helper.js';
import { log } from './log.js';

const SELF = fileURLToPath(import.meta.url);
const PAIR_COMMAND = `node ${SELF} pair`;

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function runPair(argv) {
  const code = argv.find((a, i) => i > 0 && !a.startsWith('--') && !argv[i - 1].startsWith('--'));
  if (!code) {
    console.error(`usage: ${PAIR_COMMAND} <CODE> [--name <machine>] [--relay <url>]\nGet a code at ${PAIR_URL}`);
    process.exit(2);
  }
  const name = flag(argv, '--name') || hostname();
  const relay = flag(argv, '--relay') || DEFAULT_RELAY;
  try {
    const { file } = await pair({ code: code.trim(), name, relay });
    console.log(`Paired "${name}" with ${relay}. Saved to ${file}.\nReconnect FastLink in Claude Code (/mcp) to use it.`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

function requireAgent() {
  const agent = loadAgent();
  if (!agent) { console.error(`Not paired (${agentFilePath()} doesn't exist). Pair first: ${PAIR_COMMAND} <CODE>`); process.exit(1); }
  return agent;
}

const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : 'never');

async function runMachines() {
  const list = await listMachines(requireAgent());
  for (const m of list) console.log(`${m.id}  ${String(m.name || '(no name)').padEnd(24)} paired ${when(m.createdAt)}  last used ${when(m.lastSeen)}${m.self ? '  (this machine)' : ''}`);
  if (!list.length) console.log('No machines.');
}

async function runRevoke(which) {
  if (!which) { console.error(`usage: ${PAIR_COMMAND.replace(/ pair$/, '')} revoke <id|name>  (ids from: machines)`); process.exit(2); }
  const agent = requireAgent();
  const list = await listMachines(agent);
  const hits = list.filter((m) => m.id === which || m.name === which);
  if (hits.length !== 1) {
    console.error(hits.length ? `"${which}" matches ${hits.length} machines; use its id:` : `No machine "${which}". Machines:`);
    for (const m of (hits.length ? hits : list)) console.error(`  ${m.id}  ${m.name || '(no name)'}`);
    process.exit(1);
  }
  if (hits[0].self) { console.error('That is this machine. Use: unpair'); process.exit(1); }
  await revokeMachine(agent, hits[0].id);
  console.log(`Revoked "${hits[0].name || hits[0].id}" (${hits[0].id}). Its token no longer works.`);
}

async function runUnpair() {
  const agent = loadAgent();
  if (!agent) return console.log(`Not paired (${agentFilePath()} doesn't exist).`);
  let note = 'Revoked on the relay.';
  try { await revokeMachine(agent, 'self'); }
  catch (e) { note = `Could NOT revoke it on the relay (${e.message}); revoke it from another machine with: revoke ${agent.name || '<id>'}`; }
  removeAgent();
  console.log(`Unpaired. ${note} Removed ${agentFilePath()}.`);
}

function serve() {
  const helper = createHelper({ loadAgent, pairCommand: PAIR_COMMAND, lastBrowserStore });
  const write = (msg) => { if (msg) process.stdout.write(JSON.stringify(msg) + '\n'); };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    // Requests run concurrently: parallel tool calls on different tabs mustn't wait on each other.
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      helper.handle(m).then(write, (e) => log(`handler crashed: ${e.stack || e}`));
    }
  });
  // A stdio server lives exactly as long as its parent: when the pipe closes (clean exit,
  // crash, SIGKILL) stdin ends and we exit. hvm 2026-09-16 had 350 orphans before this.
  // Covered by test/stdio-orphan.test.mjs.
  const exitWithParent = () => process.exit(0);
  process.stdin.once('end', exitWithParent);
  process.stdin.once('close', exitWithParent);
  log(`helper up (${loadAgent() ? 'paired' : `unpaired: ${agentFilePath()} missing`})`);
}

const cmd = process.argv[2];
if (cmd === 'pair') await runPair(process.argv.slice(2));
else if (cmd === 'unpair') await runUnpair();
else if (cmd === 'machines') await runMachines().catch((e) => { console.error(e.message); process.exit(1); });
else if (cmd === 'revoke') await runRevoke(process.argv[3]).catch((e) => { console.error(e.message); process.exit(1); });
else if (cmd === undefined) serve();
else { console.error(`unknown command "${cmd}". Commands: pair <CODE> [--name <machine>] [--relay <url>], unpair, machines, revoke <id|name>`); process.exit(2); }
