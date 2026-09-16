// node --test — the end-of-run VISUAL NOTE (runner.mjs), on synthetic runs: no
// browser, no vision model, no Grok. Screenshot + vision are injected.
// Motivating run: Azure portal (cross-origin blade iframe), fast_type
// {clear:true, force:true} — nothing in the page could read the value back, the
// evidence gate had nothing to catch, and the report claimed the VM name was set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordResult, entryFacts, unverifiedWrites, visualNoteRound, closeVisualNote, visualNoteText, ensureVisionEnv, reportDecision, describeWithGrok, NOTE_MODEL } from '../runner.mjs';
import { claudeMcpEnv } from '../fastlink-client.mjs';

// Vision keys are process-global: save and restore them around anything that touches them.
const KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'];
// Works for sync AND async bodies: a plain try/finally would restore the real
// GEMINI_API_KEY the moment an async body returned its promise, so the very test
// that checks "no key anywhere" would run with the machine's key back in place.
function withEnv(fn) {
  const saved = Object.fromEntries([...KEYS, 'HOME'].map(k => [k, process.env[k]]));
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };
  for (const k of KEYS) delete process.env[k];
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.then(v => { restore(); return v; }, e => { restore(); throw e; });
  restore();
  return out;
}

const AZ = 'https://portal.azure.com/#create/Microsoft.VirtualMachine';
const snap = (url, ...texts) => JSON.stringify({ url, content: texts.map(text => ({ text })) });

// The task text travels to the checker (and nothing else about the run does).
const TASK = 'Create a virtual machine named fastlink-bench-vm in the Azure portal.';
function runOf(rows, extra = {}) {
  const run = { gate: 'on', task: TASK, toolLog: [], corpus: [], urlTrail: [], gateRefusals: [], turns: [], messages: [], visualNote: null, ...extra };
  rows.forEach(([name, args, text = '{}', isError = false], i) => {
    const ok = recordResult(run, text, isError);
    run.toolLog.push({ t: i * 1000, name, args, ok, preview: text.slice(0, 100), ...entryFacts(name, args, text, ok) });
  });
  return run;
}
// The real Azure call sequence, ending with the forced type that cannot be read back.
const azureRows = (typeResult) => [
  ['fast_tab', { url: AZ }, `{"id":1,"url":"${AZ}"}`],
  ['fast_snapshot', { full: true }, snap(AZ, 'Create a virtual machine', 'Basics')],
  ['fast_click_xy', { x: 492, y: 582 }, JSON.stringify({ clickedAt: { x: 492, y: 582 }, button: 'left', clickCount: 1 })],
  ['fast_type', { text: 'fastlink-bench-vm', clear: true, force: true }, JSON.stringify(typeResult)],
  ['fast_snapshot', { full: true }, snap(AZ, 'Create a virtual machine', 'Basics')],
];
const CROSS = { verified: false, reason: 'cross-origin: value not readable', typed: 17, cleared: true, forced: true, typedInto: { tag: 'iframe', label: 'sandbox-1.reactblade.portal.azure.net', value: '' } };
const OBS = ['The box labelled Virtual machine name looks empty and shows grey placeholder text.', 'There is a small red dot beside the word Basics at the top.', 'The page continues below the visible area.'];
const deps = (observations = OBS) => {
  const seen = { shots: 0, described: null };
  return {
    seen,
    screenshot: async () => { seen.shots++; return 'QkFTRTY0'; },
    describe: async (a) => { seen.described = a; return { observations }; },
  };
};

