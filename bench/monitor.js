// monitor.js — watch a chat-driven run in flight and decide when it is FINISHED
// vs STUCK, without ever asking the model.
//
// TIMING SOURCE: the cloud relay's per-session trace (device-token-authed /trace).
//
// THE TRAP THIS FILE EXISTS TO AVOID: Grok's relay connector opens a NEW MCP
// SESSION PER TOOL CALL — 11 calls produced 11 sessions. One run therefore does
// NOT map to one session, and per-session gapMs is meaningless (a 1-row session
// has no previous row). So we AGGREGATE rows across ALL sessions, sort by
// timestamp, slice by time window, and RECOMPUTE gaps across the merged stream.
// In relay rows `t` is the END timestamp, so:
//     cycle = thisEnd - prevEnd        gap = cycle - thisDur
// (Reference for this aggregation: the scratchpad trace.js the coordinator wrote.)
//
// RETENTION: the DO keeps only the last 20 sessions per user. With one session per
// call that is TWENTY CALLS of history — a single long run can evict its own early
// rows. So we poll continuously and accumulate rows locally, deduped; the local
// accumulator, not the relay, is the record of a run.
//
// SECOND SIGNAL: a URL trail sampled from the LOCAL connector. It answers "did the
// run ever reach the Travel category page" for steps a final-state read can no
// longer see, and it costs one cheap chrome.tabs.query per poll.
import { readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { formatTimingReport } from '../fast-dxt/server/timing-format.js';
import { tabs, pinInstall } from './fastlink.js';

export const RELAY_BASE = process.env.FASTLINK_RELAY_BASE || 'https://relay.ytx.app';
const LOCAL_LOG = join(tmpdir(), 'fastlink-timing.jsonl');

// A call whose duration is at/near the broker's 30s REQUEST_TIMEOUT_MS is a
// TIMED-OUT call, not slow work. Several in a row is the signature of a wedged
// tab burning the clock — the exact failure that must never be scored as a
// legitimately slow run.
const TIMEOUT_DUR_MS = 25_000;
const TIMEOUT_ROWS_FOR_STUCK = 2;

export const DEFAULTS = {
  quietMs: 25_000,      // no new tool call for this long → the run is FINISHED
  ceilingMs: 300_000,   // hard ceiling → STUCK
  pollMs: 3_000,
  trailPollMs: 500,     // 3s missed a 2s stop on the Travel page once runs got fast (batch build)
};

/** Device token: env → --token → ~/fastlink-secrets.txt (the same KEY=VALUE file
 *  fast-dxt/server/config.js reads). Never hardcoded, never logged. */
export function resolveDeviceToken(explicit = null) {
  if (explicit) return explicit;
  if (process.env.FASTLINK_DEVICE_TOKEN) return process.env.FASTLINK_DEVICE_TOKEN;
  try {
    const raw = readFileSync(process.env.FASTLINK_SECRETS_FILE || join(homedir(), 'fastlink-secrets.txt'), 'utf8');
    const m = raw.match(/^FASTLINK_DEVICE_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* no secrets file */ }
  return null;
}

export const TOKEN_HELP = [
  'No relay device token. Set one of:',
  '  export FASTLINK_DEVICE_TOKEN=<token>',
  '  echo "FASTLINK_DEVICE_TOKEN=<token>" >> ~/fastlink-secrets.txt',
  "Get it from the FastLink extension's service-worker console:",
  "  chrome.storage.local.get('deviceToken', console.log)",
].join('\n');

// ---------------------------------------------------------------------------
// Relay trace source
// ---------------------------------------------------------------------------
export class RelayTrace {
  constructor({ token, base = RELAY_BASE, since = Date.now() }) {
    this.token = token;
    this.base = base.replace(/\/+$/, '');
    this.since = since;
    this.rows = [];                 // accumulated, deduped, ascending by t
    this._seen = new Set();
    this._sessionCalls = new Map(); // sessionId → last-seen call count
    this.clients = new Set();
    this.lastError = null;
  }

  async _get(params) {
    const url = new URL(`${this.base}/trace`);
    url.searchParams.set('deviceToken', this.token);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.error) {
      throw new Error(`relay /trace ${res.status}: ${body?.error || 'unreadable response'}`);
    }
    return body;
  }

  /** One poll: refresh the session index, then pull rows only from sessions that
   *  are new or have grown. Returns the number of NEW rows in the window. */
  async poll() {
    let list;
    try { list = await this._get({}); this.lastError = null; }
    catch (e) { this.lastError = e.message; return 0; }

    const sessions = list.sessions || [];
    let added = 0;
    for (const s of sessions) {
      const id = s.id;
      // A session that ended before our watermark can never contain our rows.
      if (s.startedAt && s.startedAt + 0 < this.since - 60_000 && this._sessionCalls.has(id)) continue;
      if (this._sessionCalls.get(id) === s.calls) continue; // unchanged since last poll
      let detail;
      try { detail = await this._get({ session: id }); }
      catch { continue; }
      this._sessionCalls.set(id, s.calls);
      const client = [detail.session?.client?.name, detail.session?.client?.version].filter(Boolean).join(' ')
        || detail.session?.ua || s.client?.name || '';
      for (const r of detail.rows || []) {
        if (r.t < this.since) continue;
        const key = `${id}:${r.t}:${r.name}:${r.durMs}`;
        if (this._seen.has(key)) continue;
        this._seen.add(key);
        this.rows.push({ t: r.t, name: r.name, durMs: r.durMs ?? 0, session: id, client });
        if (client) this.clients.add(client);
        added++;
      }
    }
    if (added) this.rows.sort((a, b) => a.t - b.t);
    return added;
  }

  get lastRowAt() { return this.rows.length ? this.rows[this.rows.length - 1].t : null; }
}

/** Local-transport equivalent: /tmp/fastlink-timing.jsonl, sliced by window.
 *  Same row shape out, so everything downstream is transport-agnostic. */
export class LocalTrace {
  constructor({ since = Date.now() } = {}) { this.since = since; this.rows = []; this.lastError = null; this.clients = new Set(); }
  async poll() {
    let raw;
    try { raw = readFileSync(LOCAL_LOG, 'utf8'); } catch { this.lastError = `no ${LOCAL_LOG}`; return 0; }
    const before = this.rows.length;
    this.rows = raw.trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.t >= this.since)
      .map((r) => ({ t: r.t, name: r.name, durMs: r.durMs ?? 0, session: 'local', client: 'local' }));
    return this.rows.length - before;
  }
  get lastRowAt() { return this.rows.length ? this.rows[this.rows.length - 1].t : null; }
}

