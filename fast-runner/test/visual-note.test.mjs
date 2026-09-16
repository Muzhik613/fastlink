// node --test — the end-of-run VISUAL NOTE (runner.mjs), on synthetic runs: no
// browser, no vision model, no Grok. Screenshot + vision are injected.
// Motivating run: Azure portal (cross-origin blade iframe), fast_type
// {clear:true, force:true} — nothing in the page could read the value back, the
// evidence gate had nothing to catch, and the report claimed the VM name was set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordResult, entryFacts, unverifiedWrites, visualNoteRound, closeVisualNote, visualNoteText } from '../runner.mjs';

const AZ = 'https://portal.azure.com/#create/Microsoft.VirtualMachine';
const snap = (url, ...texts) => JSON.stringify({ url, content: texts.map(text => ({ text })) });

function runOf(rows, extra = {}) {
  const run = { gate: 'on', toolLog: [], corpus: [], urlTrail: [], gateRefusals: [], turns: [], messages: [], visualNote: null, ...extra };
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
  assert.deepEqual(d.seen.described, { base64: 'QkFTRTY0', values: ['fastlink-bench-vm'] });
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

test('at most ONE round per run, and never past the interruption ceiling', async () => {
  const run = runOf(azureRows(CROSS));
  assert.ok(await visualNoteRound(run, deps()));
  const second = deps();
  assert.equal(await visualNoteRound(run, second), null, 'no second round');
  assert.equal(second.seen.shots, 0);
  // two gate refusals already spent the ceiling: the note is skipped and says so
  const refused = runOf(azureRows(CROSS), { gateRefusals: [{ turn: 1 }, { turn: 2 }] });
  const d = deps();
  assert.equal(await visualNoteRound(refused, d), null);
  assert.equal(d.seen.shots, 0);
  assert.match(refused.visualNote.skipped, /interruption budget/);
  // one refusal still leaves room for the note (1 + 1 = the ceiling)
  const once = runOf(azureRows(CROSS), { gateRefusals: [{ turn: 1 }] });
  assert.ok(await visualNoteRound(once, deps()));
  // gate off measures the model alone: no note, no screenshot
  const off = runOf(azureRows(CROSS), { gate: 'off' });
  const offDeps = deps();
  assert.equal(await visualNoteRound(off, offDeps), null);
  assert.equal(offDeps.seen.shots, 0);
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
  assert.match(threw.visualNote.skipped, /vision failed: gemini 503/);

  const quiet = runOf(azureRows(CROSS));
  assert.equal(await visualNoteRound(quiet, { screenshot: async () => 'QkFTRTY0', describe: async () => ({ observations: [] }) }), null);
  assert.equal(quiet.visualNote.skipped, 'nothing observed');
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
  assert.deepEqual(Object.keys(skipped.visualNote), ['skipped', 'unverified']);
});