test('a forced write nothing read back is an unverified write, with its reason', () => {
  const run = runOf(azureRows(CROSS));
  assert.deepEqual(run.toolLog[3].partial, [{ name: 'fast_type', target: 'fastlink-bench-vm', unverified: true, reason: 'cross-origin: value not readable' }]);
  assert.deepEqual(unverifiedWrites(run.toolLog), [{ name: 'fast_type', target: 'fastlink-bench-vm', t: 3000, unverified: true, reason: 'cross-origin: value not readable' }]);
  // an OLD extension build that returns no `verified` at all is still a forced write with no read-back
  const old = runOf(azureRows({ typed: 17, cleared: true, forced: true, into: { tag: 'iframe' } }));
  assert.equal(unverifiedWrites(old.toolLog).length, 1);
  assert.match(unverifiedWrites(old.toolLog)[0].reason, /^forced: the editable-focus guard was bypassed/);
  // a fill whose field reverted counts too, and carries that field's own reason
  const fill = runOf([['fast_fill', { fields: { Name: 'x' } }, JSON.stringify({ verified: false, fields: { Name: { verified: false, reason: 'unreadable: the field is no longer in the page after the write' } } })]]);
  assert.deepEqual(unverifiedWrites(fill.toolLog), [{ name: 'fast_fill', target: 'Name', t: 0, unverified: true, reason: 'unreadable: the field is no longer in the page after the write' }]);
});

test('note produced when an unverified write exists: one screenshot, the claimed values passed, all fields recorded', async () => {
  const run = runOf(azureRows(CROSS));
  const d = deps();
  const note = await visualNoteRound(run, d);
  assert.equal(d.seen.shots, 1, 'exactly one screenshot');
  assert.deepEqual(d.seen.described, { base64: 'QkFTRTY0', values: ['fastlink-bench-vm'], intent: TASK });
  for (const o of OBS) assert.ok(note.includes(`- ${o}`), o);
  assert.match(note, /could not be read back/);
  assert.match(note, /Anything you want to fix, or is that expected\?/);
  assert.deepEqual(run.visualNote.observations, OBS);
  assert.deepEqual(run.visualNote.unverified.map(u => u.target), ['fastlink-bench-vm']);
  assert.equal(run.visualNote.model_response, null);
  assert.equal(run.visualNote.actedAfter, false);
});

test('the note stays DUMB: no tool names, no widget classification, no verdict, no remedy', () => {
  const text = visualNoteText(OBS);
  const ours = text.replace(OBS.map(o => o).join('|'), '');
  for (const banned of [/fast_[a-z_]+/, /\bdropdown\b/i, /\bselect\b/i, /\bcheckbox\b/i, /\btext field\b/i, /\bshould\b/i, /\bmust\b/i, /\bfailed\b/i, /\bwrong\b/i, /\bincomplete\b/i]) {
    assert.doesNotMatch(ours, banned, String(banned));
  }
});

test('skipped when everything verified — and it costs nothing (no screenshot taken)', async () => {
  const run = runOf([
    ['fast_tab', { url: AZ }, `{"id":1,"url":"${AZ}"}`],
    ['fast_type', { text: 'fastlink-bench-vm', force: true }, JSON.stringify({ verified: true, typed: 17, forced: true, typedInto: { tag: 'input', value: 'fastlink-bench-vm' } })],
    ['fast_snapshot', {}, snap(AZ, 'Basics')],
  ]);
  const d = deps();
  assert.equal(await visualNoteRound(run, d), null);
  assert.equal(d.seen.shots, 0);
  assert.equal(run.visualNote, null);
  // a later verified write on the same target also settles it: no note
  const fixed = runOf([...azureRows(CROSS), ['fast_fill', { match: 'fastlink-bench-vm', value: 'fastlink-bench-vm' }, '{"verified":true}']]);
  assert.equal(await visualNoteRound(fixed, deps()), null);
});

test('ONE round per run — but its own round: gate refusals can never crowd it out', async () => {
  const run = runOf(azureRows(CROSS));
  assert.ok(await visualNoteRound(run, deps()));
  const second = deps();
  assert.equal(await visualNoteRound(run, second), null, 'no second round');
  assert.equal(second.seen.shots, 0);
  // Live failure (Azure, 6ff5592): the gate refused twice on WORDING and the note —
  // the only check that can SEE the page — never ran. The budget is no longer shared:
  // however many refusals have happened, the note still gets its reserved round.
  for (const refusals of [[{ turn: 1 }], [{ turn: 1 }, { turn: 2 }], [{ turn: 1 }, { turn: 2 }, { turn: 3 }]]) {
    const r = runOf(azureRows(CROSS), { gateRefusals: refusals });
    assert.ok(await visualNoteRound(r, deps()), `${refusals.length} refusals`);
    assert.equal(r.visualNote.skipped, undefined);
  }
  // gate off measures the model alone: no note, no screenshot
  const off = runOf(azureRows(CROSS), { gate: 'off' });
  const offDeps = deps();
  assert.equal(await visualNoteRound(off, offDeps), null);
  assert.equal(offDeps.seen.shots, 0);
});

