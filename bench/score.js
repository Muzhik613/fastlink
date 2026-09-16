// score.js — verify a test's ORDERED checkpoints against REAL page state.
//
// Nothing here trusts the model. Two evidence sources only:
//   1. Live DOM read back through the LOCAL FastLink connector after the run
//      (fast_evaluate / fast_list) — the browser's own state.
//   2. The URL trail the recorder observed WHILE the run was in flight, for steps
//      that a final-state read can no longer see (e.g. "passed through the Travel
//      category page" once the tab has moved on to the product page).
//
// The chat's final message is used for exactly ONE thing: `live` / `liveList`
// checkpoints, where the LIVE value is read first and the message is then checked
// for it. That is the claimed-vs-actual probe at checkpoint granularity — a client
// that fills three of four fields and says "all four are filled" fails the field
// checkpoint AND passes/fails the report checkpoint independently, so the two
// failure modes never blur together.
//
// CLI:  node bench/score.js multipage [--report-file f.txt] [--trail-file t.json]
//                                     [--install primary] [--json]
import { readFileSync } from 'fs';
import { evalIn, frameRead, tabs, pinInstall } from './fastlink.js';
import { byId, TEST_IDS } from './suite.js';

// --- text normalization ----------------------------------------------------
const norm = (s) => String(s ?? '')
  .replace(/[‘’“”]/g, (c) => (c === '‘' || c === '’' ? "'" : '"'))
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();
// Loose form: punctuation stripped, so "Its Only the Himalayas" matches
// "It's Only the Himalayas" and markdown bold/backticks never cause a false miss.
const loose = (s) => norm(s).replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

/** Every number a human-readable answer could carry, with magnitude suffixes
 *  expanded, so "1.4 billion" and "1,416,096,094" both become comparable. */
export function extractNumbers(text) {
  const out = [];
  const re = /([0-9][0-9,.]*)\s*(billion|bn|million|mn|m\b|k\b|thousand)?/gi;
  for (const m of String(text ?? '').matchAll(re)) {
    const raw = m[1].replace(/,/g, '');
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const suffix = (m[2] || '').toLowerCase();
    const mult = suffix.startsWith('b') ? 1e9
      : suffix.startsWith('mn') || suffix === 'million' || suffix === 'm' ? 1e6
        : suffix.startsWith('k') || suffix === 'thousand' ? 1e3 : 1;
    out.push(n * mult);
  }
  return out;
}
const hasNumberNear = (text, target, tol = 0.01) =>
  extractNumbers(text).some((n) => Math.abs(n - target) <= Math.abs(target) * tol);

// --- expect matchers -------------------------------------------------------
function applyExpect(actual, expect) {
  if (!expect) return { passed: actual != null, expected: 'any non-null value' };
  const arr = Array.isArray(actual) ? actual : null;
  const a = norm(arr ? arr.join(' | ') : actual);
  if ('equals' in expect) return { passed: String(actual) === String(expect.equals), expected: `=== ${expect.equals}` };
  if ('equalsIgnoreCase' in expect) return { passed: a === norm(expect.equalsIgnoreCase), expected: `= "${expect.equalsIgnoreCase}"` };
  if ('includes' in expect) return { passed: a.includes(norm(expect.includes)), expected: `contains "${expect.includes}"` };
  if ('notIncludes' in expect) return { passed: !a.includes(norm(expect.notIncludes)), expected: `does NOT contain "${expect.notIncludes}"` };
  if ('regex' in expect) return { passed: new RegExp(expect.regex, 'i').test(String(actual ?? '')), expected: `/${expect.regex}/i` };
  // oneOf on an ARRAY value means: at least one array element equals a wanted
  // value. This is what proves a URI landed in the right SECTION of the GCP form
  // rather than merely somewhere on the page.
  if ('oneOf' in expect) {
    const want = expect.oneOf.map(norm);
    const have = (arr || [actual]).map(norm);
    return { passed: have.some((h) => want.includes(h)), expected: `one of [${expect.oneOf.join(', ')}]` };
  }
  if ('truthy' in expect) return { passed: !!actual === !!expect.truthy, expected: expect.truthy ? 'truthy' : 'falsy' };
  if ('falsy' in expect) return { passed: !actual === !!expect.falsy, expected: 'falsy' };
  if ('nonEmpty' in expect) {
    const v = arr ? arr.filter((x) => String(x || '').trim()) : String(actual ?? '').trim();
    return { passed: (arr ? v.length > 0 : v.length > 0), expected: 'non-empty' };
  }
  return { passed: false, expected: `unsupported matcher ${JSON.stringify(expect)}` };
}

