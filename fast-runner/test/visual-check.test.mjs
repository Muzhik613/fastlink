// node --test — the VISUAL CHECK AT THE WRITE (visual-check.mjs + its wiring in
// runner.mjs), on synthetic runs: no browser, no Grok. Screenshot + checker injected.
// Motivating run: Azure 5f06a066 — a fill corrupted the VM name box at 37s, the
// end-of-run checker took 56s and said so at 103s; the gate's own problems came a
// further two rounds later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordResult, entryFacts, unverifiedWrites, reportDecision, deliverChecks, closeVisualChecks, gateProblems, unlookedFailures, screenMismatch } from '../runner.mjs';
import { startVisualCheck, settleShots, takeNotes, checkNoteText, lookNoteText, seenMap, describeWithGrok, observationPrompt, CHECK_MODEL, MAX_VISUAL_CHECKS } from '../visual-check.mjs';

const AZ = 'https://portal.azure.com/#create/Microsoft.VirtualMachine';
const snap = (url, ...texts) => JSON.stringify({ url, content: texts.map(text => ({ text })) });
const TASK = 'Create a virtual machine named fastlink-bench-vm in the Azure portal.';

function runOf(rows, extra = {}) {
  const run = { gate: 'on', task: TASK, toolLog: [], corpus: [], urlTrail: [], gateRefusals: [], turns: [], messages: [], visualChecks: [], pendingChecks: [], startedAt: Date.now(), ...extra };
  rows.forEach((row) => push(run, ...row));
  return run;
}
function push(run, name, args, text = '{}', isError = false) {
  const ok = recordResult(run, text, isError);
  run.toolLog.push({ t: run.toolLog.length * 1000, name, args, ok, preview: text.slice(0, 100), ...entryFacts(name, args, text, ok) });
  return run.toolLog.length - 1;
}
const azureRows = (typeResult) => [
  ['fast_tab', { url: AZ }, `{"id":1,"url":"${AZ}"}`],
  ['fast_snapshot', { full: true }, snap(AZ, 'Create a virtual machine', 'Basics')],
  ['fast_click_xy', { x: 492, y: 582 }, JSON.stringify({ clickedAt: { x: 492, y: 582 } })],
  ['fast_type', { text: 'fastlink-bench-vm', clear: true, force: true }, JSON.stringify(typeResult)],
];
const CROSS = { verified: false, reason: 'cross-origin: value not readable', typed: 17, cleared: true, forced: true, typedInto: { tag: 'iframe', value: '' } };
const OBS = ['"fastlink-bench-vm" appears in the Virtual machine name box, which reads fastlink-bench-vmany validany valid.', 'The Basics tab shows a red mark.', 'The form continues below the visible area.'];
const deps = (observations = OBS, { checkerDelay = 0 } = {}) => {
  const seen = { shots: 0, described: null };
  return {
    seen,
    screenshot: async () => { seen.shots++; return 'QkFTRTY0'; },
    describe: async (a) => { seen.described = a; if (checkerDelay) await new Promise(r => setTimeout(r, checkerDelay)); return { observations, checkerMs: checkerDelay }; },
  };
};

// ── the detector: an unread write is found WHEREVER the tool reports it ──────
test('a forced write nothing read back is an unverified write, with its reason', () => {
  const run = runOf(azureRows(CROSS));
  assert.deepEqual(unverifiedWrites(run.toolLog), [{ name: 'fast_type', target: 'fastlink-bench-vm', t: 3000, unverified: true, reason: 'cross-origin: value not readable' }]);
  const old = runOf(azureRows({ typed: 17, cleared: true, forced: true, into: { tag: 'iframe' } }));
  assert.match(unverifiedWrites(old.toolLog)[0].reason, /^forced: the editable-focus guard was bypassed/);
  const fill = runOf([['fast_fill', { fields: { Name: 'x' } }, JSON.stringify({ verified: false, fields: { Name: { verified: false, reason: 'unreadable: the field is no longer in the page after the write' } } })]]);
  assert.deepEqual(unverifiedWrites(fill.toolLog), [{ name: 'fast_fill', target: 'Name', t: 0, unverified: true, reason: 'unreadable: the field is no longer in the page after the write' }]);
});

