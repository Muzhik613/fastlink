// log.js — the helper's one log: stderr (Claude Code's MCP log) AND a file next to the
// pairing (~/.fastlink/helper.log). The file is what survives when stderr does not: a
// helper whose parent pipe is gone, or that was killed, leaves nothing in the MCP log
// (Alex b1 11-11: the helper vanished overnight with no error anywhere). The file is
// shared by every helper on the machine, so each line carries the pid; it is cut to its
// last half when it passes 1 MB. FASTLINK_LOG_FILE overrides the path (tests).
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentFilePath } from './agentFile.js';

const MAX_BYTES = 1024 * 1024;
export const logFilePath = () => process.env.FASTLINK_LOG_FILE || join(dirname(agentFilePath()), 'helper.log');

function toFile(line) {
  try {
    const file = logFilePath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, line, { mode: 0o600 });
    if (statSync(file).size > MAX_BYTES) {
      const s = readFileSync(file, 'utf8');
      writeFileSync(file, s.slice(s.indexOf('\n', s.length / 2) + 1), { mode: 0o600 });
    }
  } catch { /* logging must never take the helper down */ }
}

export const log = (msg) => {
  const line = `[fastlink] ${new Date().toISOString()} pid=${process.pid} ${msg}\n`;
  try { process.stderr.write(line); } catch { /* stderr gone: the file still has it */ }
  toFile(line);
};
