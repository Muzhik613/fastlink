// node --test — the VISUAL CHECK AT THE WRITE (visual-check.mjs + its wiring in
// runner.mjs), on synthetic runs: no browser, no Grok. Screenshot + checker injected.
// Motivating run: Azure 5f06a066 — a fill corrupted the VM name box at 37s, the
// end-of-run checker took 56s and said so at 103s; the gate's own problems came a
// further two rounds later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordResult, entryFacts, unverifiedWrites, reportDecision, deliverChecks, closeVisualChecks, gateProblems, unlookedFailures, screenMismatch, wrotePage, reportDone } from '../runner.mjs';
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
    'a batch whose click step changed the URL': run68c8d227([['fast_batch', { actions: [{ name: 'fast_click', args: { text: 'Basics' } }] }, JSON.stringify({ summary: '1/1 steps ok', results: [{ step: 0, name: 'fast_click', ok: true, result: { url: AZ + '/basics', urlChanged: true } }] })]]),
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

// ── 4bf918fb: a click that changed nothing is not a write ──────────────────
// Azure 4bf918fb (~/.local/state/fastrun/runs.jsonl, build 670e8f2): two fast_clicks errored ("No
// element matching"), the model's own screenshot came BETWEEN them, then a fast_click_xy returned ok
// with focus on a non-editable div and no URL change. The report ("redirected to login… no Create
// button clickable") went out unlooked; the model's screenshot showed the Compute infrastructure
// page fully rendered. Rows are that run's toolLog, previews trimmed.
const HUB = 'https://portal.azure.com/#view/Microsoft_Azure_ComputeHub/ComputeHubMenuBlade/~/getStarted/menuid/virtualMachinesBrowse';
const HUB_SNAP = JSON.stringify({ url: HUB, title: 'Compute infrastructure - Microsoft Azure', fillable: 2, count: 27, items: [{ i: 1, tag: 'button', text: 'Show Microsoft Cloud menu' }], content: [{ text: 'Get started' }] });
const XY_NO_EFFECT = { clickedAt: { x: 320, y: 145 }, button: 'left', clickCount: 1, focused: { tag: 'div', editable: false, label: 'bff7e63f-4107-4a43-953d-ab5fbd82d0450' }, hint: '<div> (bff7e63f-4107-4a43-953d-ab5fbd82d0450) holds focus, not an editable field — a fast_type now would be refused.' };
const run4bf918fb = (xy = XY_NO_EFFECT, extraRows = [], extra = {}) => runOf([
  ['fast_tab', { url: 'https://portal.azure.com/#browse/Microsoft.Compute%2FVirtualMachines', background: false }, JSON.stringify({ id: 1220563063, url: 'https://portal.azure.com/#browse/Microsoft.Compute%2FVirtualMachines', targetTab: 1220563063 })],
  ['fast_snapshot', { viewport: true }, JSON.stringify({ url: LOGIN, title: '', count: 0, items: [], contentCount: 0, content: [] })],
  ['fast_list', {}, JSON.stringify([{ id: 1220563056, url: HUB, title: 'Compute infrastructure - Microsoft Azure', active: false }, { id: 1220563063, url: LOGIN, active: true, targetTab: true }])],
  ['fast_switch', { tabId: 1220563056 }, JSON.stringify({ id: 1220563056, url: HUB, title: 'Compute infrastructure - Microsoft Azure', targetTab: 1220563056 })],
  ['fast_snapshot', { viewport: true }, HUB_SNAP],
  ['fast_click', { text: 'Create a virtual machine', role: 'button' }, JSON.stringify({ error: 'No element matching "Create a virtual machine". Nothing was clicked.', waitedMs: 1888, settling: false }), true],
  ['fast_screenshot', { format: 'png', fresh: true }, JSON.stringify({ path: '/tmp/fastlink-screenshot-1789588763212.png', format: 'png', bytes: 302010 })],
  ['fast_click', { text: 'Create', role: 'button' }, JSON.stringify({ error: 'No element matching "Create". Nothing was clicked.', waitedMs: 1633, settling: false }), true],
  ['fast_click_xy', { x: 320, y: 145 }, JSON.stringify(xy)],
  ['fast_snapshot', { viewport: true, overlay: true }, HUB_SNAP],
  ...extraRows,
], extra);
const REPORT_4B = { result: 'Could not reach/create VM form: page redirected to login (already signed in elsewhere), create UI lives in cross-origin iframe unreachable by FastLink DOM tools; no "Create" button clickable. No fields filled.', evidence: '"Get started" from fast_snapshot on the Compute infrastructure page.' };

