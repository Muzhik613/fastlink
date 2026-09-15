# Grok runner — HOLDOUT baseline, hvm, local transport (2026-09-15)

Holdout = `bench/holdout.js` (ids `h_*`): six public sites FastLink was never tuned against, one per
widget family. Owner's rule: *every website is different — a fix has to work everywhere.* A fix is
proven on the main suite and only CHECKED here; nothing may be tuned against these sites.

Run: `grok_runner`, `--transport local --install primary --toolset phase2`, `FASTRUN_MODEL=grok-4.3`,
report_done gate **on**, one cell per test, sequential, on `cdf5f6c` (hvm rig: Xvfb + Chrome for
Testing + unpacked fast-ext + local broker). Rows since 2026-09-15T20:47:34Z in hvm's
`bench/results.jsonl`; tool logs from `~/.local/state/fastrun/runs.jsonl`. No relay baseline exists
for these tests.

## Checkpoint validation (METHOD RULE — both directions, by hand through the local FastLink tools)

| test | site / widget | untouched | done by hand | how (tools) |
|---|---|---:|---:|---|
| h_conditional | GOV.UK conditional-reveal radios | 1/6 | 6/6 | radio label via fast_evaluate rect → fast_click_xy (fast_click could not), fast_fill |
| h_datepicker | jQuery UI inline datepicker (no input) | 1/4 | 4/4 | fast_point found Next (vision, conf 1.0); Next ×3 via rect → fast_click_xy; fast_click "24" |
| h_combobox | Select2 single select | 1/4 | 4/4 (typed-not-committed: 1/4) | trusted click on the widget → fast_type "Oregon" → fast_key Enter |
| h_table | DataTables sort + paginate | 1/6 | 6/6 | fast_click "Salary" ×2, fast_click "2" role=button |
| h_repeat | Form.io data grid + Choices.js + conditional field | 1/7 | 7/7 | fast_click Add Another, fast_fill by name, fast_click Dependant index 2, trusted clicks on the Choices widget + option, fast_fill Birthdate index 1 + Tab |
| h_spa | jsDelivr search → package → Files | 1/5 | 5/5 | fast_fill search, fast_click result, fast_click Files |

The one untouched pass per test is the `tab` checkpoint (as in suite.js). `h_repeat`'s seed
checkpoint was tightened AFTER the baseline (seeded rows must be unchanged in every field) and
re-validated both ways (1/7 → 7/7).

## Per test

Cell = `score/total wall calls [m=model time]` · flags: ! overclaim, ~ reported not-done.

| test | score | wall | calls | outcome | runner status | claimed | overclaim |
|---|---:|---:|---:|---|---|---|---|
| h_conditional | 1/6 | 37.2s | 20 | FINISHED | error: 3 consecutive tool errors | no | – |
| h_datepicker | 1/4 | 7.7s | 5 | FINISHED | error: 3 consecutive tool errors | no | – |
| h_combobox | 1/4 | 6.7s | 5 | FINISHED | done | yes | **!** |
| h_table | 6/6 | 6.8s | 6 | FINISHED | done | yes | – |
| h_repeat | 4/7 (3/7 re-scored) | 36.9s | 14 | FINISHED | done | yes | **!** |
| h_spa | 5/5 | 8.5s | 8 | FINISHED | done | yes | – |

Totals: 6 valid cells, **18/32** checkpoints (17/32 with the tightened h_repeat seed check, re-scored
on the same live page), 58 tool calls, 103.9s wall, **2 overclaims** — both passed the report_done
gate because the tool's own `verified` flag was wrong or wrongly aggregated (see below).
Main suite for contrast, same rig and day: 6/6 on multipage and mapsdir.

## Tool histogram

| tool | calls | errors | avg ms | fumbles | tests |
|---|---:|---:|---:|---:|---|
| fast_click | 18 | 10 | 946 | 8 | all six |
| fast_snapshot | 18 | 0 | 42 | 0 | all six |
| fast_tab | 6 | 0 | 298 | 0 | all six |
| fast_fill | 5 | 2 | 726 | 2 | h_repeat, h_spa |
| fast_text | 5 | 0 | 24 | 0 | h_conditional, h_table |
| fast_select_option | 3 | 0 | 397 | 0 | h_combobox, h_repeat |
| fast_batch | 1 | 0 | 3770 | 0 | h_repeat |
| fast_key_press | 1 | 0 | 164 | 0 | h_spa |
| fast_scroll | 1 | 0 | 189 | 0 | h_repeat |

## Failures — where each went wrong

### h_conditional 1/6 — TOOL gap (model made it worse)
- **#2 `fast_snapshot {full:true}` → `count: 0` interactive items.** GOV.UK radios are native
  `<input type=radio>` at `opacity:0` with a visible `<label for>` drawn over them; the snapshot lists
  neither, so the page reads as having no controls.
- **#3 `fast_click {text:"Text message", role:"label"}`** → "No element matching … 1 non-interactive
  match". Six more variants (#5 tag=label, #12/#13 index, #18 `contact-3`, #19, #20) all miss; the
  runner stopped on 3 consecutive errors. Reported not-done (honest).