const NESTED_BATCH = {
  args: { actions: [{ name: 'fast_click', args: { match: 'Virtual machine name' } }, { name: 'fast_type', args: { text: 'fastlink-bench-vm' } }] },
  result: { summary: '2/2 steps ok', results: [
    { step: 0, name: 'fast_click', ok: true, result: { clickedAt: { x: 492, y: 582 } } },
    { step: 1, name: 'fast_type', ok: true, result: { typed: 17, verified: false, reason: 'cross-origin: value not readable', typedInto: { tag: 'iframe', value: '' } } },
  ] },
};
test('ANY verified:false anywhere in a result starts a check, whatever shape it arrives in', () => {
  const shapes = {
    'top-level fast_type': ['fast_type', { text: 'fastlink-bench-vm', force: true }, CROSS],
    'nested fast_batch step': ['fast_batch', NESTED_BATCH.args, NESTED_BATCH.result],
    'fast_fill {fields}': ['fast_fill', { fields: { Region: 'East US' } }, { verified: false, fields: { Region: { verified: false, reason: 'unreadable: gone' } } }],
    'fast_select_option results{}': ['fast_select_option', { field: 'Region', value: 'East US' }, { verified: true, results: { Region: { verified: false, picked: 'East US', reason: 'the pick did not take' } } }],
  };
  for (const [label, [name, args, payload]] of Object.entries(shapes)) {
    const run = runOf([]);
    const idx = push(run, name, args, JSON.stringify(payload));
    assert.ok(startVisualCheck(run, idx, deps()), `${label}: check started`);
  }
});

// ── when it runs: AT the write, in parallel with the model's next turn ──────
test('the check starts the moment the write returns, and costs nothing when everything read back', async () => {
  const run = runOf(azureRows(CROSS));
  const d = deps();
  const rec = startVisualCheck(run, 3, d);
  assert.equal(rec.idx, 3);
  await settleShots(run);
  assert.equal(d.seen.shots, 1, 'screenshot taken before anything else touches the page');
  assert.deepEqual(d.seen.described, { base64: 'QkFTRTY0', targets: ['fastlink-bench-vm'] }, 'image + what the write aimed at — never the task text');
  const clean = runOf([['fast_type', { text: 'x', force: true }, JSON.stringify({ verified: true, typedInto: { tag: 'input', value: 'x' } })]]);
  const d2 = deps();
  assert.equal(startVisualCheck(clean, 0, d2), null);
  assert.equal(d2.seen.shots, 0);
  assert.deepEqual(clean.visualChecks, []);
  const off = runOf(azureRows(CROSS), { gate: 'off' });
  assert.equal(startVisualCheck(off, 3, deps()), null, 'gate off measures the model alone');
});

test('startVisualCheck does not block: it returns before the checker answers', async () => {
  const run = runOf(azureRows(CROSS));
  const t0 = Date.now();
  startVisualCheck(run, 3, deps(OBS, { checkerDelay: 200 }));
  assert.ok(Date.now() - t0 < 50, 'returned immediately');
  // a check started in THIS batch is not waited for by this batch's result
  assert.deepEqual(await deliverChecks(run, { before: 3 }), []);
  assert.equal(run.pendingChecks.length, 1);
  // the next batch picks it up
  const notes = await deliverChecks(run, { before: 4 });
  assert.equal(notes.length, 1);
  for (const o of OBS) assert.ok(notes[0].includes(`- ${o}`));
  assert.equal(run.pendingChecks.length, 0);
  const rec = run.visualChecks[0];
  assert.equal(rec.checker, CHECK_MODEL);
  assert.ok(rec.deliveredAt >= 0 && rec.waitedMs >= 0);
  assert.deepEqual(rec.observations, OBS);
});

test('a slow checker never stalls the run: capped wait, delivered on a later turn', async () => {
  const run = runOf(azureRows(CROSS));
  startVisualCheck(run, 3, deps(OBS, { checkerDelay: 150 }));
  const t0 = Date.now();
  assert.deepEqual(await takeNotes(run, { waitMs: 20 }), []);
  assert.ok(Date.now() - t0 < 120, 'gave up waiting at the cap');
  assert.equal(run.pendingChecks.length, 1, 'still pending, not dropped');
  assert.equal((await takeNotes(run, { waitMs: 1000 })).length, 1);
});