test('4bf918fb: failed clicks + a click_xy that changed nothing + a screenshot only BEFORE the last failure → the look fires', async () => {
  const run = run4bf918fb();
  assert.equal(run.toolLog[8].wrote, undefined, 'focus on a non-editable div, no URL change: not a write');
  const look = unlookedFailures(run);
  assert.equal(look?.idx, 7, 'anchored on the latest failure, the fast_click "Create" after the screenshot');
  assert.deepEqual(look.failures.map(f => [f.name, f.target]), [['fast_click', 'Create a virtual machine'], ['fast_click', 'Create']]);
  const d = deps(['The page shows "Compute infrastructure" with a "Get started" section.', 'A "Create" button appears near the top left.']);
  const v = await reportDecision(run, REPORT_4B, 29605, d);
  assert.equal(d.seen.shots, 1);
  assert.deepEqual(d.seen.described.targets, ['Create a virtual machine', 'Create']);
  assert.ok(v.note.includes('- A "Create" button appears near the top left.'));
});

test('4bf918fb variants: any other successful write, or a screenshot after the last failure, keeps the look away', () => {
  const wrote = {
    'click_xy focus on an editable field': { ...XY_NO_EFFECT, focused: { tag: 'input', editable: true, label: 'Virtual machine name', value: '' }, hint: undefined },
    'click_xy with a URL change': { ...XY_NO_EFFECT, url: HUB + '/create', urlChanged: true },
    'click_xy that reports no focus at all': { clickedAt: { x: 320, y: 145 } },
  };
  for (const [label, xy] of Object.entries(wrote)) {
    const run = run4bf918fb(xy);
    assert.equal(run.toolLog[8].wrote, true, label);
    assert.equal(unlookedFailures(run), null, label);
  }
  const looked = run4bf918fb(XY_NO_EFFECT, [['fast_screenshot', {}, JSON.stringify({ path: '/tmp/s2.png' })]]);
  assert.equal(unlookedFailures(looked), null, 'the model looked after its last failure');
  // the write rule, per result shape: every successful write counts except the idle click_xy
  assert.equal(wrotePage('fast_click', {}, { error: 'No element matching "Create". Nothing was clicked.' }), false, 'an errored click');
  assert.equal(wrotePage('fast_click', {}, { clicked: { tag: 'div', text: 'Salary: Activate to sort' }, urlChanged: false }), true, 'a plain click with no signals still wrote');
  assert.equal(wrotePage('fast_fill', {}, { verified: false, filled: 2, uncommitted: ['Choose destination...'] }), true, 'an unverified fill still wrote');
  assert.equal(wrotePage('fast_key_press', {}, { keyDispatched: 'Enter', urlChanged: false }), true);
  assert.equal(wrotePage('fast_click_xy', {}, XY_NO_EFFECT), false, 'the one exception');
  assert.equal(wrotePage('fast_snapshot', {}, {}), false, 'not a write tool');
  assert.equal(wrotePage('fast_batch', { actions: [{ name: 'fast_click_xy' }, { name: 'fast_wait' }] }, { results: [{ step: 0, ok: true, result: XY_NO_EFFECT }, { step: 1, ok: true, result: {} }] }), false, 'a batch whose only write is the idle click_xy');
  assert.equal(wrotePage('fast_batch', { actions: [{ name: 'fast_click' }] }, { results: [{ step: 0, ok: true, result: { clicked: {} } }] }), true);
});