test('the note goes FIRST at report_done: eyes before the gate re-argues the log', async () => {
  const bad = { result: 'Set the VM name', evidence: 'nothing that quotes a result' };
  // a run with an unverified write: the note comes back, and the gate has not refused yet
  const run = runOf(azureRows(CROSS));
  const first = await reportDecision(run, bad, 1000, deps());
  assert.ok(first.note, 'the note is the first interruption');
  assert.equal(first.refuse, undefined);
  assert.deepEqual(run.gateRefusals, [], 'no refusal was spent to get here');
  // the SAME report after the note falls through to the gate as usual
  const second = await reportDecision(run, bad, 2000, deps());
  assert.equal(second.note, undefined);
  assert.ok(second.refuse?.length, 'the gate still does its job afterwards');
  assert.equal(run.gateRefusals.length, 1);
  // with every write read back there is no note round at all: straight to the gate
  const clean = runOf([['fast_tab', { url: AZ }, `{"id":1,"url":"${AZ}"}`], ['fast_snapshot', {}, snap(AZ, 'Basics')]]);
  const d = deps();
  const verdict = await reportDecision(clean, bad, 10, d);
  assert.equal(verdict.note, undefined);
  assert.equal(d.seen.shots, 0);
  assert.ok(verdict.refuse?.length);
});

test('no vision key / no screenshot / nothing observed are each recorded, not silently dropped', async () => {
  const noKey = runOf(azureRows(CROSS));
  assert.equal(await visualNoteRound(noKey, { screenshot: async () => 'QkFTRTY0', describe: async () => ({ observations: [], skipped: 'no vision' }) }), null);
  assert.equal(noKey.visualNote.skipped, 'no vision');
  assert.equal(noKey.visualNote.unverified.length, 1);

  const noShot = runOf(azureRows(CROSS));
  assert.equal(await visualNoteRound(noShot, { screenshot: async () => null, describe: async () => ({ observations: OBS }) }), null);
  assert.equal(noShot.visualNote.skipped, 'no screenshot');

  const threw = runOf(azureRows(CROSS));
  assert.equal(await visualNoteRound(threw, { screenshot: async () => 'QkFTRTY0', describe: async () => { throw new Error('gemini 503'); } }), null);
  assert.match(threw.visualNote.skipped, /checker failed: gemini 503/);

  const quiet = runOf(azureRows(CROSS));
  assert.equal(await visualNoteRound(quiet, { screenshot: async () => 'QkFTRTY0', describe: async () => ({ observations: [] }) }), null);
  assert.equal(quiet.visualNote.skipped, 'nothing observed');
});

// ── the REAL key wiring, not the injected seam ───────────────────────────────
// Live failure (owner's Chrome, a45d333): the run skipped with "no vision" on a
// page where fast_scout and fast_fill_vision had BOTH just succeeded. Vision runs
// in the SERVER the runner spawns, which inherits GEMINI_API_KEY from
// ~/.claude.json mcpServers.fastlink.env; the note runs vision in the RUNNER's own
// process, which has no such key. Injecting deps.describe hid exactly this.
test('the vision key is resolved the way the transport resolves it, and a miss names the key', () => {
  withEnv(() => {
    // no key in this process, but the MCP server's env has one -> resolved
    assert.equal(ensureVisionEnv(() => ({ GEMINI_API_KEY: 'k-from-claude-json', OPENROUTER_API_KEY: 'or' })), null);
    assert.equal(process.env.GEMINI_API_KEY, 'k-from-claude-json');
    assert.equal(process.env.OPENROUTER_API_KEY, 'or', 'the fallback tiers travel with it');
  });
  withEnv(() => {
    assert.equal(ensureVisionEnv(() => ({})), 'GEMINI_API_KEY');
    assert.equal(process.env.GEMINI_API_KEY, undefined);
    // an unreadable / absent ~/.claude.json is a miss, not a crash
    assert.equal(ensureVisionEnv(() => { throw new Error('ENOENT'); }), 'GEMINI_API_KEY');
  });
  withEnv(() => {
    // a key already in the process env wins and nothing is read
    process.env.GEMINI_API_KEY = 'already-here';
    let reads = 0;
    assert.equal(ensureVisionEnv(() => { reads++; return {}; }), null);
    assert.equal(reads, 0);
  });
});

