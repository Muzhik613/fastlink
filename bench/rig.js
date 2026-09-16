// rig.js — whole-browser reset for the DEDICATED bench rig (hvm), and the proof that we are on it.
//
// WHY: a cell's own reset closes only the tabs matching ITS closeUrlPatterns. Tabs opened by
// other cells, or by a model that wandered off, were never closed by anyone. On 2026-09-16 the
// hvm rig Chrome had 100+ tabs at 5.3 GB RSS, on a host that also runs frontdesk production.
// So on the rig, EVERY cell starts from ONE known state: exactly one about:blank tab, whatever ran
// before.
//
// WHY THE DEVTOOLS ENDPOINT, NOT fast_list/fast_close: the extension's fast_list only queries the
// CURRENT window (fast-ext/src/actions/tab.js listTabs), so tabs in any other window, e.g. one
// fast_tab created on its no-current-window path, are invisible to it and would still leak.
// The DevTools HTTP endpoint (/json/list) lists EVERY page target in the browser, in every window.
//
// ── THE OWNER'S REAL CHROME CAN NEVER BE RESET THROUGH THIS PATH ──
// Close-everything runs only when ALL of these hold, checked on every cell:
//   1. FASTLINK_RIG_PROFILE and FASTLINK_RIG_CDP_PORT are set. Only bench/hvm-rig.sh exports
//      them; nothing on the owner's machine does.
//   2. A process is LISTENING on 127.0.0.1:<port> ON THIS HOST, and it is owned by this user
//      (`ss -p` names only our own processes).
//   3. That process's command line (/proc/<pid>/cmdline) contains BOTH
//      --user-data-dir=<FASTLINK_RIG_PROFILE> and --remote-debugging-port=<port>. The rig
//      Chrome is the only browser launched that way.
// The owner's Chrome fails all three: it runs on Windows, with his own profile and no
// remote-debugging port, so there is no endpoint on this host for it to answer on. If (1) is set
// but (2) or (3) fails, the cell THROWS instead of falling back to the per-cell reset: a rig that
// can't be reset is the leak this file exists to stop, and silently leaking again is the bug.
// With (1) unset, e.g. every run on the owner's signed-in profile for cfworkers or Azure,
// run.js uses only the per-cell `closeUrlPatterns` and leaves every other tab alone.
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

/** Is this process driving the dedicated rig browser? `{ rig:false }` when not configured;
 *  throws when configured but unproven. Deps are injectable for tests. */
export function rigIdentity({
  env = process.env,
  listenerPid = (port) => {
    const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    const m = out.match(/pid=(\d+)/);
    return m ? Number(m[1]) : null;
  },
  cmdline = (pid) => readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
} = {}) {
  const profile = env.FASTLINK_RIG_PROFILE;
  const port = env.FASTLINK_RIG_CDP_PORT;
  if (!profile && !port) return { rig: false };
  if (!profile || !port) throw new Error('rig reset: FASTLINK_RIG_PROFILE and FASTLINK_RIG_CDP_PORT must be set together (bench/hvm-rig.sh exports both)');
  let pid = null;
  try { pid = listenerPid(port); } catch (e) { throw new Error(`rig reset: cannot inspect listeners on :${port} (${e.message})`); }
  if (!pid) throw new Error(`rig reset: nothing of ours listens on :${port}; the rig Chrome must be (re)started by bench/hvm-rig.sh with --remote-debugging-port=${port}`);
  const args = cmdline(pid);
  const okProfile = args.includes(`--user-data-dir=${profile}`);
  const okPort = args.includes(`--remote-debugging-port=${port}`);
  if (!okProfile || !okPort) {
    throw new Error(`rig reset: the listener on :${port} (pid ${pid}) is NOT the rig Chrome (needs --user-data-dir=${profile} and --remote-debugging-port=${port}); refusing to close anything`);
  }
  return { rig: true, port: Number(port), pid, profile };
}

/** Leave the rig browser with exactly ONE about:blank tab. Opens the blank tab FIRST, so the
 *  browser never has zero windows, which would make Chrome quit. Then closes every other page
 *  target, in every window. Verifies by re-listing; throws if the end state is not exactly one
 *  blank tab. Service workers (the extension) are not page targets and are never touched. */
export async function resetRigBrowser(port, { fetchImpl = fetch, host = '127.0.0.1', settleTries = 25, settleMs = 200 } = {}) {
  const base = `http://${host}:${port}`;
  const pages = async () => (await (await fetchImpl(`${base}/json/list`)).json()).filter((t) => t.type === 'page');
  const before = await pages();
  // PUT: Chrome ≥111 refuses GET on /json/new.
  const blank = await (await fetchImpl(`${base}/json/new?about:blank`, { method: 'PUT' })).json();
  const closed = [];
  for (const t of before) {
    if (t.id === blank.id) continue;
    const r = await fetchImpl(`${base}/json/close/${t.id}`);
    if (r.ok) closed.push(t.url);
  }
  // /json/close answers "Target is closing": closing is ASYNC, so an immediate re-list can still
  // show tabs on their way out. Poll briefly for the end state before calling it a failure.
  let after = await pages();
  for (let i = 0; i < settleTries && !(after.length === 1 && after[0].id === blank.id); i++) {
    await new Promise((r) => setTimeout(r, settleMs));
    after = await pages();
  }
  if (after.length !== 1 || after[0].id !== blank.id) {
    const shown = after.slice(0, 8).map((t) => t.url).join(' , ');
    throw new Error(`rig reset: expected exactly 1 blank tab, found ${after.length}: ${shown}${after.length > 8 ? ' , …' : ''}`);
  }
  return { before: before.length, closed };
}