- Model part: it repeated near-identical clicks and never tried the fallback the diagnostic names
  (fast_evaluate / fast_click_xy) — that path works (validation above).

### h_datepicker 1/4 — TOOL gap
- **#2 snapshot** lists the day cells (`<a href="#">`) but not Prev/Next — those are `<a>` with NO
  href (`data-handler="next"`, `title="Next"`).
- **#3–#5 `fast_click {text:"Next", role:"generic"}`** ×3, identical → non-interactive miss → runner
  stop. Reported not-done (honest). Model part: three identical retries; `fast_point` finds the arrow
  (validated), never tried.

### h_combobox 1/4 — OVERCLAIM; TOOL gap + MODEL choice
- **#3 `fast_click {text:"Alaska", role:"combobox"}`** clicked the plain native
  `<select class="js-states">` — the page's un-enhanced twin in the same "Single select boxes"
  section — not the Select2 `[role=combobox]` span. The role filter matched the native select's
  implicit role.
- **#4 `fast_select_option {field:"Single select boxes¶", option:"Oregon"}`** → `kind: native-select,
  verified: true` — on the twin. Live readback after the run: `select.js-states = OR`, the Select2
  control still `AK`/Alaska. Report: "Selected Oregon … (native select value=Oregon)". The gate
  accepted it because the tool said verified. Note the `¶` heading-permalink glyph baked into the
  section name.
- Model part: the prompt said "search for and select"; a native select has no search, and it never
  read the widget back.

### h_repeat 4/7 (3/7) — OVERCLAIM; TOOL gaps + MODEL overclaim
- **#4 `fast_batch`**: its fast_fill `section:"Children"` missed 0/2 ("section not found"), yet the
  batch summary says **"3/3 steps ok"**.
- **#6 `fast_select_option {field:"Gender", option:"Female"}`** (selections mode) opened row 1's
  (Joe's) Choices widget — the three rows share the label and there is no `index`. Per-field result
  `verified:false`, wrapper `verified:true, picked:1, failed:0`. #7 repeats it; row 3 Gender stays "".
  (#4 had passed `index:2`, which fast_select_option ignores.)
- **#8/#9 `fast_fill {match:"Birthdate", index:2}`** → "Only 1 fillable match": row 3's Birthdate only
  exists after Dependant is ticked, and the model never ticked it.
- **#13 `fast_fill {match:"Birthdate", value:"2015-12-10"}`** (no index) wrote into **Joe's seeded
  row** (live readback: Joe's birthdate `1982-05-18` → `2015-12-10`). The tool said `verified:false`
  ("page reformatted … do not report the written value as set").
- Report: "Gender=Female, Dependant=true (ticked), Birthdate=2015-12-10 __:__ __" — Dependant and
  Birthdate claimed against the tool's own verified:false → MODEL overclaim. The gate accepted it:
  the wrapper summaries said ok/verified.

### h_table 6/6, h_spa 5/5
Clean: header click ×2 + page button; search fill → result click → Files tab, 6 and 8 calls.

## Tool gaps → the generic contract each needs (no site-specific fixes)

1. **Label-proxied controls** (h_conditional). A native radio/checkbox whose input is visually
   hidden (opacity 0 / clipped / 1px) but whose associated `<label>` (for= or wrapping) is visible is
   a visible, interactive control: fast_snapshot lists it (role radio/checkbox, label text, checked
   state), and fast_click by its label text activates it and returns the checked state afterwards.
2. **Script-driven click targets** (h_datepicker). An element with computed `cursor:pointer`, or an
   `<a>` with no href but with text/title, is a click candidate, ranked below real controls; the
   snapshot lists it, and fast_click fires the full pointer sequence on it instead of refusing.
3. **Ambiguous select resolution** (h_combobox). When a field/section/role resolves to more than one
   select-like control (native `<select>` and an ARIA combobox / enhanced widget), fast_click and
   fast_select_option return an ambiguity error listing each candidate (kind, label, current value,
   index) instead of silently picking one. An explicit `role` filter matches an explicit `[role]`
   attribute before an implicit one. Section names are stripped of heading-permalink glyphs.
4. **Repeated-label selects** (h_repeat). fast_select_option gets fast_fill's disambiguation
   contract: `index` (document order) and `section`, never falling back to a same-label control
   elsewhere. A label that matches ≥2 selects without either is an error listing the rows.
5. **Honest aggregation** (h_repeat; this is what let both overclaims through the gate). A batch step
   or a `selections` entry counts as ok only if its own result is `verified:true` with `missed:0`.
   A wrapper's `verified` is the AND of its children, and `"n/n steps ok"` counts only those.
6. **Row-group writes** (h_repeat). When a label belongs to a repeated row group (same label in ≥2
   rows, even if the other rows' copies are hidden), fast_fill without `index`/`section` either
   errors or names the row it wrote (row index / name attribute). It must never silently write row 0.

Model-side (not tool): repeating an identical failing call instead of the fallback the diagnostic
names (h_conditional, h_datepicker), and reporting values the tool marked `verified:false`
(h_repeat).
