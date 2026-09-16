// Screen recording for every run: a thin wrapper over scripts/record.sh (the one recorder — it picks
// gdigrab on WSL / x11grab on the hvm rig, and verifies the file with ffprobe on stop).
// Neither function ever throws: a broken recorder must not fail a run, it must say the run went
// unrecorded. Both resolve to a plain object that lands on the run's runs.jsonl row as `video`.
// FASTRUN_RECORD=off is the ONE opt-out (default on): the row then says {recorded:false, reason:"disabled"},
// so an unrecorded run is never silent. It exists for same-commit overhead A/Bs on the bench rig.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/record.sh', import.meta.url));

function recordSh(args, timeoutMs) {
  return new Promise(resolve => {
    execFile('bash', [SCRIPT, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const kv = {};
      for (const line of String(stdout).split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
      }
      if (!err) return resolve({ ok: true, kv });
      const fail = String(stderr).split('\n').filter(l => l.includes('[record] FAIL')).pop();
      resolve({ ok: false, kv, error: (fail || err.message || String(err)).replace('[record] FAIL: ', '').trim() });
    });
  });
}

export const recordingDisabled = (env = process.env) => String(env.FASTRUN_RECORD || '').toLowerCase() === 'off';

// { path, mode, region, warning? } | { recorded: false, error } | { recorded: false, reason: 'disabled' }
export async function startRecording(runId, { maxSec = 1800, env = process.env } = {}) {
  if (recordingDisabled(env)) return { recorded: false, reason: 'disabled' };
  const r = await recordSh(['start', runId, '--max', String(Math.ceil(maxSec))], 45_000);
  if (!r.ok) return { recorded: false, error: `recording did not start: ${r.error}` };
  const { path, mode, region, warning } = r.kv;
  return { path, mode, region, ...(warning ? { warning } : {}) };
}

// Adds { recorded: true, durationSec, bytes } or { recorded: false, error } to what start returned.
export async function stopRecording(runId, started) {
  if (!started || started.recorded === false) return started || { recorded: false, error: 'recording never started' };
  const r = await recordSh(['stop', runId], 90_000);
  if (!r.ok) return { ...started, recorded: false, error: `recording failed: ${r.error}` };
  return { ...started, recorded: true, durationSec: Number(r.kv.durationSec), bytes: Number(r.kv.bytes) };
}
