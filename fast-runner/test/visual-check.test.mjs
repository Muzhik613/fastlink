// node --test — the VISUAL CHECK AT THE WRITE (visual-check.mjs + its wiring in
// runner.mjs), on synthetic runs: no browser, no Grok. Screenshot + checker injected.
// Motivating run: Azure 5f06a066 — a fill corrupted the VM name box at 37s, the
// end-of-run checker took 56s and said so at 103s; the gate's own problems came a
// further two rounds later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordResult, entryFacts, unverifiedWrites, reportDecision, deliverChecks, closeVisualChecks, gateProblems } from '../runner.mjs';
import { startVisualCheck, settleShots, takeNotes, checkNoteText, describeWithGrok, observationPrompt, CHECK_MODEL, MAX_VISUAL_CHECKS } from '../visual-check.mjs';

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

// ── what the model is told, and what the checker is asked ────────────────────
test('the note stays DUMB: no tool names, no widget classification, no verdict, no remedy', () => {
  const ours = checkNoteText(['Virtual machine name'], []);
  for (const banned of [/fast_[a-z_]+/, /\bdropdown\b/i, /\bcheckbox\b/i, /\btext field\b/i, /\bshould\b/i, /\bmust\b/i, /\bfailed\b/i, /\bwrong\b/i, /\bincomplete\b/i]) {
    assert.doesNotMatch(ours, banned, String(banned));
  }
  assert.match(ours, /"Virtual machine name" could not be read back/);
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
