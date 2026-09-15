# Grok runner — HOLDOUT 2: six unseen sites, checkpoint validation (2026-09-15)

Holdout 2 = `bench/holdout2.js` (ids `h2_*`, `node bench/run.js --list --suite holdout2`): six
public sites that NO builder saw — not in suite.js, not in holdout 1, and not among the fixer's
proof sites for 9d18d4d / 8837e49 (GOV.UK, jQuery UI datepicker, Select2, Form.io, jsDelivr,
DataTables, Bootstrap btn-check, MUI Checkbox, SurveyJS, bootstrap-datepicker, Tom Select,
Choices.js). It measures whether generic tool fixes CARRY OVER. Owner's rule: *every website is
different — a fix has to work everywhere.* Nothing may be tuned against these sites.

**Baseline pending: xAI spending limit.** The account hit its limit at 21:43:35Z; a one-token
check through hvm's grokcode proxy after validation still returned
`personal-team-blocked:spending-limit`. No grok-4.3 / phase2 cell has run. When it is lifted, on hvm:
`source /home/dev/.config/fastrun/env; FASTRUN_MODEL=grok-4.3 node bench/run.js --client grok_runner --transport local --install primary --toolset phase2 --test h2_<id>`
(one cell per test, sequential).

## Sites

| id | family | site / URL | stack |
|---|---|---|---|
| h2_wizard | dependent multi-step wizard | Syncfusion Tab wizard — https://ej2.syncfusion.com/demos/tab/wizard/ | Syncfusion EJ2 (Tab, DropDownList, Grid, NumericTextBox) |
| h2_slider | slider + switch | Mantine Slider "Usage" configurator — https://mantine.dev/core/slider/ | React + Mantine |
| h2_tree | nested, collapsed, virtualized tree | Wunderbaum "Plain" demo — https://mar10.github.io/wunderbaum/demo/#demo-plain | Wunderbaum (100,812 nodes, virtual rows) |
| h2_autocomplete | live typeahead, commit required | National Rail live trains — https://www.nationalrail.co.uk/live-trains/ | Next.js, ARIA combobox + hidden commit fields |
| h2_modal | form in a modal opened by a button | Element Plus Dialog, "Customized Content" — https://element-plus.org/en-US/component/dialog.html | Vue 3 + Element Plus |
| h2_infinite | infinite scroll | itch.io browse grid (popular games) — https://itch.io/games | server-rendered grid, scroll-triggered page append |

## Checkpoint validation (METHOD RULE — both directions, by hand through the local FastLink tools)

hvm rig on 12b368c (origin/main, incl. 8837e49): Xvfb + Chrome for Testing + unpacked fast-ext +
local broker. Tools called in-process through `bench/fastlink.js` (`handleCall`, byte-identical to
MCP). Every page change went through a FastLink tool call; `fast_evaluate` only read coordinates or
counts. Untouched = fresh tab after the test's reset, scored with an empty report. Live
checkpoints in the by-hand column were scored against a report built from the live read.

| test | untouched | done by hand | how (tools) |
|---|---:|---:|---|
| h2_wizard | 1/8 | 8/8 | `fast_select_option` From / To / Ticket Type (each committed, each returned `verified:false`); `fast_click "Search Train"`; `fast_click "19002"` refused → `fast_click_xy` on the row; `fast_click "Continue"`; `fast_fill "Passenger Name" index 0` (verified); Age: `fast_click_xy` + `fast_type {clear}` + `fast_key Tab`; Gender / Berth: `fast_click_xy` on the widget + `fast_click {role:"option"}`; `fast_click "Continue"`. Train list was 19002/19007 at 35 seats each (tie → either counts). |
| h2_slider | 1/5 | 5/5 | `fast_click_xy` on the preview thumb, `fast_key ArrowRight` ×30 (40 → 70), `fast_click "Label always on"` (resolved via its label, `verified:true`). |
| h2_tree | 1/5 | 5/5 | `fast_scroll {selector:"#demo-tree", pixels:400}` ×38 until "Deliver reaching" rendered; `fast_click_xy` on the "Meaning is second-hand" expander, then on the "Causes" expander; `fast_click "Spots not provided"` → no element; `fast_click_xy` on the row's checkbox icon. |
| h2_autocomplete | 1/6 | 6/6 | `fast_click "Accept All"` (OneTrust); `fast_click_xy` on the origin box; `fast_type "Manchester Picc"`; `fast_click {text:"Manchester Piccadilly", role:"option"}` → hidden field `MAN`; same for "Euston" → `London Euston`, hidden `EUS`. Search not pressed. |
| h2_modal | 1/6 | 6/6 | `fast_click "Open a Form nested Dialog"`; `fast_fill "Promotion name"` (verified); `fast_select_option {field:"Zones", option:"Zone No.2"}` (committed, returned `verified:false, value:""`). |
| h2_infinite | 1/4 | 4/4 | `fast_scroll {to:"bottom"}` ×2 (36 → 72 → 108 cells); the 100th cell read "Digital Tamers 2" by dragonrod342 at the time. |