test('the DEFAULT reader is ~/.claude.json mcpServers.fastlink.env — the same source the spawned server gets', () => {
  const home = mkdtempSync(join(tmpdir(), 'fastrun-home-'));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { fastlink: { env: { GEMINI_API_KEY: 'k-real-wiring' } } } }));
  withEnv(() => {
    process.env.HOME = home;
    assert.deepEqual(claudeMcpEnv('fastlink'), { GEMINI_API_KEY: 'k-real-wiring' });
    // no argument: this is the path the runner actually takes
    assert.equal(ensureVisionEnv(), null, 'the server-side key must be found with no injection');
    assert.equal(process.env.GEMINI_API_KEY, 'k-real-wiring');
  });
});

test('with no key anywhere the UNINJECTED describe path skips, naming the key, and still records the unverified write', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'fastrun-nohome-'));
  await withEnv(async () => {
    process.env.HOME = empty;   // no .claude.json at all
    const run = runOf(azureRows(CROSS));
    // deps.describe NOT injected, checker switched to the gemini path: the real key resolution runs
    assert.equal(await visualNoteRound(run, { model: 'gemini', screenshot: async () => 'QkFTRTY0' }), null);
    assert.match(run.visualNote.skipped, /^no vision: GEMINI_API_KEY is set neither in this process nor in ~\/\.claude\.json mcpServers\.fastlink\.env$/);
    assert.equal(run.visualNote.unverified.length, 1, 'what could not be read back is still recorded');
  });
});

test('both outcomes are recorded: the model acts on the note, or explains why it is expected', async () => {
  // acted: it fixes the field, then reports again
  const acted = runOf(azureRows(CROSS));
  await visualNoteRound(acted, deps());
  acted.toolLog.push({ t: 9000, name: 'fast_click_xy', args: { x: 492, y: 582 }, ok: true });
  acted.toolLog.push({ t: 9500, name: 'fast_type', args: { text: 'fastlink-bench-vm', force: true }, ok: true, verified: true });
  acted.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'You are right, the box was empty. Retyped it and the screenshot now shows the name.' }] });
  closeVisualNote(acted, 'VM name set to fastlink-bench-vm');
  assert.equal(acted.visualNote.actedAfter, true);
  assert.match(acted.visualNote.model_response, /Retyped it/);
  assert.equal(acted.visualNote.afterIdx, undefined);

  // explained: it changes nothing and says why — equally acceptable, equally recorded
  const explained = runOf(azureRows(CROSS));
  await visualNoteRound(explained, deps());
  explained.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Expected: the red dot is for Size and Image, which the task said to leave alone.' }] });
  closeVisualNote(explained, 'Basics filled; did not submit');
  assert.equal(explained.visualNote.actedAfter, false);
  assert.match(explained.visualNote.model_response, /^Expected: the red dot/);
  // closing twice never overwrites the first answer
  closeVisualNote(explained, 'something else');
  assert.match(explained.visualNote.model_response, /^Expected: the red dot/);
  // a skipped note has nothing to close
  const skipped = runOf(azureRows(CROSS));
  await visualNoteRound(skipped, { screenshot: async () => null });
  closeVisualNote(skipped, 'x');
  assert.deepEqual(Object.keys(skipped.visualNote), ['checker', 'skipped', 'unverified']);
});

// ── the checker: a BRAND-NEW conversation, given the goal and the screen ─────
// Not the model driving the run and not a continuation of it: a fresh instance
// cannot be anchored by the reasoning that produced the mistake, and describing is
// all it can do. It gets the task text (so it knows which blanks matter) and the
// image — never the plan, the history, the claimed results or our tool names.
const answer = (observations, extra = {}) => async () => ({
  content: [{ type: 'text', text: JSON.stringify({ observations }) }], _timing: { latencyMs: 1234 }, ...extra,
});