test('delivered observations are a read of the page: evidence can quote them, the gate stops asking', async () => {
  const run = runOf(azureRows(CROSS));
  startVisualCheck(run, 3, deps());
  const before = gateProblems(run, { result: 'Typed the name', evidence: 'The Basics tab shows a red mark.' });
  assert.ok(before.some(p => /no tool has read the page since your last fast_type/.test(p)));
  assert.ok(before.some(p => /fast_type "fastlink-bench-vm" failed and was never retried/.test(p)));
  assert.ok(before.some(p => /evidence does not quote/.test(p)));
  await deliverChecks(run);
  assert.equal(run.toolLog[3].seen, true);
  assert.deepEqual(gateProblems(run, { result: 'Typed the name', evidence: 'The Basics tab shows a red mark.' }), []);
  assert.equal(unverifiedWrites(run.toolLog).length, 1, 'still recorded as unread for the bench');
});

test('a check that got nothing is recorded and the gate still asks for a read-back', async () => {
  for (const [label, d, why] of [
    ['no screenshot', { screenshot: async () => null, describe: async () => ({ observations: OBS }) }, 'no screenshot'],
    ['checker threw', { screenshot: async () => 'QkFTRTY0', describe: async () => { throw new Error('xai 503'); } }, /checker failed: xai 503/],
    ['nothing observed', { screenshot: async () => 'QkFTRTY0', describe: async () => ({ observations: [] }) }, 'nothing observed'],
  ]) {
    const run = runOf(azureRows(CROSS));
    startVisualCheck(run, 3, d);
    assert.deepEqual(await deliverChecks(run), [], label);
    if (typeof why === 'string') assert.equal(run.visualChecks[0].skipped, why, label); else assert.match(run.visualChecks[0].skipped, why, label);
    assert.equal(run.toolLog[3].seen, undefined, label);
    assert.ok(gateProblems(run, { result: 'x', evidence: 'y' }).some(p => /no tool has read the page/.test(p)), label);
  }
});

test(`at most ${MAX_VISUAL_CHECKS} checks per run; the rest are recorded as skipped`, () => {
  const run = runOf([]);
  for (let i = 0; i < MAX_VISUAL_CHECKS + 2; i++) startVisualCheck(run, push(run, 'fast_type', { text: `v${i}`, force: true }, JSON.stringify(CROSS)), deps());
  assert.equal(run.pendingChecks.length, MAX_VISUAL_CHECKS);
  assert.equal(run.visualChecks.filter(c => /check cap/.test(c.skipped || '')).length, 2);
});

// ── report_done: note and gate problems in ONE round ─────────────────────────
test('at report_done a check still owed goes out TOGETHER with the gate problems, in one round', async () => {
  const run = runOf(azureRows(CROSS));
  startVisualCheck(run, 3, deps());
  const v = await reportDecision(run, { result: 'Set the VM name', evidence: 'nothing that quotes a result' }, 5000);
  assert.ok(v.note.includes('- The Basics tab shows a red mark.'));
  assert.ok(v.refuse.some(p => /evidence does not quote/.test(p)), 'the gate spoke in the same round');
  assert.equal(run.gateRefusals.length, 1);
  // a report the gate accepts still gets one round with the note first
  const ok = runOf(azureRows(CROSS));
  startVisualCheck(ok, 3, deps());
  const v2 = await reportDecision(ok, { result: 'Typed the VM name; the name box reads fastlink-bench-vmany validany valid', evidence: 'The Basics tab shows a red mark.' }, 5000);
  assert.ok(v2.note);
  assert.equal(v2.refuse, undefined);
  assert.equal(v2.finish, undefined);
  const v3 = await reportDecision(ok, { result: 'Typed the VM name', evidence: 'The Basics tab shows a red mark.' }, 6000);
  assert.ok(v3.finish, 'nothing owed any more: straight to the gate, which accepts');
});