// ---------------------------------------------------------------------------
// Aggregation: recompute gaps ACROSS the merged multi-session stream.
// ---------------------------------------------------------------------------
export function withGaps(rows) {
  let prevEnd = null;
  return rows.map((r) => {
    const gapMs = prevEnd == null ? 0 : Math.max(0, (r.t - prevEnd) - r.durMs);
    prevEnd = r.t;
    return { ...r, gapMs };
  });
}

export function summarize(rows) {
  const g = withGaps(rows);
  const thinkingMs = g.reduce((s, r) => s + r.gapMs, 0);
  const actionMs = g.reduce((s, r) => s + r.durMs, 0);
  const timeouts = g.filter((r) => r.durMs >= TIMEOUT_DUR_MS).length;
  return {
    rows: g,
    toolCalls: g.length,
    thinkingMs,
    actionMs,
    wallMs: thinkingMs + actionMs,
    timeouts,
    firstStart: g.length ? g[0].t - g[0].durMs : null,
    lastEnd: g.length ? g[g.length - 1].t : null,
  };
}

/** Render through the SHARED formatter (fast-dxt/server/timing-format.js) so a
 *  chat run, a CLI run and a hand-driven local run all print line for line. */
export function renderTiming(rows, label = 'Chat') {
  const g = withGaps(rows);
  return formatTimingReport(g, { label, header: `  ${g.length} calls across ${new Set(g.map((r) => r.session)).size} MCP session(s)\n` });
}

// ---------------------------------------------------------------------------
// URL trail — cheap live sampling of what the browser actually visited.
// ---------------------------------------------------------------------------
export class TrailWatcher {
  constructor({ install = null } = {}) { this.install = install; this.trail = []; this._last = new Map(); }
  async poll() {
    let list;
    try { list = await tabs(); } catch { return; }
    for (const t of list) {
      const url = t.url || '';
      if (!url || this._last.get(t.id) === url) continue;
      this._last.set(t.id, url);
      this.trail.push(url);
    }
  }
}

