# Grok runner — HOLDOUT 2 after the five tool-gap fixes (2026-09-16)

Follow-up to `docs/GROK_RUNNER_HOLDOUT2_2026-09-15.md`. The five generic gaps that holdout-2's by-hand
pass found were fixed, proven live by tool call on two or more sites each, then checked with one
`grok_runner` cell per holdout-2 test.

**Partial result.** Five of the twelve planned cells are valid. The h1 regression six and h2_infinite
have **no result** (see "Not run").

## The fixes

| gap | commit(s) | proven live on |
|---|---|---|
| 1. `fast_select_option` returned `verified:false` on a committed custom-listbox pick | `4c4ce88`, `b62ad86` | Syncfusion EJ2: read back `"From"`, now `Chicago`, `verified:true`. Element Plus: read back `""`, now `Zone No.2`. |
| 2. A selectable grid row was refused as a "suggestion" | `1022e3d`, `c484620` | EJ2 grid row clicked and selected (`aria-selected:"true"`); DataTables row clicked and selected |
| 3. Rows could not be reached by their text | `fb5d353` | EJ2 `<td>` and DataTables `<td>` clicked via `"text"`. On Wunderbaum the click hit the row span (`"text-leaf"`), not the 1270×635 tree host. |
| 4. A committed option click still said "use fast_select_option instead" | `bbead9d` | W3C APG listbox-scrollable and listbox-grouped: no hint, and the option is selected. A click on the trigger still gets the hint. |
| 5. `fast_click_xy` did not report focus | `eb7b84d` | DataTables page and EJ2 field: `focused`, plus a hint when nothing editable holds focus |

What is still missing or unsolved:
- **Gap 1 outside the holdout-2 six.** jQuery UI selectmenu and Angular Material verify after the fix,
  but they have no before measurement. On Kendo, the old and new read-backs return the same value, so
  that widget never hit the bug. Shoelace, Kendo and Vaadin all failed before any read-back ran, for
  reasons unrelated to it. The fix only matters for widgets whose value element carries
  `aria-expanded`, or that hide their input wrapper once a value is chosen. Both shapes were found on
  two different stacks, EJ2 and Vue 3.
- **Gap 3 is not fully solvable generically.** A row that a virtualized tree has never rendered is not
  in the DOM, so no click call can find it by text. A miss now names the scroll container in
  `scrollers` and the hint gives the `fast_scroll` selector. An icon-only checkbox (`<i class="wb-checkbox">`,
  with no role, label or text) cannot be targeted by text at all. Coordinates or vision are the honest
  answer there.

## Cells

Rig: hvm on `7a0ab3b`. `b62ad86` is its ancestor, and nothing under `fast-ext/` differs between them.
Settings: `grok_runner`, local transport, install primary, `--toolset phase2`, `FASTRUN_MODEL=grok-4.3`,
gate on, one cell per invocation. Baseline is the recorded 00:26–00:31Z set; call and error counts come
from `runs.jsonl` for that set.

**Per cell only, with no combined total.** In the baseline, 988 of 1047 calls are one runaway slider
cell, so a total is meaningless.

**Read tool errors, not calls.** A fix that lets the model get further raises the call count. Wizard
went from 11 calls to 27 because it now completes all four steps. Do not "optimise" these fixes back
toward a smaller number.

### h2_wizard: 7/8 (baseline 1/8), OVERCLAIM
- 53.1s (60.3s) · 27 calls (11) · 4 tool errors (2).
- Errors: `fast_wait` timed out; `fast_click {text:"19004", role:"cell"}` and `{text:"36", role:"cell"}`
  found no element; `fast_select_option {field:"dropdownlist", option:"Window", index:0}` found no matching option.
- The row click that worked was `fast_click {text:"19004", index:1}`, via `"text"` (gap 3 in a real run).
- **Claim vs live.** Claimed: "Train 19004 booked (36 seats, most available); total payable amount $500".
  Live values: route `Chicago->Seattle`, class `Business Class`, train `19004`, most seats true, amount
  `$500`, on the payment step and unpaid. Passenger 1 is `Grace Hopper|45|Female|Any`, where the task
  wanted Berth = `Window`. That is the one lost checkpoint.
- **Is verified:true telling the truth?** All three `fast_select_option` picks (From, To, Ticket Type)
  returned `verified:true`, and the live page agrees on all three. The baseline returned `verified:false`
  on the same committed picks. No write in this cell returned `verified:true` on a value the page does
  not hold.
- **Who owns the overclaim.** The tool was honest twice: the four-field passenger `fast_fill` returned
  `verified:false, filled:0, missed:4`, and the Berth pick errored. The gate refused once, at turn 17,
  listing five unretried failures, then accepted the reworded second report. The end-of-run visual note
  never wrote to the run row (the `visualNote` key is absent). The coordinator traced that to
  `runner.mjs`: an explicit failure is not counted as an unverified write, and the gate raises unretried
  failures only once per run. It is routed to the verify teammate, with this run
  (`run_id 2c97112a`) as the fixture.

