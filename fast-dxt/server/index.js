#!/usr/bin/env node
import { startStdio, startHttp } from './transports.js';
import { startHotReload } from './hotReload.js';
import { getStatus } from './brokerClient.js';
import { sweepOldScreenshots } from './handlers.js';
import { HTTP_ENABLED } from './config.js';

sweepOldScreenshots();
startHotReload();
await startStdio();
if (HTTP_ENABLED) await startHttp();
else {
  // A stdio MCP server lives exactly as long as its parent. However the parent
  // dies — clean exit, crash, timeout kill, SIGKILL — the pipe's write end closes
  // and stdin ends here. Nothing else would ever stop this process (the broker
  // socket keeps the event loop alive), so it was reparented to init and ran
  // forever: hvm 2026-09-16, 350 orphans, 10.5 GB. --http instances are
  // long-lived by design and keep running. Covered by test/stdio-orphan.test.mjs.
  const exitWithParent = () => process.exit(0);
  process.stdin.once('end', exitWithParent);
  process.stdin.once('close', exitWithParent);
}

// Pre-warm the broker so the extension can auto-connect as soon as Chrome
// opens — without this, the broker spawns lazily on the first tool call,
// leaving the extension with nothing to attach to in the meantime.
getStatus().catch(() => {});
