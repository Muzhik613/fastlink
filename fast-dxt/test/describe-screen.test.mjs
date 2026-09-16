// node --test — the PROMPT/PARSE path of describeScreen (the fast-runner visual
// note's eyes). The model call is injected, so this is offline: no key, no image,
// no network. What is under test is (1) what the screen is asked about and (2)
// what survives the parse.
//
// Motivating run: Azure's create-VM wizard. The model vision-typed the VM name
// and stopped; Subscription, Resource group, Region, Image and Size were never
// touched and sat empty, with a red dot on the Basics tab. A note that only
// describes the values the model CLAIMED says nothing about any of that.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js reads process.env at module load and SCOUT_ENABLED gates describeScreen.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';
const { describeScreen } = await import('../server/scout.js');

// Captures the prompt the way the model would receive it.
function capture(answer) {
  const seen = {};
  const call = async (a) => {
    seen.parts = a.parts;
    seen.prompt = (a.parts || []).map((p) => p.text || '').join(' ');
    seen.image = (a.parts || []).find((p) => p.inlineData) || null;
    if (typeof answer === 'function') return answer(a);
    return answer;
  };
  return { seen, call };
}
const PNG = 'data:image/png;base64,QkFTRTY0';

test('the screen is asked about the whole form, not only the values the model claimed', async () => {
  const { seen, call } = capture({ observations: ['The Region box reads empty.'] });
  await describeScreen({ base64: PNG, values: ['fastlink-bench-vm'] }, { call });
  const p = seen.prompt;
  // (a) every empty / placeholder box, by its printed label, required markers included
  assert.match(p, /EVERY box that looks empty or still shows greyed placeholder text/);
  assert.match(p, /Select\.\.\."\/"Choose/);
  assert.match(p, /naming the label printed[\s\S]*required/);
  assert.match(p, /even if they seem unrelated/, 'the untouched fields are the point');
  // (b) validation marks: dots/outlines/icons, a message under a box, a banner, a mark on a tab
  assert.match(p, /red\/orange marks, dots, outlines/);
  assert.match(p, /a message under a box or a banner across the top/);
  assert.match(p, /a mark on a tab or step name/);
  // (c) more content below the fold
  assert.match(p, /content continues[\s\S]*below the visible area/);
  // (d) the claimed values, still there — and first in line, so the 8-line cap on a
  // wide-open form can never crowd out the one field the run actually claimed
  assert.match(p, /"fastlink-bench-vm"/);
  assert.match(p, /say what the box that should hold it reads right now/);
  assert.match(p, /report these FIRST, before \(a\), \(b\) and \(c\)/);
  // the image rides along as raw base64 (the data: prefix is stripped)
  assert.equal(seen.image.inlineData.data, 'QkFTRTY0');
});

test('the checker is told the GOAL and nothing else about the run', async () => {
  const { seen, call } = capture({ observations: [] });
  const intent = "Create a VM named fastlink-bench-vm; use fast_type for the name and fast_fill for the rest.";
  await describeScreen({ base64: PNG, values: [], intent }, { call });
  const p = seen.prompt;
  // the task text is there — without it a blank box on a thirty-field form means nothing
  assert.match(p, /Create a VM named fastlink-bench-vm/);
  assert.match(p, /Read the screen in light of that goal/);
  // ...but our tool vocabulary never reaches it, even when the task text uses it
  assert.doesNotMatch(p, /fast_[a-z_]+/);
  // and nothing else about the run travels with it
  assert.match(p, /you cannot see what they did, how they did it or what they say happened/);
  // no intent: no goal sentence at all, and the rest of the prompt is unchanged
  const bare = capture({ observations: [] });
  await describeScreen({ base64: PNG, values: [] }, { call: bare.call });
  assert.doesNotMatch(bare.seen.prompt, /asked to accomplish/);
  assert.match(bare.seen.prompt, /EVERY box that looks empty/);
});

