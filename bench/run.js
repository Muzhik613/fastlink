// run.js — execute ONE benchmark cell (client × transport × test) and append one
// row to bench/results.jsonl.
//
// A cell is NOT a subprocess. The client is a chat WEBSITE (claude.ai / grok.com)
// that drives the browser over the cloud relay, so there is no exit code and no
// stdout to parse. A cell is:
//
//   1. reset       close this test's tabs — and, for sites that cache a previous
//                  run's work in localStorage (aa.com), wipe that origin's storage
//                  too — so nothing is inherited as free credit
//   2. watermark   stamp t0 and the relay-trace watermark BEFORE the prompt is sent
//   3. drive       paste + submit the prompt into the chat (drive-web.js), or print
//                  it for a human (--driver manual)
//   4. record      poll the relay trace until it goes quiet (FINISHED) or blows the
//                  ceiling / burns 30s timeouts (STUCK)
//   5. read back   only NOW switch to the chat tab and read its final message
//   6. score       checkpoints against live page state + the observed URL trail
//   7. append      one JSON line
//
// ── SEQUENTIAL BY CONSTRUCTION ──
// The relay reports ONE connected device and has NO device-selection tool
// (fast_profile is local-only), so two chat cells at once would interleave onto a
// single browser and a single trace. A lockfile makes that an enforced refusal
// rather than a convention. Slot pinning stays wired up for LOCAL-transport cells,
// where several Chrome profiles genuinely do run in parallel.
import { appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { byId, TEST_IDS } from './suite.js';
import { closeMatching, clearStorageFor, pinInstall, status } from './fastlink.js';
import { RelayTrace, LocalTrace, TrailWatcher, watchRun, renderTiming, summarize, resolveDeviceToken, TOKEN_HELP, DEFAULTS } from './monitor.js';
import { scoreTest, renderScore } from './score.js';
import * as web from './drive-web.js';
import * as runner from './drive-runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS = join(HERE, 'results.jsonl');
const LOCK = join(HERE, '.run.lock');

export const CLIENTS = {
  claude: { id: 'claude', label: 'claude.ai', site: 'claude' },
  grok: { id: 'grok', label: 'grok.com', site: 'grok' },
  // Same site as `claude`, recorded under a SEPARATE id so a model/effort-tier run
  // does not overwrite or blur with the Opus-5-High baseline in results.jsonl.
  // The tier itself is set in the claude.ai UI (model picker → Effort); the harness
  // cannot set it, so the operator must confirm the picker before running these.
  claude_low: { id: 'claude_low', label: 'claude.ai Opus5-Low', site: 'claude' },
  claude_sonnet: { id: 'claude_sonnet', label: 'claude.ai Sonnet', site: 'claude' },
  // fast-runner: Grok agent loop over the relay (bench/drive-runner.js), no chat site.
  grok_runner: { id: 'grok_runner', label: 'fast-runner grok', site: null, driver: 'runner' },
};

// ---------------------------------------------------------------------------
// Lock — one chat cell at a time, enforced.
// ---------------------------------------------------------------------------
function acquireLock(meta, { force = false }) {
  if (existsSync(LOCK)) {
    let held = null;
    try { held = JSON.parse(readFileSync(LOCK, 'utf8')); } catch { /* corrupt */ }
    const alive = held?.pid ? (() => { try { process.kill(held.pid, 0); return true; } catch { return false; } })() : false;
    if (alive && !force) {
      throw new Error(
        `a benchmark cell is already in flight (pid ${held.pid}: ${held.client}/${held.testId}, started ${held.startedAt}).\n`
        + 'Chat cells drive ONE relay-connected browser and cannot overlap. Wait for it, or --force-unlock if it is dead.',
      );
    }
    unlinkSync(LOCK);
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...meta }));
}
const releaseLock = () => { try { unlinkSync(LOCK); } catch { /* already gone */ } };