// ── report_done after failed looks, no write, no screenshot: ONE look first ─
// Azure 68c8d227 (~/.local/state/fastrun/runs.jsonl): the Basics form was fully drawn by 20s on
// the video; the run's three fast_waits errored, it never wrote or took a screenshot, and it
// reported the page "never rendered". Rows below are that run's toolLog, previews trimmed.
const LOGIN = 'https://portal.azure.com/auth/login/';
const HEADER_ONLY = JSON.stringify({ url: AZ, title: 'Create a virtual machine - Microsoft Azure', fillable: 1, count: 14, items: [{ i: 1, tag: 'button', text: 'Show Microsoft Cloud menu' }], content: [{ text: 'Create a virtual machine' }] });
const BUSY = (ms) => JSON.stringify({ error: 'page busy', phase: 'fast_wait', elapsedMs: ms, hint: 'fast_wait did not return within 28s — the page is re-rendering or frozen; fast_wait for text of the settled view, then retry', origin: 'https://portal.azure.com' });
const run68c8d227 = (extraRows = [], extra = {}) => runOf([
  ['fast_tab', { url: AZ }, JSON.stringify({ id: 1220563042, url: AZ, targetTab: 1220563042 })],
  ['fast_snapshot', { full: true }, JSON.stringify({ url: LOGIN, title: 'Microsoft Authentication', count: 0, items: [], contentCount: 0, content: [] })],
  ['fast_wait', { text: 'Create a virtual machine', timeoutMs: 15000 }, JSON.stringify({ error: 'fast_wait: could not inject into target tab 1220563042 (Frame with ID 0 was removed.). The tab may have been closed or navigated to a restricted URL.', origin: 'https://portal.azure.com' }), true],
  ['fast_list', {}, JSON.stringify([{ id: 1220563042, url: AZ, title: 'Create a virtual machine - Microsoft Azure', active: true, targetTab: true }])],
  ['fast_snapshot', { full: true }, HEADER_ONLY],
  ['fast_wait', { text: 'Virtual machine name', timeoutMs: 30000 }, BUSY(28005), true],
  ['fast_snapshot', { full: true }, HEADER_ONLY],
  ['fast_wait', { text: 'Basics', timeoutMs: 30000 }, BUSY(28012), true],
  ...extraRows,
], extra);
const REPORT_68 = {
  result: 'Page stuck loading after auth redirect; never rendered "Create a virtual machine" Basics form. None of the four fields could be set.',
  evidence: 'fast_snapshot (full) returned only header chrome + "Create a virtual machine" h2 + account menu; no VM form fields, inputs, or region/image selectors visible after 30s+ waits. URL remained https://portal.azure.com/#create/Microsoft.VirtualMachine.',
};
const FORM_OBS = ['The page shows a form titled "Create a virtual machine" with the Basics tab selected.', 'The Virtual machine name box reads empty.', 'The Region box reads "(US) East US".'];

test('68c8d227: failed waits + no write + no screenshot → ONE look, handed over with the gate problems in one round', async () => {
  const run = run68c8d227();
  const d = deps(FORM_OBS);
  const v = await reportDecision(run, REPORT_68, 76537, d);
  assert.equal(d.seen.shots, 1);
  assert.deepEqual(d.seen.described.targets, ['Create a virtual machine', 'Virtual machine name', 'Basics'], 'the checker is asked about what the failed waits looked for');
  assert.ok(!JSON.stringify(d.seen.described).includes('never rendered'), 'the checker never sees the report');
  assert.ok(v.note.includes('- The Virtual machine name box reads empty.'));
  assert.match(v.note, /no screenshot was taken since/);
  assert.equal(v.refuse.length, 3, 'the gate spoke in the same round (three unretried waits)');
  assert.equal(v.finish, undefined);
  assert.equal(run.visualChecks.length, 1);
  assert.equal(run.visualChecks[0].kind, 'report');
  assert.equal(run.visualChecks[0].idx, 7);
  assert.ok(run.corpus.some(r => JSON.stringify(r).includes('Basics tab selected')), 'the observations are evidence the model can quote');
  // ONE round, not a loop: the reworded report gets no second look
  const v2 = await reportDecision(run, { ...REPORT_68, result: 'Form never rendered; waits timed out, not retried because the page was frozen.' }, 80000, d);
  assert.equal(d.seen.shots, 1);
  assert.equal(v2.note, undefined);
});