const pickField = (v, pick) => (pick && v && typeof v === 'object' ? v[pick] : v);

// Models copy values out of JSON tool results, so a multi-line value can arrive
// as a literal backslash-n ("Multi-line\ntext here"). Both sides of every report
// comparison read literal \n / \r\n / \r as a newline (norm() then folds it).
const unescNewlines = (s) => String(s ?? '').replace(/\\r\\n|\\n|\\r/g, '\n');

/** Does the chat's final message actually contain this live value? */
export function reportContains(reportText, value, { numeric = false, tolerance = 0.01 } = {}) {
  if (reportText == null) return null; // unknown — caller records it as unverified
  reportText = unescNewlines(reportText);
  value = unescNewlines(value);
  const nums = extractNumbers(value);
  if (numeric) return nums.length ? nums.every((n) => hasNumberNear(reportText, n, tolerance)) : false;
  if (norm(reportText).includes(norm(value))) return true;
  if (loose(value) && loose(reportText).includes(loose(value))) return true;
  return nums.length > 0 && nums.every((n) => hasNumberNear(reportText, n, tolerance));
}

// --- checkpoint runners ----------------------------------------------------
// Live reads are memoized per (tab, fn) so a test with six checkpoints over one
// page costs ONE fast_evaluate, not six.
async function readOnce(cache, cp) {
  const key = `${cp.tab || ''}::${cp.fn}::${JSON.stringify(cp.args || [])}`;
  if (!(key in cache)) cache[key] = await evalIn(cp.tab, cp.fn, cp.args || []);
  return cache[key];
}