test('the prompt asks for a SHORT list and forbids the register the note must never use', async () => {
  const { seen, call } = capture({ observations: [] });
  await describeScreen({ base64: PNG, values: [] }, { call });
  const p = seen.prompt;
  assert.match(p, /at most 8 observations, each ONE short sentence/);
  assert.match(p, /name the ones nearest the top of the page and say how many others look empty/);
  // the register it must write in, by example
  assert.match(p, /the Subscription box\s+reads empty/);
  assert.match(p, /the Basics tab shows a red mark/);
  // and the three things it must never do
  assert.match(p, /Do NOT name control types/);
  assert.match(p, /do NOT name any tool or action/);
  assert.match(p, /No advice, no verdicts/);
  // with no claimed values there is no (d) clause to answer
  assert.doesNotMatch(p, /\(d\)/);
});

test('parse: a synthetic answer is capped at 8 and keeps only plain observations', async () => {
  const answer = {
    observations: [
      '  The Subscription box   reads empty.  ',           // whitespace collapsed
      'The Resource group box shows the greyed word Select.',
      'The Region box reads empty.',
      'The Image box reads empty.',
      'The Size box reads empty.',
      'The Basics tab shows a small red mark.',
      'A red line under the Virtual machine name box reads "This field is required".',
      'The form continues below the visible area.',
      'The Project details heading is at the top of the page.',   // #9: over the cap
      'The Tags tab is at the far right.',                         // #10: over the cap
    ],
  };
  const { call } = capture(answer);
  const out = await describeScreen({ base64: PNG, values: [] }, { call });
  assert.equal(out.observations.length, 8, 'the list stays cheap to hand back');
  assert.equal(out.observations[0], 'The Subscription box reads empty.');
  assert.equal(out.observations[7], 'The form continues below the visible area.');
  assert.ok(!out.observations.some((o) => /Project details heading/.test(o)), 'past the cap is dropped');
  assert.equal(out.skipped, undefined);
});

test('an answer that slips into verdicts, remedies or tool names loses those lines', async () => {
  const { call } = capture({
    observations: [
      'The Region box reads empty.',                                  // kept
      'Click the Region box and choose East US.',                     // an instruction
      'You should fill in the Resource group.',                       // an instruction
      'Use fast_select_option on the Image list.',                    // names one of our tools
      'The Basics tab shows a red mark.',                             // kept
      'The form is incomplete and must be finished before Next.',     // a verdict
      'The Subscription value is wrong.',                             // a verdict
      'The form continues below the visible area.',                   // kept
      '',                                                             // empty
      null,                                                           // junk
    ],
  });
  const out = await describeScreen({ base64: PNG, values: [] }, { call });
  assert.deepEqual(out.observations, [
    'The Region box reads empty.',
    'The Basics tab shows a red mark.',
    'The form continues below the visible area.',
  ]);
  const text = out.observations.join('\n');
  for (const banned of [/fast_[a-z_]+/, /\bdropdown\b/i, /\byou should\b/i, /\bmust be\b/i, /\bis wrong\b/i, /\bincomplete\b/i]) {
    assert.doesNotMatch(text, banned, String(banned));
  }
});

test('a broken answer or a failed call is a skip, never a throw', async () => {
  // no image at all
  assert.deepEqual(await describeScreen({ base64: null }), { observations: [], skipped: 'no image' });
  // the model answered with something that is not a list of observations
  for (const junk of [{}, { observations: 'a string' }, { observations: null }]) {
    const out = await describeScreen({ base64: PNG }, { call: async () => junk });
    assert.deepEqual(out.observations, []);
  }
  // every provider tier exhausted
  const failed = await describeScreen({ base64: PNG }, { call: async () => { throw new Error('gemini 503'); } });
  assert.deepEqual(failed.observations, []);
  assert.match(failed.skipped, /^vision failed: gemini 503/);
});
