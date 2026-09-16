#!/usr/bin/env node
import { startExtBridge } from './extBridge.js';
import { startMcpBridge, hasMcpClients } from './mcpBridge.js';
import { state } from './state.js';
import { log, writePidFile, startIdleWatchdog } from './lifecycle.js';

writePidFile();
startExtBridge();
startMcpBridge();
startIdleWatchdog({ hasMcpClients, hasExtension: () => state.isExtensionConnected() });

log(`broker ready (pid ${process.pid})`);
