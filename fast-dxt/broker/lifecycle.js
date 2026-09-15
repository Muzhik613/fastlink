import { writeFileSync, unlinkSync, appendFileSync, statSync, truncateSync } from 'fs';
import { PID_FILE, LOG_FILE, LOG_MAX_BYTES } from './config.js';

const IDLE_MS = 60_000;
const IDLE_POLL_MS = 5_000;

// Every line lands in LOG_FILE (the durable record: connects/disconnects/hello/
// slotBusy with ISO time + label + reason). Rotation = truncate at LOG_MAX_BYTES.
// Echo to stderr only on a terminal (foreground run); when the server spawned
// us, stderr IS the log file and echoing would double every line.
export const log = (msg) => {
  const line = `[broker] ${new Date().toISOString()} ${msg}\n`;
  try {
    let size = 0;
    try { size = statSync(LOG_FILE).size; } catch {}
    if (size > LOG_MAX_BYTES) {
      truncateSync(LOG_FILE, 0);
      appendFileSync(LOG_FILE, `[broker] ${new Date().toISOString()} log rotated (exceeded ${LOG_MAX_BYTES} bytes)\n`);
    }
    appendFileSync(LOG_FILE, line);
  } catch {}
  if (process.stderr.isTTY) process.stderr.write(line);
};

export function writePidFile() {
  writeFileSync(PID_FILE, String(process.pid));
  process.on('exit', () => { try { unlinkSync(PID_FILE); } catch {} });
}

export function startIdleWatchdog({ hasMcpClients, hasExtension }) {
  let idleSince = null;
  setInterval(() => {
    const idle = !hasMcpClients() && !hasExtension();
    if (!idle) { idleSince = null; return; }
    if (!idleSince) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_MS) {
      log('idle 60s, exiting');
      process.exit(0);
    }
  }, IDLE_POLL_MS).unref?.();
}

export function onFatalListenError(label, port, e) {
  if (e.code === 'EADDRINUSE') {
    log(`${label} port ${port} already bound — another broker is running. Exiting.`);
    process.exit(0);
  }
  log(`${label} WSS error: ${e.message}`);
  process.exit(1);
}