test('the look stays out of the way: a write anywhere, a screenshot since, gate off, nothing failed, or the cap', async () => {
  const cases = {
    'a write landed': run68c8d227([['fast_fill', { fields: { Name: 'x' } }, JSON.stringify({ verified: true, fields: { Name: { verified: true } } })]]),
    'a batch with a click step': run68c8d227([['fast_batch', { actions: [{ ifFound: 'Basics', then: [{ name: 'fast_click', args: { text: 'Basics' } }] }] }, JSON.stringify({ summary: '1/1 steps ok', results: [] })]]),
    'a screenshot after the last failure': run68c8d227([['fast_screenshot', {}, JSON.stringify({ path: '/tmp/s.png' })]]),
    'gate off': run68c8d227([], { gate: 'off' }),
    'no failed look': runOf([['fast_tab', { url: AZ }, `{"id":1,"url":"${AZ}"}`], ['fast_snapshot', { full: true }, HEADER_ONLY]]),
  };
  for (const [label, run] of Object.entries(cases)) {
    assert.equal(unlookedFailures(run), null, label);
    const d = deps(FORM_OBS);
    await reportDecision(run, REPORT_68, 9000, d);
    assert.equal(d.seen.shots, 0, label);
  }
  // a screenshot BEFORE the last failure is not a look at what the report describes
  assert.ok(unlookedFailures(runOf([['fast_screenshot', {}, '{"path":"/tmp/s.png"}'], ['fast_wait', { text: 'Basics' }, BUSY(28000), true]])));
  // it spends the same per-run budget as the write checks
  const capped = run68c8d227();
  capped.visualChecks = Array.from({ length: MAX_VISUAL_CHECKS }, (_, i) => ({ idx: i, skipped: 'nothing observed' }));
  const d = deps(FORM_OBS);
  const v = await reportDecision(capped, REPORT_68, 9000, d);
  assert.equal(d.seen.shots, 0);
  assert.equal(v.note, undefined);
  assert.match(capped.visualChecks.at(-1).skipped, /check cap/);
  assert.equal(unlookedFailures(capped), null, 'recorded, so never retried');
});

// ── a report that contradicts its own look is annotated, never refused again ─
// Azure b1d84267 (~/.local/state/fastrun/runs.jsonl): the look saw "Virtual machine name" (its box
// empty) in 1.9s; the model retried only a fast_wait, which timed out, and the accepted report
// said that text "never appeared". Rows are that run's toolLog, previews trimmed.
const B1_OBS = ['Virtual machine name appears in the Instance details section and the box holding it reads empty.', 'Region box reads (US) East US.', 'the form continues below the visible area.'];
const B1_REPORT_1 = { result: 'Could not reach or fill the "Create a virtual machine" Basics form (page stayed at header-only state after 30s+ waits). No fields set.', evidence: 'fast_snapshot after fast_tab to https://portal.azure.com/#create/Microsoft.VirtualMachine repeatedly returned only portal header items.' };
const B1_REPORT_2 = { result: 'Could not reach or fill the "Create a virtual machine" Basics form (page stayed at header-only state after 30s+ waits; "Virtual machine name" text never appeared). No fields set.', evidence: 'fast_wait for "Virtual machine name" returned "Timed out waiting for \\"Virtual machine name\\"". URL stayed https://portal.azure.com/#create/Microsoft.VirtualMachine.' };
const runB1 = () => runOf([
  ['fast_tab', { url: AZ }, JSON.stringify({ id: 1220563046, url: AZ, targetTab: 1220563046 })],
  ['fast_snapshot', { full: true, screenshot: false }, JSON.stringify({ url: LOGIN, title: '', count: 0, items: [], contentCount: 0, content: [] })],
  ['fast_wait', { text: 'Create a virtual machine', timeoutMs: 15000 }, JSON.stringify({ settling: true, found: { text: 'Create a virtual machine', contentMatch: true } })],
  ['fast_snapshot', { full: true, screenshot: false }, HEADER_ONLY],
  ['fast_wait', { text: 'Virtual machine name', timeoutMs: 30000 }, BUSY(28006), true],
  ['fast_snapshot', { full: true, screenshot: false }, HEADER_ONLY],
], { startedAt: Date.now() - 41766 });   // the look lands at ~41.8s, after every row above, as it did live
const seenDeps = (seen) => { const d = deps(B1_OBS); const inner = d.describe; d.describe = async (a) => ({ ...(await inner(a)), seen }); return d; };