// ---------------------------------------------------------------------------
// claimedComplete — deliberately conservative.
// The whole point of this column is to catch a client asserting success it did not
// achieve, so the harness must not invent the claim. `--claimed` wins; otherwise
// only UNAMBIGUOUS phrasing sets it, and everything else stays null (unknown).
// ---------------------------------------------------------------------------
const CLAIM_YES = /\b(all (four|4|the)? ?fields? (are|is|have been)? ?(now )?(filled|set|populated|entered)|i(?:'ve| have) (?:now )?(completed|finished|filled|filled in|selected|reported)|task (is )?complete|done[.!]|successfully (filled|selected|completed|opened|extracted))\b/i;
const CLAIM_NO = /\b(i (was|were)n'?t able to|i could ?n'?t|unable to|failed to|i did ?n'?t manage|blocked|ran into (an )?(error|issue)|couldn'?t complete)\b/i;
const RATE_LIMIT = /\b(rate limit|you'?ve reached your limit|message limit|usage limit|try again (later|in a)|too many requests|upgrade to continue)\b/i;

export function inferClaim(text) {
  if (!text) return { claimedComplete: null, claimedSource: 'unknown' };
  if (CLAIM_NO.test(text)) return { claimedComplete: false, claimedSource: 'heuristic' };
  if (CLAIM_YES.test(text)) return { claimedComplete: true, claimedSource: 'heuristic' };
  return { claimedComplete: null, claimedSource: 'unknown' };
}

// ---------------------------------------------------------------------------
export async function runCell({
  client, testId, transport = 'relay', driver = 'web', install = null, browser = null, toolset = null,
  claimed = null, quietMs = DEFAULTS.quietMs, ceilingMs = DEFAULTS.ceilingMs,
  reset = true, force = false, dryRun = false, deviceToken = null,
}) {
  const test = byId(testId);
  if (!test) throw new Error(`unknown test "${testId}" (have: ${TEST_IDS.join(', ')})`);
  const cl = CLIENTS[client];
  if (!cl) throw new Error(`unknown client "${client}" (have: ${Object.keys(CLIENTS).join(', ')})`);
  if (cl.driver) driver = cl.driver; // a runner client has no chat site to script

  if (dryRun) {
    console.log(`cell: ${cl.label} × ${transport} × ${test.id}\nprompt:\n${test.prompt}`);
    return null;
  }

  acquireLock({ client, testId, transport }, { force });
  const notes = [];
  let valid = true; let invalidReason = null;
  try {
    // --install pins the LOCAL broker slot, which is our OBSERVATION channel
    // (reset, URL trail, scoring) — never the drive channel. On the local path it
    // is also the drive channel, so pinning covers both. On the relay path the
    // chat's browser is decided by WHICH RELAY ACCOUNT its connector authorized
    // under (each account = its own DO); we cannot select it, but we MUST observe
    // the same browser or every checkpoint reads the wrong Chrome and fails.
    // Concretely: claude.ai authorized under one Google account drives Profile 1
    // (slot "primary"), grok.com under another drives Profile 6 ("secondary").
    if (install) {
      await pinInstall(install);
      notes.push(transport === 'local'
        ? `pinned install=${install}`
        : `observing install=${install} (relay picks the driven browser by account; this only scopes reset/trail/scoring)`);
    }
    const st = await status();
    if (!st?.connected) throw new Error('FastLink extension is not connected to the local broker — cannot reset or score.');

    // PREFLIGHT THE CHANNEL THE CHAT WILL ACTUALLY USE. The check above only proves
    // the LOCAL broker is up (our observation channel). A relay cell is driven over
    // the RELAY, whose socket can be down independently — the extension's MV3 service
    // worker lets it drop and only redials on demand. Observed: a cell burned a full
    // run with 0 tool calls because the relay socket was dead while the local broker
    // was perfectly healthy, and it recorded as NO_ACTIVITY (indistinguishable from a
    // model that ignored the connector). Fail fast instead of spending a run.
    if (transport === 'relay' && driver === 'runner') {
      // The runner is its own relay client: preflight AS the runner, pinned to
      // the browser it will drive, instead of via the device-token /devices read.
      notes.push(await runner.preflight({ browser }));
    } else if (transport === 'relay') {
      const tok = resolveDeviceToken(deviceToken);
      if (!tok) throw new Error(`relay transport needs a device token.\n${TOKEN_HELP}`);
      let live = null;
      for (let i = 0; i < 3 && !live; i++) {
        if (i) await new Promise((r) => setTimeout(r, 3000));
        try {
          const res = await fetch(`${DEFAULTS.relayBase || 'https://relay.ytx.app'}/devices?deviceToken=${encodeURIComponent(tok)}`);
          const j = await res.json();
          live = (j.devices || []).filter((d) => d.connected);
          if (!live.length) live = null;
        } catch { /* transient — retry */ }
      }
      if (!live) {
        throw new Error('relay reports NO connected browser for this account — the extension\'s relay socket is down '
          + '(the local broker being up does not imply the relay is). Open the chat / reload the extension to make it redial, then retry.');
      }
      notes.push(`relay preflight ok: ${live.map((d) => d.name).join(', ')}`);
    }

    if (reset) {
      const closed = await closeMatching(test.reset?.closeUrlPatterns || []);
      if (closed.length) notes.push(`reset closed ${closed.length} tab(s)`);
      const wiped = await clearStorageFor(test.reset?.clearStorage || []);
      if (wiped.length) notes.push(`reset cleared site storage for ${wiped.length} origin(s)`);
    }

    // Trace source + watermark BEFORE anything can generate a row.
    let source;
    let handle = null; // runner driver: the spawned cli.mjs (its trace is `source`)
    if (driver === 'runner') { handle = runner.start(test.prompt, { browser, transport, toolset }); source = handle.trace; }
    else if (transport === 'local') source = new LocalTrace({ since: Date.now() });
    else {
      const token = resolveDeviceToken(deviceToken);
      if (!token) throw new Error(`relay transport needs a device token.\n${TOKEN_HELP}`);
      source = new RelayTrace({ token, since: Date.now() });
    }
    const trailWatcher = new TrailWatcher({ install });
    await trailWatcher.poll(); // baseline so pre-existing tabs are not read as navigation

    // Drive the chat.
    let site = null;
    const t0 = handle ? handle.startedAt : Date.now();
    if (driver === 'runner') {
      notes.push(`runner spawned${browser ? ` (browser=${browser})` : ''}${toolset ? ` (toolset=${toolset})` : ''}`);
    } else if (driver === 'manual') {
      console.log(`\n=== PASTE THIS INTO ${cl.label} (a NEW conversation) ===\n${test.prompt}\n=== recording starts now ===\n`);
    } else {
      site = await web.openChat(cl.site, { fresh: true });
      await web.newChat(site);
      await web.sendPrompt(site, test.prompt);
      notes.push('prompt composed and verified before submit');
    }
    const startedAt = Date.now();

    // From here until the run is FINISHED we touch nothing but read-only tab polls.
    process.stderr.write(`recording ${cl.label} × ${transport} × ${test.id} …\n`);
    let approvals = 0;
    const onTick = ({ elapsed, quietFor, calls, timeouts, lastError }) =>
      process.stderr.write(`\r  ${(elapsed / 1000).toFixed(0)}s  ${calls} calls  quiet ${(quietFor / 1000).toFixed(0)}s  timeouts ${timeouts}${lastError ? `  [${lastError}]` : ''}    `);
    // Runner: process exit is the finish signal (drive-runner.watch); the trail
    // watcher still samples URLs here so `trail` checkpoints score identically.
    const watch = handle ? await (async () => {
      const trailTimer = setInterval(() => trailWatcher.poll(), DEFAULTS.trailPollMs);
      try { return await runner.watch(handle, { ceilingMs, onTick, startedAt }); }
      finally { clearInterval(trailTimer); await trailWatcher.poll(); }
    })() : await watchRun({
      source, trailWatcher, quietMs, ceilingMs, startedAt, onTick,
      // A "quiet" run may just be blocked on claude.ai's per-tool permission dialog,
      // which halts the turn until a human clicks. Clear it and let the run resume
      // rather than recording a stall as NO_ACTIVITY / a low score.
      onQuiet: driver === 'web' && site
        ? async () => {
          const n = await web.approveToolPrompts(site).catch(() => 0);
          if (n) { approvals += n; notes.push(`approved ${n} tool-permission prompt(s) mid-run`); }
          return n > 0;
        }
        : null,
    });
    process.stderr.write('\n');

    if (watch.outcome === 'NO_ACTIVITY') { valid = false; invalidReason = watch.reason; }
    notes.push(`${watch.outcome}: ${watch.reason}`);

    // Only NOW is it safe to switch back to the chat tab. waitForIdle is the
    // SECONDARY confirmation: tool calls can stop a beat before the last tokens
    // render, and reading mid-stream would truncate the final message and fail
    // `live` checkpoints for the wrong reason.
    let final = { via: 'none', text: null };
    if (handle) {
      const idle = await runner.waitForIdle(handle);
      // The store's toolLog is the record; the streamed stderr rows can lag it by a
      // call, so the row's wall/calls are re-derived from the swapped-in rows.
      if (idle.record) Object.assign(watch, summarize(source.rows));
      if (!idle.record) notes.push('runner run store had no record for this run — tool histogram is empty');
      final = runner.readFinalMessage(handle);
      notes.push(`runner ${final.status || 'no-json'}${final.runId ? ` run_id=${final.runId}` : ''}${handle.questions ? ` (answered ${handle.questions} ask_caller)` : ''}`);
    } else if (driver !== 'manual' && site) {
      try {
        const idle = await web.waitForIdle(site);
        if (!idle.idle) notes.push('chat UI never returned to idle — final message may be partial');
        final = await web.readFinalMessage(site, { promptTail: test.prompt });
      } catch (e) { notes.push(`final-message read failed: ${e.message}`); }
    }
    if (final.text && RATE_LIMIT.test(final.text)) {
      valid = false;
      invalidReason = 'the chat reported a rate/usage limit — the cell measured a refusal, not a run';
    }

    // The runner's exit status IS its claim (report_done = done); no phrase-guessing.
    const claimInfo = claimed != null ? { claimedComplete: claimed, claimedSource: 'flag' }
      : handle && final.status ? { claimedComplete: final.status === 'done', claimedSource: 'runner' }
      : inferClaim(final.text);
    // Scoring reads the browser we OBSERVED (see --install note above) — on the
    // relay path that is the one the chat's account drives, not necessarily
    // "primary". Passing null here would score the wrong Chrome.
    const scored = await scoreTest(test, { trail: trailWatcher.trail, reportText: final.text, install });

    const row = {
      ts: new Date().toISOString(),
      client: cl.id,
      transport,
      testId: test.id,
      wallMs: watch.wallMs,                 // thinking + action, from the trace
      elapsedMs: (watch.lastEnd || Date.now()) - t0, // prompt submitted → last tool call
      toolCalls: watch.toolCalls,
      thinkingMs: watch.thinkingMs,
      actionMs: watch.actionMs,
      score: scored.score,
      total: scored.total,
      firstFailure: scored.firstFailure,
      unverified: scored.unverified,
      claimedComplete: claimInfo.claimedComplete,
      claimedSource: claimInfo.claimedSource,
      stuck: watch.outcome === 'STUCK',
      valid,
      invalidReason,
      outcome: watch.outcome,
      timeouts: watch.timeouts,
      driver,
      install,
      browser,
      toolset: handle ? (handle.final?.toolset || toolset || 'default') : null,
      model: handle ? (handle.final?.model || null) : null,
      notes: notes.join('; '),
    };
    appendFileSync(RESULTS, JSON.stringify(row) + '\n');
    if (handle) runner.recordUsage(handle, { client: cl.id, testId: test.id, toolset: row.toolset });

    console.log(renderTiming(source.rows, cl.label));
    console.log('');
    console.log(renderScore(scored));
    console.log(`\n  claimedComplete: ${row.claimedComplete} (${row.claimedSource})   stuck: ${row.stuck}   valid: ${row.valid}`);
    if (row.claimedComplete === true && scored.score < scored.total) {
      console.log('  ⚠ OVERCLAIM: the chat asserted completion but live page state disagrees.');
    }
    console.log(`\n  appended → ${RESULTS}`);
    return row;
  } finally {
    releaseLock();
  }
}

// --- CLI -------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const has = (n) => { const i = argv.indexOf(n); if (i === -1) return false; argv.splice(i, 1); return true; };
  const flag = (n, d = null) => { const i = argv.indexOf(n); if (i === -1) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };

  if (has('--list')) {
    for (const id of TEST_IDS) console.log(`${id.padEnd(12)} ${byId(id).name}`);
    process.exit(0);
  }
  if (has('--force-unlock')) { releaseLock(); console.log('lock released'); }

  const claimedRaw = flag('--claimed');
  const opts = {
    client: flag('--client'),
    testId: flag('--test'),
    transport: flag('--transport', 'relay'),
    driver: flag('--driver', 'web'),
    install: flag('--install'),
    browser: flag('--browser'),
    toolset: flag('--toolset'),
    deviceToken: flag('--token'),
    quietMs: Number(flag('--quiet-ms', DEFAULTS.quietMs)),
    ceilingMs: Number(flag('--ceiling-ms', DEFAULTS.ceilingMs)),
    claimed: claimedRaw == null ? null : /^(y|yes|true|1)$/i.test(claimedRaw),
    reset: !has('--no-reset'),
    force: has('--force'),
    dryRun: has('--dry-run'),
  };
  if (!opts.client || !opts.testId) {
    console.error([
      'usage: node bench/run.js --client <claude|grok|grok_runner> --test <' + TEST_IDS.join('|') + '> [options]',
      '',
      '  --transport relay|local   default relay (chat sites use the relay)',
      '  --driver    web|manual    web = script the chat UI; manual = print the prompt and record',
      '                            (client grok_runner always uses the runner driver: fast-runner/cli.mjs; --transport picks relay or local)',
      '  --browser   <name>        runner only: relay browser name to pin via fast_profile (e.g. yaakovschrome)',
      '  --toolset   <name|path>   runner only: fast-runner toolset (default | phase2 | no-cdp | file); recorded on the row',
      '  --install   <label>       Chrome profile to OBSERVE (reset/trail/scoring) via fast_profile.',
      '                            On --transport local it is also the driven profile. On relay,',
      '                            set it to the profile that chat\'s relay account drives',
      '                            (e.g. claude=primary, grok=secondary) or you score the wrong Chrome.',
      '  --claimed   yes|no        override the completion-claim reading of the final message',
      '  --quiet-ms / --ceiling-ms finish / stuck thresholds (default 25000 / 300000)',
      '  --no-reset --force --force-unlock --dry-run --list',
    ].join('\n'));
    process.exit(2);
  }
  try { await runCell(opts); process.exit(0); }
  catch (e) { console.error(`\nCELL FAILED: ${e.message}`); process.exit(1); }
}