### h2_slider: 3/5 (baseline 3/5)
- 17.6s (148.6s) · 6 calls (1001) · 0 errors (0). Claimed complete.
- **Not a fix win.** None of the five fixes touch sliders or keys; the baseline's 988 `fast_key_press`
  calls simply did not happen again. No claim-vs-live check was run on this cell.

### h2_tree: 1/5 (baseline 1/5)
- 29.2s (15.1s) · 17 calls (9) · 6 errors (4). Reported not-done, which is honest.
- Errors:
  - `fast_click {text:"Deliver reaching", role:"span"}`: role mismatch.
  - `fast_click {text:"Deliver reaching"}`: no element. The top-level row was below the virtualized
    fold, and the miss returned the new scroller hint.
  - `fast_scroll {selector:"#demo-tree"}` ×4, with no `pixels` and no `to`: refused each time with the
    same parameter error.
- The model acted on the scroller hint right away, but sent the scroll four times without its distance.
  The gap-3 miss hint works as a signal; `fast_scroll` rejecting a selector with no distance is what
  stopped the run (see findings).

### h2_autocomplete: 6/6 (baseline 6/6)
- 28.5s (13.6s) · 8 calls (7) · 2 errors (1). Claimed complete.
- Errors: `fast_click {text:"Manchester Piccadilly (MAN)", role:"option"}` found no element while the
  page was still settling, and a `fast_wait` on the same text timed out. The retry committed.
- No separate claim-vs-live check, but every data checkpoint reads the live hidden commit fields
  (`MAN` / `EUS`), and all six passed.

### h2_modal: 3/6 (baseline 3/6), OVERCLAIM, a false `verified:true`
- 36.6s (7.9s) · 7 calls (5) · 1 error (0).
- Error: `fast_click {text:"Open a Form nested Dialog", role:"button", index:1}` had index out of range.
  The retry with `index:0` opened the dialog.
- **Claim vs live.** Claimed: `Promotion name = "Spring Rail Sale", Zones = "Zone No.2" (dialog left open)`.
  Live: promo `Spring Rail Sale` and dialog open both match; **zone = `""`**.
- **Cause.** The model set both fields with one call:
  `fast_fill {fields:{"Promotion name":"Spring Rail Sale","Zones":"Zone No.2"}}`. It returned top-level
  `{"verified":true, "filled":2, "missed":0, "uncommitted":["Zones"]}`. The `{fields}` result computes
  `verified` from `missed` and reverted fields and ignores `uncommitted`, so a combobox value that was
  typed but never picked comes back green. This is the failure a green score hides. It is not caused by
  the gap-1 change: `fast_select_option` was never called in this cell. It is a pre-existing bug and is
  routed to the extension teammate as a priority fix.

## Not run
- **h2_infinite: no result.** The cell started at 18:58:33Z and was killed before it recorded a row.
- **h1 regression six: no result.** hvm nearly ran out of memory (146 MB free of 15 GB, swap full, on a
  box also running a production service). Every local-transport cell starts a `fast-dxt/server/index.js`
  child, and when `run.js` exits without closing it, that child is orphaned and never exits. 348 of
  them had accumulated, using 10.5 GB. The coordinator killed the orphans and the bench chain. The h1
  cells were killed as they started.
- The bench log does show h1 `ROW` lines, but they are **stale**: their timestamps (00:31–00:33Z) are the
  old reference rows, which the row printer fell back to when no new row landed. They must not be read
  as a regression result.
- These seven cells wait until hvm has the fix that makes the server exit when its parent goes away.

## Findings (not fixed here; `page.js` is scheduled for a prune)
1. **A shared aria-label breaks targeting by name.** Every Syncfusion EJ2 dropdown carries
   `aria-label="dropdownlist"`. The wizard's `fast_select_option {field:"dropdownlist", index:0}`
   resolved to the Gender widget (its field came back labelled `"Female"`), not Berth. This is not an
   EJ2 or Berth bug: any widget library that labels every instance the same way does this. It is the
   strongest single argument for the id-first targeting planned after the prune.
2. **A role passed by the model turns off the text fallback.** The gap-3 fallback runs only when no role
   is given, so `fast_click {text:"19004", role:"cell"}` (wizard) and `{text:"Deliver reaching",
   role:"span"}` (tree) errored on targets that the same call without the role reached first time.
3. **`fast_click`'s role filter does not know table/grid roles.** `"cell"` should match a `<td>` or
   `[role=gridcell]`.
4. **`fast_scroll {selector}` without a distance is refused.** It should default to one container
   screenful, the step the tree cell needed.
5. **`fast_fill {fields}` returns `verified:true` while a value is uncommitted** (h2_modal). The `{fields}`
   verdict must be false whenever `uncommitted` is non-empty. Routed as a priority fix.
6. **The visual note does not fire on an explicit write failure, and the gate raises unretried failures
   only once per run** (h2_wizard; `fast-runner/runner.mjs`). Routed to the verify teammate with
   `run_id 2c97112a` as the fixture.