test('b1d84267: the look answers per target; a later report still failing on a SEEN target is accepted with a mechanical annotation', async () => {
  const run = runB1();
  const d = seenDeps({ 'Virtual machine name': true });
  const v1 = await reportDecision(run, B1_REPORT_1, 41766, d);
  assert.equal(d.seen.described.askSeen, true, 'the look asks for per-target seen');
  assert.deepEqual(run.visualChecks[0].seen, { 'Virtual machine name': true });
  assert.ok(v1.note && v1.refuse, 'look + gate in one round, as before');
  // the model's only move: a wait that times out again (not an action on the page)
  push(run, 'fast_wait', { text: 'Virtual machine name', timeoutMs: 10000 }, JSON.stringify({ error: 'Timed out waiting for "Virtual machine name"', settling: false, headings: ['Microsoft Azure', 'Create a virtual machine'] }), true);
  run.toolLog.at(-1).t = run.visualChecks[0].deliveredAt + 1962;
  const v2 = await reportDecision(run, B1_REPORT_2, 47000, d);
  assert.ok(v2.finish, 'accepted — no second refusal loop');
  assert.equal(d.seen.shots, 1);
  assert.deepEqual(v2.finish.screenMismatch.map(m => [m.target, m.name]), [['Virtual machine name', 'fast_wait']]);
  assert.ok(v2.finish.result.startsWith(B1_REPORT_2.result), 'the model\'s own words are kept');
  assert.match(v2.finish.result, /\n\[screen check\] A screenshot taken at \d+s showed "Virtual machine name" visible, and the run did not act on the page after that\.$/);
});

test('no annotation: target not seen, an action after the look, the failure resolved, or no look', async () => {
  const notSeen = runB1();
  await reportDecision(notSeen, B1_REPORT_1, 41766, seenDeps({ 'Virtual machine name': false }));
  assert.deepEqual(screenMismatch(notSeen), [], 'the look did not see the target');
  const acted = runB1();
  await reportDecision(acted, B1_REPORT_1, 41766, seenDeps({ 'Virtual machine name': true }));
  push(acted, 'fast_click_xy', { x: 400, y: 500 }, JSON.stringify({ clickedAt: { x: 400, y: 500 } }));
  acted.toolLog.at(-1).t = acted.visualChecks[0].deliveredAt + 10;
  assert.deepEqual(screenMismatch(acted), [], 'acted on the page after the look');
  const resolved = runB1();
  await reportDecision(resolved, B1_REPORT_1, 41766, seenDeps({ 'Virtual machine name': true }));
  push(resolved, 'fast_wait', { text: 'Virtual machine name' }, JSON.stringify({ found: { text: 'Virtual machine name' } }));
  assert.deepEqual(screenMismatch(resolved), [], 'the failure was resolved');
  assert.deepEqual(screenMismatch(runB1()), [], 'no look, nothing to contradict');
  const malformed = runB1();
  await reportDecision(malformed, B1_REPORT_1, 41766, seenDeps({ 'Virtual machine name': 'yes', Other: true }));
  assert.deepEqual(malformed.visualChecks[0].seen, {}, 'only booleans for asked targets count');
  assert.deepEqual(screenMismatch(malformed), []);
});

test('seen is structured: the prompt asks per target only for the look, and the parser keeps asked booleans only', async () => {
  assert.doesNotMatch(observationPrompt({ targets: ['Basics'] }), /"seen"/, 'write checks keep the benchmarked prompt');
  assert.match(observationPrompt({ targets: ['Basics'], askSeen: true }), /"seen":\{"Basics": true\|false\}/);
  assert.deepEqual(seenMap({ Basics: true, Region: false, Extra: true, Name: 'yes' }, ['Basics', 'Region', 'Name']), { Basics: true, Region: false });
  const out = await describeWithGrok({ base64: 'QkFTRTY0', targets: ['Basics'], askSeen: true }, {
    create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ observations: ['The Basics tab is selected.'], seen: { Basics: true } }) }] }),
  });
  assert.deepEqual(out.seen, { Basics: true });
});

// ── what the model is told, and what the checker is asked ────────────────────
test('the note stays DUMB: no tool names, no widget classification, no verdict, no remedy', () => {
  const ours = checkNoteText(['Virtual machine name'], []);
  for (const banned of [/fast_[a-z_]+/, /\bdropdown\b/i, /\bcheckbox\b/i, /\btext field\b/i, /\bshould\b/i, /\bmust\b/i, /\bfailed\b/i, /\bwrong\b/i, /\bincomplete\b/i]) {
    assert.doesNotMatch(ours, banned, String(banned));
  }
  assert.match(ours, /"Virtual machine name" could not be read back/);
  const look = lookNoteText(['Basics'], []);
  for (const banned of [/fast_[a-z_]+/, /\bdropdown\b/i, /\bshould\b/i, /\bmust\b/i, /\bfailed\b/i, /\bwrong\b/i, /\bnot load/i, /\brender/i]) {
    assert.doesNotMatch(look, banned, String(banned));
  }
});