test('the checker call: one fresh user turn, the image, the goal — no history, no tools, no fast_* vocabulary', async () => {
  const sent = [];
  const create = async (req) => { sent.push(req); return (await answer(OBS)())
    ; };
  const run = runOf(azureRows(CROSS));
  const note = await visualNoteRound(run, { screenshot: async () => 'QkFTRTY0', create });
  assert.equal(sent.length, 1, 'one call, one round');
  const req = sent[0];
  assert.equal(req.model, 'grok-4.6', 'default checker');
  assert.equal(NOTE_MODEL, 'grok-4.6');
  assert.equal(req.system, undefined, 'no system prompt: it is not an operator');
  assert.equal(req.tools, undefined, 'it cannot act, only describe');
  assert.equal(req.messages.length, 1, 'a FRESH conversation: no run history');
  assert.equal(req.messages[0].role, 'user');
  const img = req.messages[0].content.find(c => c.type === 'image');
  assert.equal(img.source.data, 'QkFTRTY0');
  assert.equal(img.source.media_type, 'image/png');
  const text = req.messages[0].content.find(c => c.type === 'text').text;
  assert.match(text, /Create a virtual machine named fastlink-bench-vm in the Azure portal/, 'the goal travels');
  assert.match(text, /"fastlink-bench-vm"/, 'and the value whose write went unread');
  assert.doesNotMatch(text, /fast_[a-z_]+/, 'our tool vocabulary never does');
  assert.doesNotMatch(text, /report_done|verified:false|cross-origin/, 'nor the run log');
  // recorded for the audit: who looked, and what it cost
  assert.equal(run.visualNote.checker, 'grok-4.6');
  assert.equal(run.visualNote.checkerMs, 1234);
  for (const o of OBS) assert.ok(note.includes(`- ${o}`), o);
});

test('the checker model is configurable — a 4.3 A/B, and the gemini path still exists', async () => {
  const sent = [];
  const run = runOf(azureRows(CROSS));
  await visualNoteRound(run, {
    model: 'grok-4.3', screenshot: async () => 'QkFTRTY0',
    create: async (req) => { sent.push(req.model); return (await answer(OBS)()); },
  });
  assert.deepEqual(sent, ['grok-4.3']);
  assert.equal(run.visualNote.checker, 'grok-4.3');
  // "gemini" routes to the old vision tier instead of the proxy — no checker call at all
  const gem = runOf(azureRows(CROSS));
  let called = 0;
  await visualNoteRound(gem, {
    model: 'gemini', screenshot: async () => 'QkFTRTY0',
    create: async () => { called++; return (await answer(OBS)()); },
    describe: async () => ({ observations: OBS }),
  });
  assert.equal(called, 0);
  assert.equal(gem.visualNote.checker, 'gemini');
});

test('the checker answer is parsed out of whatever it replies with, capped at 8, and kept in register', async () => {
  const wordy = [
    'The Subscription box reads empty.', 'The Resource group box shows Select....',
    'The Region box reads empty.', 'The Image box reads empty.', 'The Size box reads empty.',
    'Click the Region box and pick East US.',            // an instruction: dropped
    'The form is incomplete and must be finished.',      // a verdict: dropped
    'The Basics tab shows a red mark.', 'A red line under the name box reads "This field is required".',
    'The form continues below the visible area.', 'The Tags tab is at the far right.',
  ];
  const out = await describeWithGrok({ base64: 'QkFTRTY0', values: [], intent: 'x' }, {
    // a model that wraps its JSON in prose, as they do
    create: async () => ({ content: [{ type: 'text', text: `Here is what I see:\n${JSON.stringify({ observations: wordy })}` }], _timing: { latencyMs: 9 } }),
  });
  assert.equal(out.observations.length, 8);
  const text = out.observations.join('\n');
  for (const banned of [/fast_[a-z_]+/, /^Click /m, /\bmust be\b/, /\bincomplete\b/, /\bdropdown\b/i]) {
    assert.doesNotMatch(text, banned, String(banned));
  }
  // a checker that errors is recorded, never thrown
  const failed = await describeWithGrok({ base64: 'QkFTRTY0' }, { create: async () => { throw new Error('xai 503'); } });
  assert.deepEqual(failed.observations, []);
  assert.match(failed.skipped, /^checker failed: xai 503/);
});

