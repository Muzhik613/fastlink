// lockFile.js — lock codes for secure browsers this machine drives (fast-ext/secure-only/).
// One file per browser: <dir of agent.json>/locks/<browser>.key holding the 43-char lock
// code (dir 0700, file 0600). FASTLINK_LOCK_DIR overrides the directory (tests). The code
// never goes to the relay: a human pastes it into that browser's FastLink options.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentFilePath } from './agentFile.js';

// The sealed format lives with the extension; scripts run from a full checkout.
export const SEALED_JS = new URL('../../fast-ext/secure-only/src/secure/sealed.js', import.meta.url).href;

export const lockDir = () => process.env.FASTLINK_LOCK_DIR || join(dirname(agentFilePath()), 'locks');

function lockPath(browser) {
  const name = String(browser || '');
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`not a browser name: "${name}"`);
  return join(lockDir(), `${name}.key`);
}

// The lock code for `browser`, or null when this machine holds none.
export function loadLockCode(browser) {
  try {
    const code = readFileSync(lockPath(browser), 'utf8').trim();
    return /^[A-Za-z0-9_-]{43}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

// Create a new lock code for `browser` (refuses to replace one unless `replace`).
export async function createLock(browser, { replace = false } = {}) {
  const file = lockPath(browser);
  if (existsSync(file) && !replace) throw new Error(`${file} exists; use --replace to make a new code (the browser then needs the new one)`);
  const { newLockCode } = await import(SEALED_JS);
  const code = newLockCode();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  writeFileSync(file, code + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, code };
}

export function removeLock(browser) {
  const file = lockPath(browser);
  const had = existsSync(file);
  rmSync(file, { force: true });
  return { file, had };
}