test('the checker call: one fresh user turn, the image, the write target — no task, no history, no tools', async () => {
  const sent = [];
  const out = await describeWithGrok({ base64: 'data:image/png;base64,QkFTRTY0', targets: ['fastlink-bench-vm'] }, {
    create: async (req) => { sent.push(req); return { content: [{ type: 'text', text: JSON.stringify({ observations: OBS }) }], _timing: { latencyMs: 1234 } }; },
  });
  assert.equal(sent.length, 1);
  const req = sent[0];
  assert.equal(req.model, CHECK_MODEL);
  assert.equal(req.system, undefined);
  assert.equal(req.tools, undefined);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].content.find(c => c.type === 'image').source.data, 'QkFTRTY0');
  const text = req.messages[0].content.find(c => c.type === 'text').text;
  assert.match(text, /"fastlink-bench-vm" — say where on the screen it appears and quote in full what the box holding it reads/);
  assert.doesNotMatch(text, /Azure|virtual machine named|fast_[a-z_]+|report_done|verified:false|cross-origin/);
  assert.deepEqual(out, { observations: OBS, checkerMs: 1234 });
});

test('the prompt covers the whole screen: empty boxes, marks on tabs, dialogs, content below', () => {
  const p = observationPrompt({ targets: ['Region', 'fast_type thing'] });
  assert.match(p, /EVERY box that looks empty or still shows greyed placeholder text/);
  assert.match(p, /a mark on a tab or step name/);
  assert.match(p, /a dialog or a banner/);
  assert.match(p, /below the visible area/);
  assert.doesNotMatch(p, /fast_type/);
  assert.doesNotMatch(observationPrompt({}), /Cover, FIRST/);
});

test('the checker answer is parsed out of whatever it replies with, capped at 8, and kept in register', async () => {
  const wordy = [
    'The Subscription box reads empty.', 'The Resource group box shows Select....', 'The Region box reads empty.',
    'The Image box reads empty.', 'The Size box reads empty.',
    'Click the Region box and pick East US.', 'The form is incomplete and must be finished.',
    'The Basics tab shows a red mark.', 'A red line under the name box reads "This field is required".',
    'The form continues below the visible area.', 'The Tags tab is at the far right.',
  ];
  const out = await describeWithGrok({ base64: 'QkFTRTY0', targets: [] }, {
    create: async () => ({ content: [{ type: 'text', text: `Here is what I see:\n${JSON.stringify({ observations: wordy })}` }], _timing: { latencyMs: 9 } }),
  });
  assert.equal(out.observations.length, 8);
  for (const banned of [/fast_[a-z_]+/, /^Click /m, /\bmust be\b/, /\bincomplete\b/]) assert.doesNotMatch(out.observations.join('\n'), banned);
  const failed = await describeWithGrok({ base64: 'QkFTRTY0' }, { create: async () => { throw new Error('xai 503'); } });
  assert.deepEqual(failed.observations, []);
  assert.match(failed.skipped, /^checker failed: xai 503/);
});

test('what the model did with each check is recorded: acted on it, or said why not', async () => {
  const run = runOf(azureRows(CROSS));
  startVisualCheck(run, 3, deps());
  await deliverChecks(run);
  const at = run.visualChecks[0].deliveredAt;
  run.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'The box holds junk; retyping it.' }] });
  run.toolLog.push({ t: at + 10, name: 'fast_type', args: { text: 'fastlink-bench-vm', force: true, clear: true }, ok: true, verified: true });
  closeVisualChecks(run);
  assert.equal(run.visualChecks[0].actedAfter, true);
  assert.match(run.visualChecks[0].model_response, /retyping/);
  assert.equal(run.visualChecks[0].msgIdx, undefined);
  closeVisualChecks(run);   // closing twice changes nothing
  assert.match(run.visualChecks[0].model_response, /retyping/);
});