async function runCheckpoint(cp, ctx, cache) {
  const base = { name: cp.name, kind: cp.kind };

  if (cp.kind === 'tab') {
    const list = await ctx.tabList();
    const hit = list.find((t) => (t.url || '').includes(cp.urlIncludes));
    return { ...base, passed: !!hit, expected: `an open tab whose URL contains "${cp.urlIncludes}"`, actual: hit ? hit.url : list.map((t) => t.url).join(' , ') || '(no tabs)' };
  }

  if (cp.kind === 'trail') {
    // Primary evidence: the URL trail the recorder sampled during the run.
    // Fallback (standalone scoring, no trail): currently-open tab URLs — enough to
    // score a finished run by hand, but it cannot see a URL already navigated away
    // from, so a trail-less score is a LOWER BOUND. Flagged in `actual`.
    const trail = ctx.trail;
    const pool = trail && trail.length ? trail : (await ctx.tabList()).map((t) => t.url || '');
    const ok = pool.some((u) => u.includes(cp.urlIncludes) && (!cp.excludes || !u.includes(cp.excludes)));
    return {
      ...base,
      passed: ok,
      expected: `a visited URL containing "${cp.urlIncludes}"${cp.excludes ? ` and not "${cp.excludes}"` : ''}`,
      actual: (trail && trail.length ? pool : pool.map((u) => `${u} (no trail — open tabs only, lower bound)`)).slice(-6).join(' , ') || '(nothing observed)',
    };
  }

  if (cp.kind === 'eval') {
    const raw = await readOnce(cache, cp);
    if (raw && raw.__noTab) return { ...base, passed: false, expected: cp.name, actual: `no tab matching "${cp.tab}"` };
    const actual = pickField(raw, cp.pick);
    const r = applyExpect(actual, cp.expect);
    return { ...base, passed: r.passed, expected: r.expected, actual: JSON.stringify(actual) };
  }

  if (cp.kind === 'live') {
    const raw = await readOnce(cache, cp);
    if (raw && raw.__noTab) return { ...base, passed: false, expected: 'live value from the page', actual: `no tab matching "${cp.tab}"`, live: null };
    const live = pickField(raw, cp.pick);
    if (live == null || String(live).trim() === '') {
      return { ...base, passed: false, expected: 'a live value to compare against', actual: '(page had no value to read — the earlier steps did not happen)', live: null };
    }
    const hit = reportContains(ctx.reportText, live, { numeric: cp.numeric, tolerance: cp.tolerance });
    return {
      ...base,
      passed: hit === true,
      unverified: hit === null,
      expected: `final message repeats the LIVE value: ${JSON.stringify(live)}`,
      actual: hit === null ? '(no final message captured — unverified)' : hit ? 'present in the final message' : 'MISSING from the final message',
      live,
    };
  }

  if (cp.kind === 'frameField') {
    // One fast_frame_read per (tab, frame, fields) set: every field a test scores is listed in
    // `fields`, so N field checkpoints cost ONE read, like readOnce for eval.
    const key = `frame::${cp.tab || ''}::${cp.frame}::${JSON.stringify(cp.fields)}`;
    if (!(key in cache)) cache[key] = await frameRead(cp.tab, cp.frame, cp.fields);
    const raw = cache[key];
    if (raw && raw.__noTab) return { ...base, passed: false, expected: cp.name, actual: `no tab matching "${cp.tab}"` };
    if (!raw || raw.error || !raw.fields) return { ...base, passed: false, expected: cp.name, actual: `frame read failed: ${JSON.stringify(raw).slice(0, 300)}` };
    const f = raw.fields[cp.field];
    if (!f || !f.found) return { ...base, passed: false, expected: cp.name, actual: `field "${cp.field}" not found in frames ${JSON.stringify(raw.frames || [])}` };
    // Ambiguity is a FAIL, never a pick: two controls sharing the label means we cannot say
    // which one the run wrote.
    if (f.count > 1 || f.value == null) return { ...base, passed: false, expected: cp.name, actual: `field "${cp.field}" is ambiguous (${f.count} controls) — not scored` };
    const r = applyExpect(f.value, cp.expect);
    return { ...base, passed: r.passed, expected: r.expected, actual: JSON.stringify(f.value) };
  }

  throw new Error(`unknown checkpoint kind: ${cp.kind}`);
}

/** `trailNever`: the checkpoint also FAILS if any visited URL contains a forbidden substring.
 *  With no trail (standalone scoring) only open tabs are seen, which can MISS a page already
 *  navigated away from, so a trail-less pass is flagged as a lower bound. */
async function applyTrailNever(cp, ctx, res) {
  if (!cp.trailNever || !res.passed) return res;
  const hasTrail = !!(ctx.trail && ctx.trail.length);
  const pool = hasTrail ? ctx.trail : (await ctx.tabList()).map((t) => t.url || '');
  const hit = pool.find((u) => cp.trailNever.some((bad) => u.includes(bad)));
  if (hit) return { ...res, passed: false, expected: `${res.expected}; and NO visited URL containing ${cp.trailNever.join(' | ')}`, actual: `forbidden URL visited: ${hit}` };
  return hasTrail ? res : { ...res, actual: `${res.actual} (no trail — trailNever checked against open tabs only, lower bound)` };
}

/** liveList expands at scoring time: one name + one value checkpoint per entry,
 *  plus one order checkpoint. Per-entry resolution is the point — "reported 6 of
 *  10, in the right order" is a completely different result from "reported 10". */