The one untouched pass per test is the `tab` checkpoint (as in suite.js / holdout 1).

## Reader / prompt fixes found by validation (before any baseline)

- **h2_slider:** the controls panel has its own 0–100 sliders (size md = 50, radius xl = 100), so
  "nearest 0–100 slider to the switch" read 50 on the untouched page. The preview is now the slider
  whose own track carries the 20 / 50 / 80 % marks. The code snippet ALWAYS prints `color="blue"`,
  so color counts as changed only when it is not blue.
- **h2_modal:** the Element Plus dialog is `position:fixed`, so `offsetParent` is always null and
  an open dialog read "closed". Open = has client rects and is not `visibility:hidden`.
- **h2_autocomplete:** the hidden commit field holds the station's CRS code; the checkpoints now
  require `MAN` / `EUS` exactly, not just non-empty.
- **h2_tree:** the "Causes" group under a failure is collapsed too (the source's type map says
  expanded; the rendered tree does not). The target sits under TWO collapsed nodes; the prompt
  now names both expansions.
- **h2_infinite — site replaced:** the first pick, DEV's all-time top feed (dev.to/top/infinity),
  never loads past its first 18 cards for a logged-out visitor: `fast_scroll` to bottom, trusted
  `fast_wheel`, `End` and up/down scrolling all left it at 18 with no page fetch. Logged-out
  Bluesky and mastodon.social feeds rendered no items on the rig. Discourse Meta top-all-time
  appended 50 rows per scroll (50 → 300 verified) but, after ~10 quick page loads from the rig,
  every load from hvm's IP became a network error (`chrome-error://`, three opens over ~2.5 min)
  while the same URL answered 200 from another network. A curl from hvm a few minutes later got
  200 again, so the block is temporary. It still rules the site out: a bench cell cannot risk
  landing inside that window. itch.io/games appends 36 cells per scroll (36 → 216 verified, unique ids); its
  popularity order drifts over hours, which the live-after-run read absorbs.

## Tool observations from the by-hand pass (generic; for the fixer, NOT site fixes)

1. **Custom-listbox read-back false negative.** `fast_select_option` committed the choice on four
   separate custom listboxes (three EJ2 DropDownLists, one Element Plus `el-select`) and returned
   `verified:false` every time (`value:""` on el-select). A model that obeys `verified:false`
   retries or reports failure on a correct pick; a model that ignores it learns to ignore it.
2. **Grid row misread as a suggestion.** `fast_click "19002"` on an EJ2 Grid row cell was refused
   as "suggestion … is on screen but the control did not accept a synthetic pick"; the hint's
   `fast_click_xy` worked. A selectable grid row is not an autocomplete suggestion.
3. **Virtualized tree rows are not click candidates.** `fast_click "Spots not provided"` found no
   element for a rendered Wunderbaum row (`span.wb-title` inside a draggable `span.wb-node`), and
   the row's checkbox is a bare `<i class="wb-checkbox">` with no role/label. Only coordinates reach
   it.
4. **`role:"option"` click hint is noise when the click committed.** Every committed
   `fast_click {role:"option"}` (EJ2, National Rail) came back with "use fast_select_option
   instead"; the pick had already landed.
5. **Focus after an overlay dismissal.** The first `fast_click_xy` on the National Rail origin box
   right after the consent banner closed left focus on `main-content`, and the following `fast_type`
   refused ("no editable element focused"). A second click focused it. Timing, but `fast_click_xy`
   does not report where focus ended up.