// ── hvm bench 2026-09-16: two false annotations that set the current rules ──
// mapsdir b7184ddb (6/6, correct) and h_table 39d765d7: every write carried no verified/urlChanged/
// editable-focus signal, so the old effect rule saw no write, the look fired, and the caller got
// "[screen check] … visible, and the run did not act" on top of real work. Rows are the runs'
// toolLogs, previews trimmed to 400 chars.
const MAPS_B718 = [
  ["fast_tab", {"url":"https://www.google.com/maps"}, "{\"id\":81251768,\"url\":\"https://www.google.com/maps\",\"targetTab\":81251768}"],
  ["fast_snapshot", {"viewport":true}, "{\"url\":\"https://www.google.com/maps\",\"title\":\"Google Maps\",\"fillable\":1,\"count\":8,\"items\":[{\"i\":0,\"tag\":\"div\",\"text\":\"Map · Use arrow keys to pan the map. · Get details about a place by pressing its corresponding number key.\",\"x\":0,\"y\":0,\"w\":1599,\"h\":856,\"role\":\"application\",\"ariaLabel\":\"Map · Use arrow keys to pan the map. · Get details about a place by pressing its corresponding number key.\"},{\""],
  ["fast_click", {"text":"Directions","role":"button"}, "{\"clicked\":{\"i\":6,\"tag\":\"button\",\"text\":\"\",\"x\":410,\"y\":12,\"w\":54,\"h\":48,\"innerText\":\"\",\"ariaLabel\":\"Directions\"},\"url\":\"https://www.google.com/maps\",\"urlChanged\":false,\"focused\":{\"tag\":\"input\",\"role\":\"combobox\",\"label\":\"Search Google Maps\",\"name\":\"q\",\"value\":\"\",\"id\":\"ucc-1\"},\"settling\":true,\"hint\":\"page was still changing when this snapshot was taken (waited 187ms) — the view below may be incomp"],
  ["fast_wait", {"text":"Driving","timeoutMs":5000}, "{\"settling\":true,\"hint\":\"page was still changing when this snapshot was taken (waited 140ms) — the view below may be incomplete; fast_wait for text that identifies the finished state before reading or reporting\",\"found\":{\"tag\":\"div\",\"role\":\"img\",\"text\":\"Driving\",\"ariaLabel\":\"Driving\",\"placeholder\":null,\"x\":180,\"y\":30,\"w\":48,\"h\":40},\"snapshot\":{\"truncated\":true,\"dropped\":{\"items\":5},\"hint\":\"auto-sn"],
  ["fast_fill", {"fields":{"Choose starting point, or click on the map...":"John F. Kennedy International Airport","Choose destination...":"Times Square, New York"}}, "{\"verified\":false,\"filled\":2,\"missed\":0,\"total\":2,\"summary\":\"0/2 verified; typed but no option picked (NOT set): Choose starting point, or click on the map..., Choose destination...\",\"uncommitted\":[\"Choose starting point, or click on the map...\",\"Choose destination...\"],\"hint\":\"\\\"Choose starting point, or click on the map...\\\": autocomplete is open; pick a suggestion (fast_click its text) or fast_"],
  ["fast_key_press", {"key":"Enter"}, "{\"keyDispatched\":\"Enter\",\"target\":{\"tag\":\"input\",\"ariaLabel\":\"Destination Times Square, New York\",\"placeholder\":\"Choose destination, or click on the map...\",\"value\":\"Times Square, New York\"},\"url\":\"https://www.google.com/maps/dir///@42.0254481,-87.7068288,15z/data=!4m2!4m1!3e0?entry=ttu&g_ep=EgoyMDI2MDkxNC4wIKXMDSoASAFQAw%3D%3D\",\"urlChanged\":false,\"committed\":false,\"suggestions\":[\"Times Square New"],
  ["fast_wait", {"text":"route options","timeoutMs":10000,"noSnapshot":false}, "{\"error\":\"Timed out waiting for \\\"route options\\\"\",\"settling\":false,\"sinceMutMs\":4046,\"sinceNetMs\":3985,\"headings\":[\"via Woodhaven Blvd and I-495 W\",\"via I-678 N and I-495 W\",\"via Grand Central Pkwy\",\"Explore Times Square\"],\"origin\":\"https://www.google.com\"}", true],
  ["fast_text", {"selector":"[aria-label*=\"route\"],[role=\"button\"][aria-label*=\"min\"]","maxLen":200}, "{\"truncated\":false,\"text\":\"\\nSearch along the route...\\n\\nGas\\n\\nEV charging\\n\\nThings to do\\n\\nHotels\",\"length\":71,\"kind\":\"innerText\",\"from\":\"[aria-label*=\\\"route\\\"],[role=\\\"button\\\"][aria-label*=\\\"min\\\"]\",\"matches\":6}"],
  ["fast_snapshot", {"viewport":true,"full":false}, "{\"truncated\":true,\"dropped\":{\"content\":17,\"offscreen\":8},\"hint\":\"capped view: 0 item(s) / 17 content block(s) not shown — call fast_snapshot with full:true for everything, or limit:N for more items; 8 interactive element(s) are outside the viewport (below/above the fold) and NOT listed — call fast_snapshot without viewport:true, or fast_scroll, before concluding a control is absent | 2 empty filla"],
];
const TABLE_39D7 = [
  ["fast_tab", {"url":"https://datatables.net/examples/basic_init/zero_configuration.html"}, "{\"id\":81251776,\"url\":\"https://datatables.net/examples/core/basic_init/zero_configuration.html\",\"targetTab\":81251776}"],
  ["fast_snapshot", {"full":true}, "{\"url\":\"https://datatables.net/examples/core/basic_init/zero_configuration.html\",\"title\":\"Zero configuration\",\"fillable\":2,\"hint\":\"2 empty fillable fields visible; fill them in one fast_fill {fields:{label:value}} or one fast_batch\",\"count\":213,\"items\":[{\"i\":0,\"tag\":\"a\",\"text\":\"\",\"x\":257,\"y\":36,\"w\":180,\"h\":36,\"href\":\"https://datatables.net/\"},{\"i\":2,\"tag\":\"input\",\"text\":\"Search...\",\"x\":487,\"y\":15,"],
  ["fast_click", {"text":"Salary","role":"button","index":1}, "{\"error\":\"Only 1 matches for \\\"Salary\\\" (1 visible, 0 offscreen), index 1 out of range\",\"matches\":[{\"tag\":\"div\",\"role\":\"button\",\"text\":\"Salary: Activate to sort\"}],\"origin\":\"https://datatables.net\"}", true],
  ["fast_click", {"text":"Salary","role":"button","index":1}, "{\"error\":\"Only 1 matches for \\\"Salary\\\" (1 visible, 0 offscreen), index 1 out of range\",\"matches\":[{\"tag\":\"div\",\"role\":\"button\",\"text\":\"Salary: Activate to sort\"}],\"origin\":\"https://datatables.net\"}", true],
  ["fast_click", {"text":"Salary: Activate to sort","role":"button"}, "{\"clicked\":{\"i\":91,\"tag\":\"div\",\"text\":\"Salary: Activate to sort\",\"x\":1229,\"y\":351,\"w\":8,\"h\":24,\"role\":\"button\",\"ariaLabel\":\"Salary: Activate to sort\"},\"url\":\"https://datatables.net/examples/core/basic_init/zero_configuration.html\",\"urlChanged\":false,\"willNavigate\":false,\"totalMatches\":1,\"index\":0,\"snapshot\":{\"truncated\":true,\"dropped\":{\"items\":30,\"content\":52,\"offscreen\":148},\"hint\":\"auto-snapshot"],
  ["fast_click", {"text":"Salary: Activate to sort","role":"button"}, "{\"error\":\"No element matching \\\"Salary: Activate to sort\\\". Nothing was clicked.\",\"waitedMs\":1624,\"settling\":false,\"diagnostics\":[\"Text \\\"Salary: Activate to sort\\\" not found in the first 1500 elements (page too large to scan fully). Try more specific/visible text, fast_scroll, or narrow with role/tag.\"],\"origin\":\"https://datatables.net\"}", true],
  ["fast_click", {"text":"2","role":"link","index":1}, "{\"error\":\"Only 1 matches for \\\"2\\\" (1 visible, 0 offscreen), index 1 out of range\",\"matches\":[{\"tag\":\"button\",\"role\":\"link\",\"text\":\"2\"}],\"origin\":\"https://datatables.net\"}", true],
  ["fast_click", {"text":"Salary","role":"button"}, "{\"clicked\":{\"i\":91,\"tag\":\"div\",\"text\":\"Salary: Activate to invert sorting\",\"x\":1229,\"y\":351,\"w\":8,\"h\":24,\"role\":\"button\",\"ariaLabel\":\"Salary: Activate to invert sorting\"},\"url\":\"https://datatables.net/examples/core/basic_init/zero_configuration.html\",\"urlChanged\":false,\"willNavigate\":false,\"totalMatches\":1,\"index\":0,\"snapshot\":{\"truncated\":true,\"dropped\":{\"items\":30,\"content\":52,\"offscreen\":148},\""],
  ["fast_click", {"text":"Salary","role":"button"}, "{\"clicked\":{\"i\":91,\"tag\":\"div\",\"text\":\"Salary: Activate to remove sorting\",\"x\":1229,\"y\":351,\"w\":8,\"h\":24,\"role\":\"button\",\"ariaLabel\":\"Salary: Activate to remove sorting\"},\"url\":\"https://datatables.net/examples/core/basic_init/zero_configuration.html\",\"urlChanged\":false,\"settling\":true,\"hint\":\"page was still changing when this snapshot was taken (waited 159ms) — the view below may be incomplete; fa"],
  ["fast_click", {"text":"2","role":"link"}, "{\"clicked\":{\"i\":2211,\"tag\":\"button\",\"text\":\"2\",\"x\":1042,\"y\":848,\"w\":40,\"h\":34,\"role\":\"link\",\"innerText\":\"2\",\"type\":\"button\"},\"url\":\"https://datatables.net/examples/core/basic_init/zero_configuration.html\",\"urlChanged\":false,\"settling\":true,\"hint\":\"page was still changing when this snapshot was taken (waited 151ms) — the view below may be incomplete; fast_wait for text that identifies the finished "],
  ["fast_text", {"selector":"table#example","maxLen":200}, "{\"truncated\":true,\"dropped\":{\"chars\":552},\"hint\":\"only the first 200 of 752 chars are shown — call fast_text again with maxLen:752 (or omit maxLen), or a narrower selector, before relying on this text\",\"text\":\"Name\\n\\t\\nPosition\\n\\t\\nOffice\\n\\t\\nAge\\n\\t\\nStart date\\n\\t\\nSalary\\n\\nJena Gaines\\tOffice Manager\\tLondon\\t30\\t2008-12-19\\t$90,560\\nQuinn Flynn\\tSupport Lead\\tEdinburgh\\t22\\t2013-03-03\\t$34"],
];
test('b7184ddb (mapsdir) and 39d765d7 (h_table): real writes → no look, no annotation', async () => {
  for (const [label, rows, result, evidence, seen] of [
    ['mapsdir b7184ddb', MAPS_B718, "Destination box shows exactly \"Times Square, Manhattan, NY 10036\". Offers 3 route options.", "Destination Times Square, Manhattan, NY 10036; 1 hr 10 min15.0 milesvia Woodhaven Blvd and I-495 W; 1 hr 18 min16.8 milesvia I-678 N and I-495 W; 1 hr 16 min21.6 milesvia Grand Central Pkwy (URL https://www.google.com/maps/dir/John+F.+Kennedy+International+Airport,+Jamaica,+NY+11430/Times+Square,+Manhattan,+NY+10036/@40.7230383,-73.9654385,12z/data=!3m1!5s0x89c258f52ad45a79:0x8131f549e8af76f4!4m14!4m13!1m5!1m1!1s0x89c26650d5404947:0xec4fb213489f11f0!2m2!1d-73.7797222!2d40.6446161!1m5!1m1!1s0x89c25855c6480299:0x55194ec5a1ae072e!2m2!1d-73.9855426!2d40.7579747!3e0?entry=ttu&g_ep=EgoyMDI2MDkxNC4wIKXMDSoASAFQAw%3D%3D)", { 'route options': true }],
    ['h_table 39d765d7', TABLE_39D7, "Jena Gaines, London, $90,560 (first row on page 2 after double-click Salary descending).", "Jena Gaines\tOffice Manager\tLondon\t30\t2008-12-19\t$90,560 (from table#example innerText)", { 'Salary: Activate to sort': true }],
  ]) {
    const run = runOf(rows, { startedAt: Date.now() - 30000 });
    assert.equal(unlookedFailures(run), null, `${label}: the run wrote, so no look`);
    const d = seenDeps(seen);
    const v = await reportDecision(run, { result, evidence }, 30000, d);
    assert.equal(d.seen.shots, 0, label);
    let final = v.finish;
    for (let i = 0; !final && i < 4; i++) final = reportDone(run, { result, evidence }, 31000 + i).finish;
    assert.ok(final, `${label}: accepted within the refusal budget`);
    assert.equal(final.screenMismatch, undefined, label);
    assert.doesNotMatch(final.result, /\[screen check\]/, label);
  }
  // even with a look on record, a failed WAIT phrase is never annotated (the checker answers on meaning)
  const maps = runOf(MAPS_B718, { startedAt: Date.now() - 36000 });
  maps.visualChecks.push({ kind: 'report', idx: 6, seen: { 'route options': true }, deliveredAt: 35080, readyAt: 35079 });
  assert.deepEqual(screenMismatch(maps), []);
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

test('b1d84267: the look answers per target; a later report still failing on a seen WAIT phrase is accepted with NO annotation', async () => {
  const run = runB1();
  const d = seenDeps({ 'Virtual machine name': true });
  const v1 = await reportDecision(run, B1_REPORT_1, 41766, d);
  assert.equal(d.seen.described.askSeen, true, 'the look asks for per-target seen');
  assert.deepEqual(run.visualChecks[0].seen, { 'Virtual machine name': true });
  assert.ok(v1.note && v1.refuse, 'look + gate in one round, as before');
  push(run, 'fast_wait', { text: 'Virtual machine name', timeoutMs: 10000 }, JSON.stringify({ error: 'Timed out waiting for "Virtual machine name"', settling: false, headings: ['Microsoft Azure', 'Create a virtual machine'] }), true);
  run.toolLog.at(-1).t = run.visualChecks[0].deliveredAt + 1962;
  const v2 = await reportDecision(run, B1_REPORT_2, 47000, d);
  assert.ok(v2.finish, 'accepted — no second refusal loop');
  assert.equal(d.seen.shots, 1);
  assert.equal(v2.finish.screenMismatch, undefined, 'a wait phrase is model-invented: never annotated');
  assert.equal(v2.finish.result, B1_REPORT_2.result);
});

// A CLICK target the look saw, still failed at an accepted report with nothing done since: annotated.
const LOOK_4B = ['A "Create" button appears near the top left.'];
const lookDeps4b = (seen) => { const d = deps(LOOK_4B); const inner = d.describe; d.describe = async (a) => ({ ...(await inner(a)), seen }); return d; };
const run4bLooked = async (seen) => {
  const run = run4bf918fb(XY_NO_EFFECT, [], { startedAt: Date.now() - 29605 });   // the look lands after every row, as live
  const v1 = await reportDecision(run, REPORT_4B, 29605, lookDeps4b(seen));
  assert.ok(v1.note, 'the look went out');
  return run;
};
test('4bf918fb: a report still failing on a click target the look SAW is accepted with a mechanical annotation', async () => {
  const run = await run4bLooked({ 'Create a virtual machine': false, Create: true });
  let final;
  for (let i = 0; !final && i < 4; i++) final = reportDone(run, REPORT_4B, 33000 + i).finish;
  assert.ok(final, 'accepted within the refusal budget');
  assert.deepEqual(final.screenMismatch.map(m => [m.target, m.name]), [['Create', 'fast_click']]);
  assert.ok(final.result.startsWith(REPORT_4B.result), 'the model\'s own words are kept');
  assert.match(final.result, /\n\[screen check\] A screenshot taken at \d+s showed "Create" visible, and the run did not act on the page after that\.$/);
});

test('no annotation: target not seen, an action after the look, the failure resolved, no look, or malformed seen', async () => {
  assert.deepEqual(screenMismatch(await run4bLooked({ Create: false })), [], 'the look did not see the target');
  const acted = await run4bLooked({ Create: true });
  push(acted, 'fast_click', { text: 'Create', role: 'button' }, JSON.stringify({ clicked: { tag: 'button', text: 'Create' } }));
  acted.toolLog.at(-1).t = acted.visualChecks[0].deliveredAt + 10;
  assert.deepEqual(screenMismatch(acted), [], 'acted on the page after the look (and resolved the click)');
  const resolvedEarlier = await run4bLooked({ Create: true });
  resolvedEarlier.toolLog.splice(8, 0, { t: 7500, name: 'fast_click', args: { text: 'Create' }, ok: true, preview: '{}', wrote: true });
  assert.deepEqual(screenMismatch(resolvedEarlier), [], 'the failure was resolved');
  assert.deepEqual(screenMismatch(run4bf918fb()), [], 'no look, nothing to contradict');
  const malformed = await run4bLooked({ Create: 'yes', Other: true });
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