// ---------------------------------------------------------------------------
// The watch loop
// ---------------------------------------------------------------------------
/**
 * Poll until the run goes quiet or blows the ceiling.
 * FINISHED  = no new tool call for `quietMs`.
 * STUCK     = the hard ceiling was hit, OR >=2 calls hit the broker's 30s request
 *             timeout (a wedged tab burning the clock, not slow work).
 * NO_ACTIVITY = the chat never issued a single FastLink call.
 */
/* `onQuiet` runs when the trace has gone quiet but BEFORE the outcome is declared.
 * It exists for blockers that stall a run without producing any trace activity —
 * chiefly claude.ai's per-tool permission dialog, which halts the turn until a human
 * clicks and otherwise gets recorded as NO_ACTIVITY / a low score. It must return a
 * truthy value if it actually unblocked something; the quiet clock then resets and
 * the run continues. Called ONLY during quiet, because that is the one moment
 * nothing is driving the browser and touching the chat tab is safe. */
export async function watchRun({
  source, trailWatcher = null, quietMs = DEFAULTS.quietMs, ceilingMs = DEFAULTS.ceilingMs,
  pollMs = DEFAULTS.pollMs, onTick = null, startedAt = Date.now(), onQuiet = null,
}) {
  let lastActivityAt = startedAt;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const added = await source.poll();
    if (trailWatcher) await trailWatcher.poll();
    if (added > 0) lastActivityAt = Date.now();

    const now = Date.now();
    const quietFor = now - lastActivityAt;
    const elapsed = now - startedAt;
    const sum = summarize(source.rows);
    onTick?.({ elapsed, quietFor, calls: sum.toolCalls, timeouts: sum.timeouts, lastError: source.lastError });

    if (sum.timeouts >= TIMEOUT_ROWS_FOR_STUCK) {
      return { outcome: 'STUCK', reason: `${sum.timeouts} tool calls hit the 30s broker timeout — the tab is wedged; kill and re-run`, ...sum, elapsed };
    }
    if (elapsed >= ceilingMs) {
      return { outcome: 'STUCK', reason: `hard ceiling ${Math.round(ceilingMs / 1000)}s exceeded`, ...sum, elapsed };
    }
    if (quietFor >= quietMs) {
      // Before calling it: is the run merely BLOCKED on something we can clear?
      if (onQuiet) {
        const unblocked = await onQuiet({ quietFor, calls: sum.toolCalls });
        if (unblocked) { lastActivityAt = Date.now(); continue; }
      }
      if (sum.toolCalls === 0) {
        return { outcome: 'NO_ACTIVITY', reason: `no FastLink tool call in ${Math.round(quietFor / 1000)}s — the chat never reached the browser (rate limit? connector off?)`, ...sum, elapsed };
      }
      return { outcome: 'FINISHED', reason: `quiet for ${Math.round(quietFor / 1000)}s`, ...sum, elapsed };
    }
  }
}

// --- CLI: live tail --------------------------------------------------------
// node bench/monitor.js [--transport relay|local] [--since <epochMs>] [--install label]
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => { const i = argv.indexOf(n); if (i === -1) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const transport = flag('--transport', 'relay');
  const since = Number(flag('--since', Date.now()));
  const install = flag('--install');
  if (install) await pinInstall(install);

  let source;
  if (transport === 'local') source = new LocalTrace({ since });
  else {
    const token = resolveDeviceToken(flag('--token'));
    if (!token) { console.error(TOKEN_HELP); process.exit(2); }
    source = new RelayTrace({ token, since });
  }
  const trailWatcher = new TrailWatcher({ install });
  console.error(`watching ${transport} since ${new Date(since).toISOString()} — Ctrl-C to stop`);
  const res = await watchRun({
    source, trailWatcher, startedAt: since,
    onTick: ({ elapsed, quietFor, calls, timeouts, lastError }) =>
      process.stderr.write(`\r  ${(elapsed / 1000).toFixed(0)}s elapsed  ${calls} calls  quiet ${(quietFor / 1000).toFixed(0)}s  timeouts ${timeouts}${lastError ? `  [${lastError}]` : ''}   `),
  });
  process.stderr.write('\n');
  console.log(`${res.outcome}: ${res.reason}`);
  console.log(renderTiming(source.rows, [...source.clients][0] || 'Chat'));
  console.log(`\n  URL trail (${trailWatcher.trail.length}):`);
  for (const u of trailWatcher.trail) console.log(`    ${u}`);
  process.exit(0);
}