async function runLiveList(cp, ctx, cache) {
  const cpWithArgs = { ...cp, args: [cp.count] };
  const live = await readOnce(cache, cpWithArgs);
  const out = [];
  if (!Array.isArray(live) || !live.length) {
    out.push({ name: `${cp.name}: page data readable`, kind: 'liveList', passed: false, expected: `${cp.count} rows from the live table`, actual: JSON.stringify(live) });
    return out;
  }
  const report = ctx.reportText == null ? null : unescNewlines(ctx.reportText);
  const positions = [];
  for (const [i, row] of live.entries()) {
    const namePos = report == null ? -1 : loose(report).indexOf(loose(row.name));
    const nameHit = report == null ? null : namePos >= 0;
    if (nameHit) positions.push(namePos);
    out.push({
      name: `${cp.name}: #${i + 1} ${row.name} named`,
      kind: 'liveList',
      passed: nameHit === true,
      unverified: nameHit === null,
      expected: `final message names "${row.name}"`,
      actual: nameHit === null ? '(no final message captured — unverified)' : nameHit ? 'named' : 'MISSING',
    });
    const valHit = report == null ? null : hasNumberNear(report, row.value, cp.tolerance ?? 0.01);
    out.push({
      name: `${cp.name}: #${i + 1} ${row.name} population`,
      kind: 'liveList',
      passed: valHit === true,
      unverified: valHit === null,
      expected: `a number within ${((cp.tolerance ?? 0.01) * 100).toFixed(0)}% of ${row.value.toLocaleString()}`,
      actual: valHit === null ? '(no final message captured — unverified)' : valHit ? 'matched' : 'MISSING or wrong',
    });
  }
  const ordered = positions.length >= 2 && positions.every((p, i) => i === 0 || p > positions[i - 1]);
  out.push({
    name: `${cp.name}: reported in the page's order`,
    kind: 'liveList',
    passed: ordered,
    unverified: report == null,
    expected: 'entries appear in the final message in the same order as the table',
    actual: report == null ? '(no final message captured)' : `${positions.length} entries located; ${ordered ? 'in order' : 'OUT OF ORDER'}`,
  });
  return out;
}

// --- public API ------------------------------------------------------------
export async function scoreTest(test, { trail = null, reportText = null, install = null } = {}) {
  if (install) await pinInstall(install);
  let tabCache = null;
  const ctx = {
    trail,
    reportText,
    tabList: async () => (tabCache ||= await tabs()),
  };
  const cache = {};
  const results = [];
  for (const cp of test.checkpoints) {
    if (cp.kind === 'liveList') results.push(...await runLiveList(cp, ctx, cache));
    else results.push(await applyTrailNever(cp, ctx, await runCheckpoint(cp, ctx, cache)));
  }
  const score = results.filter((r) => r.passed).length;
  const firstFailure = results.findIndex((r) => !r.passed);
  return {
    testId: test.id,
    score,
    total: results.length,
    firstFailure: firstFailure === -1 ? null : firstFailure,
    unverified: results.filter((r) => r.unverified).length,
    checkpoints: results,
  };
}

export function renderScore(res) {
  const lines = [`  ${res.testId}: ${res.score}/${res.total}`];
  for (const c of res.checkpoints) {
    const mark = c.passed ? 'PASS' : c.unverified ? 'UNVR' : 'FAIL';
    lines.push(`   [${mark}] ${c.name}`);
    if (!c.passed) {
      lines.push(`          expected: ${c.expected}`);
      lines.push(`          actual:   ${String(c.actual).slice(0, 300)}`);
    }
  }
  return lines.join('\n');
}

// --- CLI -------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => { const i = argv.indexOf(n); if (i === -1) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const asJson = argv.includes('--json'); if (asJson) argv.splice(argv.indexOf('--json'), 1);
  const reportFile = flag('--report-file');
  const trailFile = flag('--trail-file');
  const install = flag('--install');
  const testId = argv[0];
  const test = byId(testId);
  if (!test) {
    console.error(`usage: node bench/score.js <${TEST_IDS.join('|')}> [--report-file f] [--trail-file f] [--install label] [--json]`);
    process.exit(2);
  }
  if (test.blocked) { console.error(`NOT RUNNABLE — ${test.blocked}`); process.exit(3); }
  const reportText = reportFile ? readFileSync(reportFile, 'utf8') : null;
  const trail = trailFile ? JSON.parse(readFileSync(trailFile, 'utf8')) : null;
  const res = await scoreTest(test, { trail, reportText, install });
  console.log(asJson ? JSON.stringify(res, null, 2) : renderScore(res));
  process.exit(0);
}
