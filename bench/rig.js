// rig.js — whole-browser tab reset for the DEDICATED bench rig (hvm), and the proof that we are on it.
//
// WHY: a cell's own reset closes only the tabs matching ITS closeUrlPatterns. Tabs opened by
// other cells, or by a model that wandered off, were never closed by anyone. On 2026-09-16 the
// hvm rig Chrome had 100+ tabs at 5.3 GB RSS, on a host that also runs frontdesk production.
// So on the rig, EVERY cell starts from ONE known state: exactly one about:blank tab, whatever ran
// before.
//
// Through the extension (fast_list + fast_close over the local broker), no new tool. fast_list
// lists EVERY window (fast-ext/src/actions/tab.js listTabs); before that fix it only saw the
// current window, and tabs in other windows leaked past any reset.
//
// NO DevTools port: a --remote-debugging-port on 127.0.0.1 is reachable by EVERY account on the
// multi-user hvm host. CDP gives full browser control, including reading file:/// as the dev user,
// so it was a cross-user escalation path on a production host. Do not bring it back for this.
//
// ── THE OWNER'S REAL CHROME CAN NEVER BE RESET THROUGH THIS PATH ──
// Close-everything runs only when BOTH hold, checked on every cell:
//   1. FASTLINK_RIG_INSTALL is set. Only bench/hvm-rig.sh exports it; nothing on the owner's
//      machine does. It must be a dedicated label: never `primary` or `secondary`, the owner's
//      two profile slots (Profile 1 / Profile 6).
//   2. The broker install this cell is pinned to (run.js --install) IS that label, the broker
//      reports this session's selected install as that label, and that install is CONNECTED.
//      A slot label is chosen per Chrome profile, so a cell pinned to the owner's primary or
//      secondary can never pass.
// Set but failing either check → THROW. It never falls back to the per-cell reset, because a rig
// that can't be reset is the leak this exists to stop. Unset (every run on the owner's
// signed-in profile, cfworkers, Azure) → run.js closes only that test's closeUrlPatterns.
import { fl, tabs as listTabs } from './fastlink.js';

const OWNER_SLOTS = new Set(['primary', 'secondary']);

/** `{ rig:false }` when not configured; `{ rig:true, label }` when proven; throws otherwise.
 *  `install` is the label run.js pinned; `status` is fast_status (injectable for tests). */
export async function rigIdentity({ env = process.env, install, status = () => fl('fast_status', {}) } = {}) {
  const label = env.FASTLINK_RIG_INSTALL;
  if (!label) return { rig: false };
  if (OWNER_SLOTS.has(label)) throw new Error(`rig reset: FASTLINK_RIG_INSTALL="${label}" is one of the owner's profile slots; the rig needs its own label (bench/hvm-rig.sh)`);
  if (install !== label) throw new Error(`rig reset: this cell is pinned to install "${install}", not the rig's "${label}"; refusing to close anything (pass --install ${label})`);
  const st = await status();
  const selected = st?.selectedInstall ?? null;
  if (selected !== label) throw new Error(`rig reset: the broker's selected install is "${selected}", not the rig's "${label}"; refusing to close anything`);
  if (!st?.installs?.[label]?.connected) throw new Error(`rig reset: rig install "${label}" is not connected to the broker (connected: ${Object.keys(st?.installs || {}).filter((k) => st.installs[k]?.connected).join(', ') || 'none'})`);
  return { rig: true, label };
}

/** Leave the rig browser with exactly ONE about:blank tab, across ALL windows. Keeps an existing
 *  about:blank (or opens one FIRST, so Chrome never has zero windows and quits), closes every other
 *  tab by id, re-lists, and throws unless exactly that one blank tab remains. */
export async function resetRigBrowser({ list = listTabs, call = fl, settleTries = 25, settleMs = 200 } = {}) {
  const before = await list();
  let keep = before.find((t) => t.url === 'about:blank');
  if (!keep) {
    const opened = await call('fast_tab', { url: 'about:blank' });
    if (!opened || opened.id == null) throw new Error(`rig reset: could not open about:blank (${JSON.stringify(opened).slice(0, 200)})`);
    keep = { id: opened.id };
  }
  const closed = [];
  const failed = [];
  for (const t of before) {
    if (t.id === keep.id) continue;
    const r = await call('fast_close', { tabId: t.id });
    (r && r.closed ? closed : failed).push(t.url);
  }
  // Closing is async on Chrome's side: poll briefly for the end state before calling it a failure.
  const done = (ts) => ts.length === 1 && ts[0].id === keep.id;
  let after = await list();
  for (let i = 0; i < settleTries && !done(after); i++) {
    await new Promise((r) => setTimeout(r, settleMs));
    after = await list();
  }
  if (!done(after)) {
    const shown = after.slice(0, 8).map((t) => `${t.url} (window ${t.windowId})`).join(' , ');
    throw new Error(`rig reset: expected exactly 1 blank tab, found ${after.length}: ${shown}${after.length > 8 ? ' , …' : ''}${failed.length ? ` — fast_close failed on ${failed.length}` : ''}`);
  }
  return { before: before.length, windows: new Set(before.map((t) => t.windowId)).size, closed: closed.length };
}