// ── the detector: an unread write is found WHEREVER the tool reports it ──────
// Live miss (Azure, 04ca273): Grok used fast_do, the unread write sat in
// `executed[]`, `unverifiedWrites` came back empty and the note never ran — the
// THIRD distinct reason it had not fired on a real page. The rule is structural
// now, so a shape change fails a test instead of silently disabling the note.
const FAST_DO = {
  plan: [{ action: 'type', target: 'Virtual machine name text input', value: 'fastlink-bench-vm' }],
  executed: [{ action: 'type', target: 'Virtual machine name text input', value: 'fastlink-bench-vm', x: 492, y: 582, verified: false, reason: 'unreadable: typed but not read back' }],
  skipped: [], stoppedBefore: [], note: 'stopped before Create',
};
const NESTED_BATCH = {
  args: { actions: [{ name: 'fast_click', args: { match: 'Virtual machine name' } }, { name: 'fast_type', args: { text: 'fastlink-bench-vm' } }] },
  result: { summary: '2/2 steps ok', ok: 2, steps: 2, results: [
    { step: 0, name: 'fast_click', ok: true, result: { clickedAt: { x: 492, y: 582 } } },
    { step: 1, name: 'fast_type', ok: true, result: { typed: 17, verified: false, reason: 'cross-origin: value not readable', typedInto: { tag: 'iframe', value: '' } } },
  ] },
};

test('fast_do reports its unread write one level down — and it is still found', () => {
  const run = runOf([['fast_do', { intent: 'type the VM name' }, JSON.stringify(FAST_DO)]]);
  assert.deepEqual(unverifiedWrites(run.toolLog), [{
    name: 'fast_do', target: 'Virtual machine name text input', t: 0,
    unverified: true, reason: 'unreadable: typed but not read back',
  }]);
});

test('a nested fast_batch step carries its own unread write, named by the step target', () => {
  const run = runOf([['fast_batch', NESTED_BATCH.args, JSON.stringify(NESTED_BATCH.result)]]);
  assert.deepEqual(unverifiedWrites(run.toolLog), [{
    name: 'fast_type', target: 'fastlink-bench-vm', t: 0,
    unverified: true, reason: 'cross-origin: value not readable',
  }]);
});

test('ANY verified:false anywhere in a result produces a note, whatever shape it arrives in', async () => {
  const shapes = {
    'top-level fast_type': ['fast_type', { text: 'fastlink-bench-vm', clear: true, force: true }, CROSS],
    'fast_do executed[]': ['fast_do', { intent: 'type the VM name' }, FAST_DO],
    'nested fast_batch step': ['fast_batch', NESTED_BATCH.args, NESTED_BATCH.result],
    'fast_fill {fields}': ['fast_fill', { fields: { Region: 'East US' } }, { verified: false, fields: { Region: { verified: false, reason: 'unreadable: the field is no longer in the page after the write' } } }],
    'fast_fill_vision filled[]': ['fast_fill_vision', { fields: { Region: 'East US' } }, { filled: [{ field: 'Region', verified: false, reason: 'unreadable: value not readable' }] }],
    'fast_select_option results{}': ['fast_select_option', { field: 'Region', value: 'East US' }, { verified: true, results: { Region: { verified: false, picked: 'East US', reason: 'the pick did not take' } } }],
  };
  for (const [label, [name, args, payload]] of Object.entries(shapes)) {
    const run = runOf([[name, args, JSON.stringify(payload)]]);
    assert.ok(unverifiedWrites(run.toolLog).length, `${label}: detected`);
    assert.ok(await visualNoteRound(run, deps()), `${label}: note produced`);
    assert.equal(run.visualNote.skipped, undefined, label);
  }
});
