# FastLink CHANGELOG

Running log of every deliberate change to FastLink, newest first. The point is to
**stop the fix→break→refix churn**: before touching something, skim this file to see
what a prior change already fixed, so we don't reintroduce a bug we already solved.

**Format for each entry**

```
## 2026-09-15 — runner local transport pins its profile; bench passes the observed install to it
- **What:** `fast-runner/fastlink-client.mjs` local branch calls `fast_profile {install: browser}` right after connect and throws if the pin errors; `bench/run.js` passes `install` as the runner's `browser` for local cells.
- **Why:** since 8498cbe the broker refuses unpinned calls when >1 profile is connected. The runner's local session never pinned, so on the owner's machine (primary + secondary connected) the multipage cell died in 3.6s on 3 consecutive "has not pinned one" errors. hvm has one slot, so its local runs never showed it.
- **Files:** `fast-runner/fastlink-client.mjs`, `bench/run.js`.
- **Watch out:** `--local` without `--browser` still works only when exactly one profile is connected; that is the broker's rule, not the runner's.
- **Status:** in code; verified by the multipage cell below.

## 2026-09-15 — status hint: delete the pre-pin-required fallback branch
- **What:** `statusReport` (fast-dxt/server/handlers.js) keeps only the `pinRequired` hint; the "calls default to <routedInstall>" branch and its `connectedSlots` recomputation are deleted.
- **Why:** that branch only fired against a broker older than 8498cbe. Both live brokers (WSL, hvm) now run pin-required code, so it was a dormant second source of truth that told the model calls would silently route.
- **Files:** `fast-dxt/server/handlers.js`.
- **Watch out:** an MCP server paired with a pre-8498cbe broker now shows no multi-profile hint at all; restart that broker.
- **Status:** in code / tests pass; takes effect when each MCP server restarts.

## YYYY-MM-DD — <short title>
- **What:** the change, in one or two lines.
- **Why:** the symptom / feedback that prompted it.
- **Files:** the files touched.
- **Watch out:** what this could regress / interacts with (so a future change doesn't undo it).
- **Status:** in code / synced to Windows copy / committed / verified live.
```

Extension changes only take effect after **commit + `bash scripts/ship-ext.sh`** (syncs HEAD's `fast-ext/` → `C:\Users\yjtur\FastLink\extension\`, stamps `build.json`, reloads the pinned profile via the broker, verifies the build in `fast_status`). Server changes need a Claude Code restart (WSL MCP) or `.mcpb` rebuild (Desktop). Relay changes need `wrangler deploy`.

---

## 2026-09-23 — fast_evaluate on CSP pages: self-heal a stale debugger session, report the real cause (v0.4.6)
- **What:** `ensureAttached` (input.js): when `chrome.debugger.attach` throws "already attached", detach (succeeds only on a session this extension owns) and re-attach; if detach fails, throw `debugger_busy` ("DevTools or another extension is attached"). `cdp()` re-attaches once and resends on "not attached". `evaluate.js` keeps the CDP failure reason and, when the in-page fallback is blocked by CSP `unsafe-eval`, returns both instead of the bare CSP message.
- **Why:** the father's WhatsApp automation: after all his installs dropped (1006) at 1:55pm, every `fast_evaluate` on web.whatsapp.com failed with the CSP `unsafe-eval` error. `evaluateViaCDP` swallowed ANY CDP error and fell back to `(0,eval)` in the page, which WhatsApp's CSP forbids, so the CSP message masked the real failure. The `attached` Set lives in the service worker and the session lives in the browser: a respawned worker starts empty while the old session is still on the tab, so attach() threw on every call until the tab closed. The code was unchanged since 0.4.3, so the 0.4.5 update (see below) did not introduce it; the drop/respawn exposed it.
- **Files:** `fast-ext/src/actions/input.js`, `fast-ext/src/actions/evaluate.js`, `fast-ext/manifest.json`, `release/updates.xml`.
- **Watch out:** never swallow a CDP error on its way to the eval fallback again. `debugger_busy` means someone else really is attached; do not force-detach it. The self-update work (30-min check + reload when idle) is parked on branch `hold/auto-update-0.4.6` and is NOT in this release.
- **Status:** committed; released as ext-v0.4.6; see the commit for live verification.

## 2026-09-23 — release channel restored: the father's laptop auto-updates again (v0.4.5)
- **What:** `release/` is back: `updates.xml` (version 0.4.5, codebase = GitHub Release asset `ext-v0.4.5/fastlink-0.4.5.crx` on Muzhik613/fastlink), `build-crx.sh` (now packs the COMMITTED `fast-ext/` via git archive and also emits a load-unpacked zip) and `README.md`. `fast-ext/manifest.json` has `update_url` again and is at 0.4.5.
- **Why:** the father's laptop (Alex, corporate-managed, per the 2026-07-12 entry) force-installs the signed .crx from `raw.githubusercontent.com/Turetsky/fastlink/main/release/updates.xml`. The 2026-09-16 prune (04dd486) deleted that file on the premise "nothing installs from a release", so the URL 404'd and the laptop silently stayed on 0.4.3. It needed `fast_switch focus:false` (below) remotely.
- **Files:** `release/*`, `fast-ext/manifest.json`, `CLAUDE.md` (section 6).
- **Watch out:** the URL path keeps `Turetsky/fastlink` because installed copies carry it; GitHub serves the renamed repo under it. Never delete `release/` again; every extension release must also bump `updates.xml` + upload the .crx. The updateCheck.js self-reload client stays deleted: Chrome's own updater is the only puller.
- **Status:** committed / pushed / released; live URLs verified (see commit).

## 2026-09-23 — fast_switch focus:false targets a tab without raising Chrome
- **What:** `fast_switch` takes `focus:false`: it pins the tab and returns (`focused:false`) without `chrome.tabs.update({active})` or `chrome.windows.update({focused})`. Default (omitted/true) is unchanged. Schema added in `fast-dxt/server/tools.js` and mirrored in `fastlink-relay/tools.js`.
- **Why:** the owner's father's script reads WhatsApp Web through FastLink and every read pulled Chrome to the front. The only focus-raiser on that path was `switchTab` itself; reads never needed focus (they route by the pin, `requestAnimationFrame` waits are already capped for background tabs, and a screenshot of a pinned background tab goes through CDP).
- **Files:** `fast-ext/src/actions/tab.js`, `fast-dxt/server/tools.js`, `fastlink-relay/tools.js`.
- **Watch out:** with focus:false the tab stays a background tab: Chrome throttles its timers, so a page that renders lazily on visibility may show stale content. Do not add focus calls to read paths; the pin is the routing.
- **Status:** committed; shipped via ship-ext.sh; verified live (see commit). Relay not redeployed.

## 2026-09-16 — visual check at the write: a fast checker, in parallel with the next turn, replaces the end-of-run note
- **What:** A write nothing could read back now starts a visual check *the moment it returns*. The check takes one screenshot and asks a fresh `grok-4.20-0309-non-reasoning` conversation about it, running in parallel with the model's next turn. The observations are appended to the next tool result. The end-of-run `visualNoteRound` (fresh grok-4.6, one per run, at report_done) is deleted. So are `ensureVisionEnv` and the Gemini note path. The checker prompt moved into `fast-runner/visual-check.mjs`, so the dead `fast-dxt/server/scout.js` and its `describe-screen` test are deleted too. The checker gets the image plus what the write aimed at, never the task text, and is asked where each target appears and to quote the whole box. A check still owed at report_done goes out in the same round as the gate's problems. Delivered observations join the evidence corpus and mark the write `seen`: the gate counts that as a read-back and stops calling the unread write a failure. Row field is `visualChecks[]` (was `visualNote`).
- **Why:** Live Azure run 5f06a066 (grok-4.3 driver, 115.8s): model 28.6s over 13 turns, tools 30.6s (20.6s of it one `fast_wait` timeout on text inside the frame), end-of-run checker **56.5s**, ~0 idle. The corrupting fill returned at 42.0s. The checker reported it at 103.5s, and the gate's own problems followed at 109s and 112s: two more refused rounds (~5.4s) plus a snapshot round (~3.9s).
  Replay of 11 saved/rendered screenshots (3 Azure; 8 non-Azure forms with known defects: stepper marks, error banners, toasts, a dialog, a value typed into the wrong box, a placeholder left in a custom select, an amber hint), 2-3 reps. "Recall" = known defects the checker reported; "false confirm" = saying a box holds a value it does not:
  grok-4.6 + task text: recall 95%, false confirm 0/10, median **34.7s**, p90 51.8s.
  grok-4.3 + task text: recall 93%, 0/10, median 7.3s.
  grok-4.20-nr + task text: recall 83%, **2/15 false confirm** ("Employee ID reads EMP-40981" while the box was empty; it read the task, not the screen).
  grok-4.20-nr, no task, targets as labels ("where does it appear, quote the whole box"): recall **95%**, false confirm **0/15**, tab/step marks 12/12, median **1.8s**, p90 2.6s.
  Rejected: diff-crops of changed regions (recall 72-91%). A write that never landed changes nothing, and a mark already on screen is not in the diff. Also rejected: 1024px JPEG (no latency gain, false confirms up to 6/15).
  Timeline replay of the Azure write through the new wiring (real checker, the run's measured turn/tool times, 8x): note delivered median **2.5s after the write**, adding median 0.65s (max 0.94s) to the next turn. It caught the corrupt name box 8/8, the Basics red mark 8/8 and the red message 7/8, with 1/8 a wrong "Subscription reads empty".
- **Files:** `fast-runner/visual-check.mjs` (new), `fast-runner/runner.mjs`, `fast-runner/test/visual-check.test.mjs` (replaces `visual-note.test.mjs`), `fast-runner/README.md`; deleted `fast-dxt/server/scout.js`, `fast-dxt/test/describe-screen.test.mjs`.
- **Watch out:** The screenshot is taken right after the write returns. A validation message that renders later than that is not in it (unmeasured live). The 4.20 checker still misses tiny marks sometimes (a 6px nav dot 2/3). Never give it the task text again: that is what made it confirm values that were not there. `seen` satisfies the gate's read-after-action rule for that write only.
- **Status:** committed; suites green (fast-runner 106/106, fast-dxt 7/7). Not yet verified on a live run.

## 2026-09-16 — every runner run is screen-recorded as <run_id>.mkv, verified, and saved on its row
- **What:** `scripts/record.sh` (start/stop/status NAME) is the one recorder. On WSL it runs Windows ffmpeg gdigrab on Chrome's monitor, in physical pixels; if Chrome straddles monitors or is missing, it records the whole virtual desktop. On Linux (the hvm rig, :98) it runs ffmpeg x11grab of `$DISPLAY`. It always crops to even dimensions, runs detached with a FIFO stdin, stops gracefully with 'q' and forces only after a timeout, and has a `-t` hard cap. `stop` fails loudly unless the file is non-empty and ffprobe reports duration > 0. Retention: newest 50, none older than 14 days. `runTask` starts recording alongside the connect. `finish()` (every exit path) stops and verifies it before writing the runs.jsonl row, so the row and the caller's result carry `video`. `cli.mjs` routes SIGTERM/SIGINT through `cancelAll()` so bench-killed runs still finalize. `fast-runner/recorder.mjs` never throws: a broken recorder yields `video.recorded:false` + error, and the run proceeds. **The only switch:** `FASTRUN_RECORD=off` (default on) skips recording and the row says `video: {recorded:false, reason:"disabled"}`; it exists for same-commit overhead A/Bs on the rig (`fast-runner/test/recorder.test.mjs`).
- **Why:** a live Azure run's recording, azure-run.mkv, was 0 bytes. A bare `-i desktop` over three monitors was 5840x2029, an odd height libx264 refuses, so ffmpeg exited in 0.12s after only creating the file. Neither the launching shell exiting nor Stop-Process -Force was the cause (both reproduced and ruled out). Monitor facts: primary is 2880x1800 physical (1440x900 is logical only), three monitors.
- **Files:** `scripts/record.sh`, `fast-runner/recorder.mjs`, `fast-runner/runner.mjs`, `fast-runner/cli.mjs`, `fast-runner/test/recorder.test.mjs`.
- **Watch out:** .mkv only (an mp4 killed mid-write is unplayable). Never capture with PowerShell (AMSI blocks it); PowerShell only reads window rects. `finish()` is now async: waiters are notified after the recording stops (~1s). Local runs launched from a terminal always warn "Chrome is not the foreground window"; that is accurate but not proof of occlusion.
- **Known gap:** if the fastrun MCP server (`caller-mcp.mjs`) dies mid-run, the recording runs to its hard cap (run maxWallMs + 300s) and no row is written. The same goes for a runner killed with SIGKILL.
- **Status:** committed (464e0fd, 20f671f); verified locally (run cc7cf461, and fdca583a killed by SIGTERM) and on hvm from a temp copy (5e0f7bfa). The hvm checkout is NOT updated (rig off-limits); recording overhead on bench timing is not yet measured.

## 2026-09-16 — a click that already picked an option does not tell you to use fast_select_option
- **What:** `fast_click` attaches the "this is a select control; use fast_select_option instead" redirect
  only when the clicked element is NOT an entry of an open list (`[role=option|menuitem|menuitemradio|
  menuitemcheckbox|treeitem]`, or a descendant of one).
- **Why:** holdout-2 by-hand pass: every committed `fast_click {role:"option"}` (Syncfusion EJ2, National
  Rail) came back with "use fast_select_option instead" — a redirect for a click that had ALREADY made the
  pick. The hint is for a click on a dropdown's TRIGGER, where clicking only opens the list.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** the trigger case is unchanged — clicking a combobox/native select still gets the redirect
  with `selectField`. Only the option row loses it.
- **Status:** committed; proven live on two sites with open ARIA listboxes.

## 2026-09-16 — a row you can READ is a row you can CLICK: plain text targets, container narrowing, and a named virtualized scroller
- **What:** four rules in `fast_click`, all generic. (1) The last-resort target (`pointerTargetByText` →
  `textTargetByText`) no longer requires `cursor:pointer`: the SMALLEST visible element whose own text /
  aria-label / title / alt IS the query is clicked with the full pointer sequence (`via:"text"`); a
  pointer-cursor target still wins when one exists (`via:"pointer-cursor"`). (2) A match that is a
  CONTAINER — its own text does not carry the query, it merely contains a row that does — is narrowed to
  the smallest visible descendant whose own text does (`via:"text-leaf"`); real controls are never narrowed,
  so `<button><span>Save</span></button>` keeps the button's own activation. (3) `pointerContent`'s
  "this text belongs to a control" test uses a REAL-control selector instead of `SELECTOR`, whose
  `[tabindex]:not([tabindex="-1"])` arm let one focusable host swallow every row inside it. (4) A 0-match
  miss names the scroll containers that hold far more content than they show (`scrollers` + a `hint`),
  because in a virtualized view the row is not in the DOM until that container is scrolled.
- **Why:** holdout-2 by-hand pass: Wunderbaum rows and Syncfusion grid rows "cannot be found by text at all;
  only coordinates reach them". Live on the rig, `fast_click` on a rendered Wunderbaum row clicked the whole
  1270×635 tree host (the row text is only INSIDE it), and a DataTables cell missed outright — both are
  `cursor:auto`, role-less, ARIA-less text inside a `tabindex=0` host.
- **Files:** `fast-ext/src/actions/page.js`, `fast-dxt/server/tools.js`, `fastlink-relay/tools.js`.
- **Watch out:** (2) changes WHICH element receives the click on container matches — the guard that keeps
  real controls out of it is what stops a narrowed click from silently skipping a form submit. (1) can now
  "click" a plain text node's element that does nothing; the result says `via:"text"` and still reports
  url/dialog/focus so nothing is claimed for it. NOT solved, and not solvable generically here: bringing a
  row that has never been rendered into the DOM (a 100k-node virtual tree) — the tool names the scroller and
  the caller scrolls; and an icon-only checkbox (`<i class="wb-checkbox">`: no role, no label, no text)
  cannot be addressed by text at all — coordinates or vision remain the honest answer there.
- **Status:** committed; proven live on Syncfusion EJ2 + Wunderbaum (holdout-2) and DataTables (outside it).

## 2026-09-16 — only a typeahead's own popup is a "suggestion": a selectable grid row is not one
- **What:** `suggestionByText` (the path `fast_click` takes when the text is not an indexed control) now
  requires the FOCUSED element to be an autocomplete (`isAutocomplete`: a typeable control that is an ARIA
  combobox / declares aria-autocomplete / names a popup). Anything else focused — a `[role=tab]`, a
  disclosure button — no longer turns the rows of the panel it names into suggestions.
- **Why:** holdout-2 by-hand pass: `fast_click "19002"` on a Syncfusion EJ2 grid row was refused as
  "suggestion … is on screen but the control did not accept a synthetic pick". Live on the rig: after
  "Search Train", focus sat on the `[role=tab]` "Train List", whose `aria-controls` panel is the whole step
  — including the train grid's `[role=row]`s, which `panelOptions` counts as option rows. The refusal named
  a coordinate click as the only way out, for a row an ordinary click selects.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** real typeaheads are unaffected (Google Maps, National Rail: their focused control IS the
  combobox input). If a site ever focuses a non-input element that legitimately owns a suggestion list, it
  now falls through to the ordinary click path — which, since the same day's text-target fix, reaches the
  row anyway.
- **Status:** committed; proven live on Syncfusion EJ2 (holdout-2) and on a grid outside the holdout set.

## 2026-09-16 — a committed pick on a custom listbox reads back as committed (no more false `verified:false`)
- **What:** two rules in the shown-value read-back (`fast-ext/src/actions/page.js`). (1) `shownValueOf`'s
  walk skips a descendant only when it is an OPEN popup (`aria-expanded="true"`), not merely because it
  CARRIES the attribute, and never counts a `<label>` inside the widget as the value. (2) `hiddenInputBox`
  returns the innermost VISIBLE ancestor that actually SHOWS something instead of the first sized one — an
  INVISIBLE sleeve is skipped and the climb continues (a widget hides its typing input once it displays a
  value), and the climb stops only at an ancestor holding another form control.
- **Why:** holdout-2 by-hand pass: `fast_select_option` committed the choice on four custom listboxes and
  returned `verified:false` every time. Live on the rig: Syncfusion EJ2 read back `"From"` (its float LABEL
  sits in the same wrapper as the readonly input that shows `"Chicago"`, which was skipped for carrying
  `aria-expanded="false"`), and Element Plus read back `""` (its combobox input sits in a sleeve the widget
  makes invisible once a value is shown, with the chosen label in a sibling span one level up — the climb
  treated "invisible" as the end of the widget). A model that obeys `verified:false` retries a correct
  pick, or learns to ignore the flag.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** `shownValueOf` is also the read-back for the click-ambiguity `candidates` list, so a widget
  that renders its VALUE inside a `<label>` would now read empty — none seen; every widget checked draws the
  value in a span/input and the `<label>` is the field name. Keep the popup skip keyed on `"true"`: going
  back to `hasAttribute` re-breaks all four.
- **Status:** committed; proven live on Syncfusion EJ2 + Element Plus (holdout-2) and on sites outside it.

## 2026-09-16 — `fast_click_xy` says where focus landed
- **What:** every `fast_click_xy` return now carries `focused` {tag, type, label, editable} — the field's
  live `value` too when it is editable — read with the SAME probe `fast_type`'s guard uses, plus a `hint`
  naming what holds focus when nothing editable does. Best-effort: a navigating click that tears the frame
  down mid-probe simply reports no focus.
- **Why:** holdout-2 by-hand pass (National Rail): the first `fast_click_xy` on the origin combobox right
  after the consent banner closed left focus on the page's `main-content` wrapper, and the `fast_type` after
  it was refused — with no way to have seen it coming, because the click reported only its own coordinates.
  A second click focused the box.
- **Files:** `fast-ext/src/actions/input.js`, `fast-dxt/server/tools.js`, `fastlink-relay/tools.js`.
- **Watch out:** the probe costs one MAIN-world injection per coordinate click (~10ms) and runs on the
  internal `fast_click_xy` calls inside `fast_fill_vision` / `fast_do` too; they ignore the extra fields.
  The two `tools.js` copies must stay byte-identical.
- **Status:** committed; proven live on the hvm rig (see below).

## 2026-09-16 — the visual note's checker is a FRESH grok-4.6 conversation given the goal, and an unread write is found by WALKING the result
- **What:** two changes. (1) **The checker changes model and shape.** At `report_done` the one screenshot now
  goes to a **brand-new `grok-4.6` conversation** through the grokcode proxy the run already drives on
  (`createMessage` takes a per-call `model`; no second client, no second key). It is handed the **task text**
  and the image and nothing else — no plan, no history, no claimed results, no tool vocabulary
  (`observationPrompt` strips every `fast_*` token out of the task text). The model is configurable —
  `FASTRUN_NOTE_MODEL`, default `grok-4.6`, `gemini` keeps the old vision tier — because same-model checking
  shares blind spots and we want to A/B it. The run row records `checker` and `checkerMs`. (2) **The detector
  stops matching shapes.** `partialFailures` now WALKS the result for any node saying its value was not read
  back (`verified:false`, an `unverified` marker, an `unreadable`/`cross-origin` reason) and reports it at the
  deepest node that names a target; a wrapper over a bag of per-field/per-step/per-action results is never the
  report. Bags are recognised structurally (an array of objects, or a map of objects), so a shape we have not
  seen behaves correctly.
- **Why:** (1) a fresh instance cannot be anchored by the reasoning that produced the mistake, and describing
  is the only thing it can do — the note is dumb BY CONSTRUCTION instead of by our restraint. The intent is
  what makes the observations useful: "the boxes the goal names read empty" instead of "some boxes look empty".
  It also **unblocks the relay transport**: the note no longer needs a `GEMINI_API_KEY` in the runner's
  process, which was the one thing keeping it Gemini-only there (that key lives in the Worker). (2) live on
  Azure (04ca273) Grok used `fast_do`, whose unread write sat in `executed[]` one level below anything the
  per-tool matching inspected: `unverifiedWrites` returned empty and the row recorded `visualNote:null`. That
  was the THIRD distinct reason the note had not fired on a real page (no key → budget spent → detector blind
  spot), so the fixtures now include that exact payload, a nested `fast_batch` step, and a test asserting that
  a `verified:false` ANYWHERE produces a note.
- **Files:** `fast-runner/runner.mjs`, `fast-runner/xai.mjs`, `fast-dxt/server/scout.js`,
  `fast-runner/test/visual-note.test.mjs`, `fast-dxt/test/describe-screen.test.mjs`, `fast-runner/README.md`.
- **Watch out:** the checker is SLOW next to the vision tier — measured on the same screenshot: grok-4.6
  ~27–52s, grok-4.3 ~8s, Gemini Flash-Lite ~1.2s. It only runs on a report whose write went unread, so it is
  off on every clean run, but a run that trips it pays half a minute. If that matters more than the fresh-eyes
  property, `FASTRUN_NOTE_MODEL=grok-4.3` is the cheap A/B and `gemini` is the old path. Also: the walk's
  suppression rule is what keeps a fill's wrapper from being reported as one nameless entry — the gate's
  `check 3` and the h_repeat replay both fail if it goes wrong (they did, mid-change).
- **Status:** committed; `fast-runner` 85/85, `fast-dxt` 12/12. Checker verified live against grok-4.6 through
  the proxy (routing proof: requested `grok-4.6` while `FASTRUN_MODEL=grok-4.3`, answered by `grok-4.6`), with
  real observation lists from public forms rendered on the hvm rig.

## 2026-09-16 — the visual note gets an observation BUDGET, keeps the claimed values at the front, and stays in register
- **What:** four changes to `describeScreen` (`fast-dxt/server/scout.js`), on top of 076e0a6's "describe every
  empty box". (1) A **budget**: at most 8 observations, asked for in the prompt (with "name the ones nearest
  the top and say how many others look empty") and enforced in the parse — it was 12, unasked-for and
  unbounded in the prompt. (2) The claimed values (d) are now reported **FIRST, before (a)/(b)/(c)**, so the
  one field the run actually wrote can never be crowded off a wide-open form by boxes it never touched.
  (3) The (a)/(b) wording names what it is looking at: a greyed `"Select..."/"Choose..."` word sitting in a
  blank box, and a message under a box or a banner across the top alongside the dots/outlines/tab marks.
  (4) A **mechanical register filter** drops any single observation that names one of our tools
  (`fast_*`), opens with an instruction ("Click the Region box…", "You should…") or pronounces a verdict
  ("is incomplete", "must be"). It can only REMOVE a line — it never rewords, never adds, never interprets.
  `describeScreen` takes an injectable `deps.call`, so the prompt/parse path unit-tests with no key,
  no image and no network.
- **Why:** the note's whole value is that it is handed straight to the model, so it has to be short and it
  has to stay an observation. The prompt forbade advice and verdicts but nothing enforced it, and a
  12-line answer on a form like Azure's Basics tab is mostly boxes the run never claimed. Nothing had ever
  exercised the real prompt/parse either — every existing test injects `deps.describe` past it.
- **Files:** `fast-dxt/server/scout.js`, `fast-dxt/test/describe-screen.test.mjs` (new).
- **Watch out:** the filter is deliberately dumb and can only remove; if it ever starts rewording a line,
  that is the gate rebuilding the model's judgement again. The 8-line budget is a real trade: on the
  rendered Azure-shaped fixture the claimed value, four empty/placeholder boxes, the red outline, the red
  banner and the below-the-fold line filled the list, and the red dot on the Basics tab fell off the end.
  Raising the cap buys coverage and costs the model's context.
- **Status:** committed; `fast-dxt` describe-screen 5/5, `fast-runner` 79/79. Live on hvm-rendered
  screenshots (selenium web-form, demoqa practice form, an Azure-shaped fixture) — observations in the
  session report. The Azure page itself is the lead's to re-run.

## 2026-09-16 — the visual note gets its OWN round (before the gate), and the gate stops refusing honest wording
- **What:** three changes to the report_done path. (1) `reportDecision` runs the visual note FIRST and
  outside the gate's refusal budget — `REPORT_INTERRUPT_CEILING` is deleted; it is one note round PLUS up
  to `MAX_GATE_REFUSALS`, not N shared. (2) `claimMismatch` credits the run's first `fast_tab`/`fast_nav`
  for an open/navigate claim unless the clause names some OTHER target — a URL no load fetched, or a
  QUOTED entity the loaded URL does not name; a clause naming the call itself ("fast_tab succeeded")
  counts too. (3) `describeScreen` now asks for EVERY empty/placeholder box with its label (required
  markers included) and for marks on tabs/step names, not just the values the model claimed.
- **Why:** live on the owner's Chrome (6ff5592, Azure create-VM): the gate refused twice on WORDING —
  all three of the model's `result` texts said the same true thing ("filled only the VM name, unverified,
  cross-origin iframe") — and the shared budget was gone by the time the note's turn came, so the ONE
  check that could have seen the empty Subscription / Resource group / Region fields and Azure's red dot
  never ran. A cheap, pedantic check was crowding out the only one with eyes.
- **Files:** `fast-runner/runner.mjs`, `fast-dxt/server/scout.js`, `fast-runner/README.md`,
  `fast-runner/test/visual-note.test.mjs`, `fast-runner/test/gate.test.mjs`.
- **Watch out:** (2) is a DELIBERATE loosening — an unquoted, URL-less "opened/navigated" claim is now
  satisfied by the run's own first load, so the cfworkers-class catch now rests on the quoted entity
  ('Worker "fastlink-relay" opened' with only the list page loaded is still refused) and on a named URL
  that was never fetched. Both are fixtures. If someone tightens this again, re-read the three Azure
  strings first: refusing them bought nothing and cost the note its round.
- **Status:** committed; `fast-runner` suite green. The Azure case itself is the lead's to re-run.

## 2026-09-16 — visual note: the vision key comes from where the MCP server gets it (~/.claude.json), not from the runner's env
- **What:** `ensureVisionEnv()` resolves `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` from
  `claudeMcpEnv('fastlink')` — now exported from `fast-runner/fastlink-client.mjs`, the one place that
  knows where those keys live — and applies them BEFORE the dynamic `import('../fast-dxt/server/scout.js')`,
  because `config.js` reads `process.env` at module load. A genuine miss now says which key is missing
  (`no vision: GEMINI_API_KEY is set neither in this process nor in ~/.claude.json mcpServers.fastlink.env`).
- **Why:** live on the owner's Chrome (a45d333) the note skipped with `"no vision"` in a run where vision
  had just worked TWICE on that same page (`fast_scout` 5.1s, `fast_fill_vision` 2.6s). Cause: vision in a
  run happens inside the MCP server the runner spawns, which inherits the key from
  `~/.claude.json mcpServers.fastlink.env`; the note runs vision in the RUNNER's own process, which has no
  such key. The unit tests injected `deps.describe`, so the real key path was never exercised.
- **Files:** `fast-runner/runner.mjs`, `fast-runner/fastlink-client.mjs`, `fast-runner/test/visual-note.test.mjs`.
- **Watch out:** the env must be applied BEFORE scout.js is imported or the key is invisible to `config.js`
  — keep `ensureVisionEnv()` on the line above the import. Three tests now cover the REAL wiring (a temp
  `$HOME` holding a `.claude.json`), not just the injected seam; a regression to "read only process.env"
  fails them. Still open: over the RELAY transport the vision key lives in the Worker, so a relay run with
  no local key skips the note — the note's prompt has to stay ours (a server tool like `fast_scout`
  classifies widgets, which is exactly what the note must never do), so closing that needs an internal
  server-side observe tool the lead can deploy.
- **Status:** committed; `fast-runner` suite green.

## 2026-09-16 — fast-runner: an end-of-run VISUAL NOTE when a write was never read back (and it stays dumb)
- **What:** at `report_done`, if `unverifiedWrites(toolLog)` is non-empty (a result that said
  `verified:false`, or a forced `fast_type` whose bypassed guard IS the missing read-back), the runner
  takes **one** screenshot, asks the vision tier (`describeScreen` in `fast-dxt/server/scout.js` — the
  same Gemini plumbing `fast_point` uses, no new dependency) what is ON the screen, and hands Grok the
  observations plus an invitation: "anything you want to fix, or is that expected?". Acting on it and
  explaining why the screen is expected are BOTH accepted; the next `report_done` goes through either
  way. ONE round per run, and never more than `REPORT_INTERRUPT_CEILING` = 2 report_done interruptions
  counting gate refusals (two refusals already spend it). Every outcome is on the run row:
  `visualNote:{observations, unverified, model_response, actedAfter}` or
  `visualNote:{skipped:"no vision"|"no screenshot"|"nothing observed"|"interruption budget …"}`.
- **Why:** Azure's create-VM blade is a CROSS-ORIGIN iframe, so no tool we have can read a value back
  out of it. The run typed into it with `force:true` and reported `set VM name="fastlink-bench-vm"`;
  two screenshots show the whole page selected blue and the field empty. The evidence gate had nothing
  to catch — every check it runs is about tool results, and the tool result looked clean.
- **Files:** `fast-runner/runner.mjs`, `fast-dxt/server/scout.js`, `fast-runner/README.md`,
  `fast-runner/test/visual-note.test.mjs`.
- **Watch out:** the note MUST stay dumb — it states what is visible and never classifies a widget,
  names a tool, diagnoses a cause or issues a verdict (a test asserts the wrapper text carries none of
  that). Rebuilding the model's judgement in the gate is what produced the bugs this exists to catch.
  It is also not free: one screenshot + one vision call on runs that trigger it, which is why nothing
  triggers when every write read back, and why `actedAfter` is recorded — if the notes never change
  anything, delete this.
- **Status:** committed; `fast-runner` 74/74 (18 new). Six-cell hvm bench: see below.

## 2026-09-16 — a write that cannot be read back says so: `verified:false` + a machine-readable reason
- **What:** `fast_type` now ends every call with its own read-back — `verified:true` with
  `typedInto:{tag,type,label,value}`, or `verified:false` with `reason` ("cross-origin: value not
  readable", "unreadable: …", or what the field reads instead). The probe follows SAME-ORIGIN iframes
  down to the real focused element (those stay verifiable) and stops at a cross-origin one, which it
  names by host. A fill whose field is no longer in the page, and a `fast_select_option` whose control
  was torn down, now say `unreadable: …` instead of comparing against an empty read.
  `fast_fill_vision` and `fast_do` take `fast_type`'s verdict instead of hardcoding one. The old
  `into:{…}` echo is REPLACED by `typedInto` (nothing else consumed it).
- **Why:** the forced write into Azure's cross-origin blade returned `{typed, cleared, forced, into}`
  with no hint that nothing had confirmed it, so both Grok and the gate read it as a success.
- **Files:** `fast-ext/src/actions/input.js`, `fast-ext/src/actions/page.js`,
  `fast-dxt/server/handlers.js`, `fast-dxt/server/tools.js`, `fastlink-relay/tools.js`,
  `fast-runner/runner.mjs`, `fast-runner/test/type-guard.test.mjs`.
- **Watch out:** `fast_type` joined `VERIFYING_WRITES` in the runner gate, so a `verified:true` type is
  now its own read-after-action (same rule as fill/select), and a `verified:false` one is an unretried
  failed action. The two `tools.js` copies must stay byte-identical (checked: 3371 chars each).
- **Status:** committed; unit-tested (`type-guard.test.mjs`). The Azure cross-origin case itself can
  only be proven in the owner's Chrome — left to the lead.

## 2026-09-16 — `clear:true` never select-alls the PAGE: it is refused unless an editable field has focus
- **What:** `fast_type {clear:true}` runs its select-all ONLY inside a focused editable element. With
  the document, `<body>` or a cross-origin `<iframe>` focused it refuses — nothing typed, nothing
  selected — returning `code:"clear_without_editable_focus"`, `focused:{…}` naming what had focus, and
  a hint that a triple-click (`fast_click_xy {clickCount:3}`) selects only that field's own contents.
  `force:true` does NOT buy past this: force bypasses the *typing* guard, not the select-all.
- **Why:** THE BUG. On Azure, `fast_type {clear:true, force:true}` sent Ctrl+A to a document whose
  activeElement was the cross-origin blade `<iframe>`, so the browser selected the entire page (two
  screenshots show it blue) and the VM-name field was never touched.
- **Files:** `fast-ext/src/actions/input.js`, `fast-dxt/server/tools.js`, `fastlink-relay/tools.js`.
- **Watch out:** clearing a pre-filled value inside a cross-origin iframe now REQUIRES the triple-click
  route (which is what `fast_fill_vision` already does, and why it never had this bug). If a future
  change re-allows an unfocused select-all "just for force mode", this bug is back.
- **Status:** committed; unit-tested (the Azure sequence is a test case).

## 2026-09-16 — walkDeep guards: iterative (never RangeError), budgeted, and a miss says the page was too big to scan
- **What:** `walkDeep` walks a root QUEUE instead of recursing, so frame/shadow nesting can never
  blow the JS stack. It carries budgets — `WALK_MAX_NODES` 300000, `WALK_MAX_ROOTS` 4000,
  `WALK_MAX_MS` 600 — checked both between roots AND after counting each root's nodes, and returns
  `{roots, nodes, ms, truncated}`. A `fast_select_option` miss whose scan was truncated now carries
  a structured `scan` block plus a hint naming what to do instead (an id from `fast_snapshot`,
  `section:"<heading>"`, or `index:N`).
- **Why:** GCP's create-client page is 9,995,921 composed nodes across 47,646 roots behind 38,116
  same-origin iframes. Two distinct failure modes, not one: the settled page made a plain recursive
  composed-tree walk throw **RangeError: Maximum call stack size exceeded** (it CRASHED, it did not
  merely hang), and walking it to completion cost ~45s that the caller only ever saw as the bridge's
  "page busy" 20s timeout with no explanation of why.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** the in-root budget check matters as much as the between-roots one — with only the
  latter, a SINGLE enormous root (one 400k-node document) is walked to completion and the guard
  never fires. That was a real gap in the first version of this change, caught by testing a
  single-root 400k tree; keep both checks. A legitimately huge page can now return a truncated scan
  rather than a match, which is the intended trade: a structured miss beats a 45s hang.
- **Status:** committed; fast-runner 56/56. Proven both ways: at 20,000 nested roots the recursive
  walker throws after 9,356 roots while the queue walk completes 20,001 roots / 40,014 nodes in
  **21ms**; a 400k-node single root now aborts in **106ms** with
  `scan:{truncated:"more than 300000 composed nodes", rootsScanned:1, nodesScanned:400008}`.
  Normal pages unchanged (selenium, APG, select2 `index:0`, react-select refusal, nested-iframe
  page byte-identical, gcpscale2 candidate parity 5001). Live-verified too: shipped to the owner's
  Chrome and the full GCP `gcpform` cell ran **6/6 in 27.1s over 9 calls** on stock timeouts, so the
  guards cost nothing on the page that motivated them.

## 2026-09-16 — walkDeep: the per-iframe forced layout is opt-in, and a root is never walked twice
- **What:** `walkDeep(root, sel, visit, opts)` computes the iframe offset passed to `visit` only when
  a caller asks (`{offsets:true}`), and carries a `seen` Set so a root reachable by more than one
  path is walked once.
- **Why:** it called `getBoundingClientRect()` on EVERY same-origin iframe before recursing — a
  forced synchronous layout each time — while no caller reads `ox`/`oy`/`inFrame` (checked all six
  call sites, including both multi-line `diagnose` callbacks; `queryAllDeep`, which `findFields`
  uses, discards the offset outright). On a 600-iframe page the walk measured **98ms with the rect
  vs 6ms without**. The `seen` Set is defensive: an audit on nested iframes + shadow roots showed
  rootVisits 51 / distinctRoots 51 / duplicateVisits 0, so nothing re-walks today, but nothing
  stopped it either.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** any future caller that needs frame-relative coordinates must pass
  `{offsets:true}` or it will get `ox/oy = 0` inside frames. `offsetFor()` is unrelated and still
  computes real coordinates for the snapshot path.
- **Status:** committed; fast-runner 56/56. 600-iframe repro: warm call **202ms → 48ms** (4.2×).
  Behaviour identical — a nested-iframe page returns a byte-identical result before and after, and
  gcpscale2's candidate count stays 5001 (wall 1878 → 1493ms). selenium web-form, APG select-only
  and select2 `index:0` all still verify.
- **THIS IS THE GCP FIX — resolved.** Live in the owner's Chrome on 13f9cff, the full `gcpform`
  cell runs **6/6 in 18.6s over 10 calls**, and `fast_select_option` takes 0.8s with
  `{resolveMs: 7, rowsMs: 1, openMs: 191, pickMs: 134, readbackMs: 6, snapshotMs: 162}`.
  **Resolve went 45,619ms → 7ms.** The run before it (e629ec4) was 88.7s and 4/6 with both batch
  steps timing out. **Confirmed five consecutive times** in the owner's real Chrome: 6/6 18.6s/10
  calls, then 6/6 20.5s/9, 6/6 24.4s/9, 6/6 18.4s/7, and — importantly — 6/6 again on STOCK
  timeouts after the temporarily raised limits (extension bridge 20s, broker 30s, server 30s) were
  reverted, plus 6/6 27.1s/9 on the guarded build 67bcef7. So the result does not depend on the
  lifted deadlines that were in place while this was being diagnosed. Do not re-litigate this: the cause was the per-iframe forced synchronous layout,
  because probe 5 measured that page at **9,995,921 composed nodes, 47,646 roots and 38,116
  same-origin iframes** behind only 5 top-level ones. I originally dismissed this fix as
  insufficient by pricing ~0.15ms/frame against ~600 frames; at 38,116 frames — each layout
  invalidated by the next in a continuously re-rendering document — it was the entire 45s. The
  lesson worth keeping: a per-element forced layout is not a constant cost, it is O(frames) with a
  re-render multiplier, and the composed tree behind a handful of top-level iframes can be three
  orders of magnitude larger than the document you can see.

## 2026-09-16 — fast_select_option: toControls' containment dedupe was O(n²) and read a rect per match
- **What:** `toControls` (page.js) dedupes with an ancestor `Set` lookup (O(depth), crossing shadow
  hosts) instead of `out.some(o => o.el.contains(c.el) || c.el.contains(o.el))` over every kept
  candidate, and reads layout only for candidates that survive the dedupe. A `blocked` set of the
  taken candidates' ancestors preserves the old rule exactly: of any containment-related group the
  FIRST-listed wins (controls are listed before the wrappers around them).
- **Why:** on a page whose match set runs to thousands, the pairwise scan is ~n²/2 `contains` calls —
  57.5% of CPU in a local profile (`compareDocumentPosition` from its sort another 3.1%) — and it
  read a `getBoundingClientRect` for every match before the dedupe could discard it. Found while
  chasing GCP's remaining resolve cost, whose probe showed 34,409 rect reads inside one resolve.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** this is NOT the GCP fix. Probe 3 on the live GCP tab shows the idle page has only
  2 shadow roots, 42 pooled elements and 14 select-like ones, so its 45s resolve is something else
  (still under investigation — the counters there scale with call DURATION, not DOM size). This
  change matters for pages with genuinely large match sets. The first attempt at it regressed the
  candidate semantics (10001 vs 5001 candidates) because the old scan ALSO dropped a wrapper whose
  descendant was already kept; the `blocked` set is what restores parity, so keep it if this is
  touched again.
- **Status:** committed; fast-runner 56/56. On a 4,960-shadow-root repro with ~10k select-like
  elements: wall **3768ms → 1821ms**, `contains` gone from the profile, candidate count identical
  at 5001. Real pages unchanged: selenium web-form verified, APG select-only verified,
  react-select.com identical refusal, select2 `index:0` still picks Alaska through the backing
  select. hvm six-cell on the previous commit was 59/59; holdout 1 re-run 28/32 with zero
  overclaims (the same per-pass rate as 9d18d4d's 56/64 over n=2).

## 2026-09-15 — fast_select_option on GCP, part 2: a dropdown candidate must be select-like (a `<nav>` was one); containerLabel stops at the second label
- **What:** (a) `fast_select_option` narrows its candidate pool to `SELECTISH`
  (`DROPDOWN_SEL`, `[aria-expanded]`, or a native `select/input/textarea`) BEFORE the name-matching
  tier loop, so a landmark can never be named as a dropdown. (b) `containerLabel` stops as soon as
  it sees a SECOND non-wrapping label instead of `Array.from(p.querySelectorAll('label')).filter(l
  => l.contains(el))` — it only ever needed "is there exactly one".
- **Why:** after the row-scan fix shipped (fa51868), GCP's OAuth form STILL died on the 20s
  deadline. Probing the real tab (DOM-API counters installed around a direct
  `window.__fastlink.run` call, so the bridge deadline did not truncate it) showed the call actually
  took **88,966ms** and that the cost was CALL COUNT, not per-query cost: `querySelectorAll('label')`
  **138,869 times** (696ms of self-time), 54,645 rect reads, while the composed-tree walk was only
  4,960 roots / 4ms — walkDeep and forced layout were both innocent. The `label` storm is
  `containerLabel` running per candidate over a pool that was every `[aria-label]`/`[placeholder]`
  element on the page, each hop materializing thousands of labels and calling `contains` on each.
  9d18d4d is again the origin: the old `findField` RETURNED on the first match, the new `findFields`
  evaluates the whole pool. The same over-wide pool was also a correctness bug — GCP's breadcrumb
  `<nav>` and its `<a>`s picked the field name up from a nearby label and the call refused with
  "4 visible dropdown(s) match", naming a `<nav>` whose value was "Google Auth Platform Clients
  Create client". `<nav>`/`<a>` have implicit landmark roles, so the existing `LANDMARK_ROLES` test
  (which reads the `role` ATTRIBUTE) never excluded them.
- **Files:** `fast-ext/src/actions/page.js`, `fast-runner/test/select-perf.test.mjs`.
- **Watch out:** a custom dropdown with NO select semantics at all (no role, no `aria-haspopup`, no
  `aria-expanded`, not a native control) is no longer matchable by name — it was only ever matchable
  by accident, and the miss report still lists `dropdownCandidates()`. `[aria-expanded]` is in
  `SELECTISH` precisely so a `<div role="button" aria-expanded>` widget still resolves.
- **Status:** committed; fast-runner 56/56 (new test: a `<nav>`/`<a>` carrying the field name is
  never a candidate). On a landmark-shaped repro: `querySelectorAll('label')` **5,000 → 0**
  (total querySelectorAll 5,016 → 16), `resolveMs` **1,700ms → 15ms**. Real pages unchanged or
  better: selenium web-form verified 10ms; APG select-only verified; react-select.com byte-identical
  refusal; select2 unchanged — it sometimes lists a third candidate (its own unlabelled internal
  search field, `value:""`), but that is timing-dependent and PRE-EXISTING (12b368c produced 2 and
  then 3 candidates on consecutive runs), neither caused nor fixed here, and `index:0` still picks
  Alaska through the hidden backing select. GCP itself still needs the lead's re-test in the
  owner's Chrome.

## 2026-09-15 — fast_select_option regression: the repeated-row scan was O(fields × document); bounded, memoized, and now guarded by a perf test
- **What:** `rowContextOf` (page.js) is bounded and memoized. (a) ONE `label[for]` map per
  invocation feeds every `fieldKey` via `labelFor(el, rowForLookup)`; (b) `rowContextOf` answers
  from a per-action `WeakMap`; (c) the subtree scans are a DFS under a hard node budget
  (`fieldsWithin`, `ROW_SCAN_NODES` 1500) — a subtree too big to be one row aborts the climb
  (`keys === null` → `break`), and the sibling scan is capped (`ROW_MAX_SIBS` 200). Row/ambiguity
  resolution is now its own reported phase, `timing.rowsMs`.
- **Why:** on build 12b368c `fast_select_option {field:"Application type"}` on GCP's OAuth form
  burned the whole 20s runBridge deadline (`{"error":"page busy"}`) on a page whose `fast_snapshot`
  took 116ms; it was 5.4s and verified on 976771f. Bisect on a synthetic console-SPA repro (wall /
  document-wide querySelector calls): a550ef0 2740ms/404 → 3b5063e 2744ms/412 → **9d18d4d
  8490ms/3104** → 8837e49 8353ms/3104 → 12b368c 8471ms/3092. 9d18d4d's row detection climbed 16
  ancestors, ran `querySelectorAll(FILLABLE_SEL)` over ancestor subtrees that grow toward the whole
  document, and resolved every field's label through `labelFor()` with no precomputed map — two
  document-wide `querySelector('label[for=…]')` per field — uncached, 3-6× per element per call
  (visRows, hiddenRows/inOtherRow, pre/rowInfoOf, rowInfoOf per listed candidate). A page with NO
  repeated rows (GCP) never returns early, so it always paid the worst case. CPU profile:
  `querySelector` self-time 25% → 89.6%.
- **Files:** `fast-ext/src/actions/page.js`, `fast-runner/test/select-perf.test.mjs`,
  `fast-runner/package.json` (jsdom devDependency).
- **Watch out:** a repeated row larger than `ROW_SCAN_NODES` (1500 nodes) is no longer detected as a
  row — that is deliberate (a row is a small local structure), but a page with genuinely huge rows
  would lose the row naming, not the write. The row scan is memoized for the whole page action:
  row STRUCTURE is cached, row VALUES (`rowFirst`) are still re-read, so before/after comparisons
  around a write stay live.
- **Status:** committed; unit tests pass (fast-runner 52/52 + the new guard, fast-dxt 6/6).
  Measured on a 243k-node repro under a 16ms mutation storm: **41,002ms → 1,722ms**
  (`rowsMs` 54). 178k-node repro: row block 2103ms → 10ms. 10k-node/50-row DOM: document-wide
  queries 3092 → 404 (976771f baseline 404), un-attributed row time 6.2s → 61ms; at 2× the page
  the query count does not grow (404 → 314). Live: selenium web-form native select verified in
  10ms; react-select.com returns the SAME "2 visible dropdown(s) match" refusal as pre-fix.
  GCP itself is untested here (no login) — the lead re-tests it in the owner's Chrome.

## 2026-09-15 — holdout 2: six more unseen sites (bench/holdout2.js, ids h2_*), validated both directions; baseline pending
- **What:** `bench/holdout2.js` — Syncfusion EJ2 tab wizard (dependent steps), Mantine slider + switch, Wunderbaum 100k-node virtualized tree (target under two collapsed nodes), National Rail live-trains typeahead (commit = hidden CRS code), Element Plus form-in-modal, itch.io infinite-scroll games grid. Registered as `SUITES.holdout2` (`node bench/run.js --list --suite holdout2`, `--test h2_<id>`).
- **Why:** holdout 1's sites are now the fixer's proof sites, so they no longer measure carry-over. None of these six is in suite.js, holdout 1, or the fixer's proof list (GOV.UK, jQuery UI, Select2, Form.io, jsDelivr, DataTables, Bootstrap btn-check, MUI Checkbox, SurveyJS, bootstrap-datepicker, Tom Select, Choices.js).
- **Files:** `bench/holdout2.js`, `bench/suite.js`, `bench/run.js`, `docs/GROK_RUNNER_HOLDOUT2_2026-09-15.md`.
- **Watch out:** every checkpoint fails on the untouched page except `tab`, and passes after the task was done by hand through the local FastLink tools on hvm (see the doc). Validation fixed four readers before any run: Mantine's controls panel has its own 0–100 sliders, and its snippet always prints `color="blue"`; an Element Plus dialog is position:fixed (offsetParent is always null); National Rail's hidden field holds the CRS code; Wunderbaum's Causes group is collapsed too. For infinite scroll, DEV's top feed was dropped (logged out it never loads past 18 cards), and so was Discourse Meta (after ~10 quick loads, hvm's IP got network errors). Never tune a fix against these sites.
- **Status:** committed; grok-4.3 / phase2 baseline NOT run (xAI spending limit, still `personal-team-blocked:spending-limit` on re-check).: repeated-row checkbox clicks refused; a no-href <a> answers to role "link"; a top-level verified:false write is an unresolved action for the gate
- **What:** page.js fast_click: when the best match is a check-type control (checkbox/radio, native
  or ARIA) whose label also names the same kind of control in ANOTHER row of the same repeated rows
  and no index is given, nothing is clicked — `candidates` {index, label, checked, row, rows,
  rowFirst}. A script-only `<a>` (no href) also matches role "link". `rowFirst` reads visible fields
  only. runner.mjs `partialFailures`: a single (non-wrapper) call whose own result is
  `verified:false` is a failed action on its target (a later verified call on it resolves it).
- **Why:** holdout n=2 on 9d18d4d: h_repeat p1+p2 (5/7, overclaims) — `fast_click {text:"Dependant",
  role:"checkbox"}` with no index unticked Joe's seeded row; the Birthdate fill read back
  `verified:false` (the date widget never committed it) and was reported as set — the gate let it
  through. h_datepicker p1 — `fast_click {text:"Next", role:"link"}` ×3 refused (implicit role
  "generic") → runner stopped.
- **Files:** `fast-ext/src/actions/page.js`, `fast-runner/runner.mjs`,
  `fast-runner/test/holdout-replay.test.mjs`.
- **Watch out:** a date/masked field that always reformats now costs one gate refusal per run
  unless the model re-reads/explains it (the one-refusal rule still applies).
- **Status:** committed; unit tests pass; live by tool call on hvm (no model — xAI credits ran out): Form.io "Dependant" no index → refused (rows Joe/Mary/new), index:2 → only the new row ticked, Joe stays true; (N) SurveyJS dynamic matrix "Yes" → refused (11), index:2 → exactly that radio; jQuery UI Next role:"link" → month advances; GOV.UK distinct-label radio still clicks. Holdout n=2 on 9d18d4d: docs/GROK_RUNNER_HOLDOUT_2026-09-15.md.

## 2026-09-15 — holdout gaps 1-4, 6: live proof (hvm rig, fixed build loaded unpacked, tools called in-process via bench/fastlink.js)
Non-holdout sites marked (N). Every row is a before/after page read through fast_evaluate.
| gap | site | call → result |
|---|---|---|
| 1 | GOV.UK conditional radios | snapshot lists `input radio "Text message" via:label checked:false`; fast_click "Text message" → checked:true verified; panel revealed; fast_fill Mobile phone number verified; fast_text on that input → "07700 900982" (9179f44 through the extension) |
| 1 | (N) getbootstrap.com btn-check | fast_click "Single toggle" (clipped checkbox) → checked:true verified; page reads checked |
| 1 | (N) mui.com Checkbox | fast_click "Required" role:checkbox (opacity-0 input) → checked:true; page reads checked |
| 1 | (N) SurveyJS dynamic matrix | its visually-hidden radios listed `via:label`; fast_fill "Yes" true index:1 → exactly that radio checked |
| 2 | jQuery UI inline datepicker | snapshot lists Prev/Next `clickable:"script"`; fast_click "Next" role:generic ×2 → Sept → November 2026 |
| 2 | (N) bootstrap-datepicker (inline) | `th "»"` (cursor:pointer) listed; fast_click "»" → September → October 2026 |
| 3 | select2.org | fast_click "Alaska" → refused, 2 dropdowns listed; fast_select_option "Single select boxes¶" → refused, candidates; index:1 → Select2 set, verified on the widget (code OR / shown Oregon / twin still AK); fast_click "Oregon" role:combobox → the [role=combobox] widget |
| 3 | (N) tom-select.js.org | fast_select_option field = the hidden select's id → its widget set, verified on shown value, backingValue "Nikola Tesla" (select value 3) |
| 3/4 | (N) choices-js.github.io | "Default" (two widgets) → refused with sections; section:"Single select input" → that widget set (value + shown "Choice 2") |
| 4/6 | Form.io data grid | Gender no index → refused, rows Joe/Mary/Ada; index:2 → row 2 set (`row` named), other rows unchanged; index:1 Other → Mary only |
| 4/6 | (N) SurveyJS dynamic panel | 3× "Select a country" → refused; index:1 → only panel 2 = France |
| 5 | Form.io | batch with a missed section + an ambiguous selections pick → "1/3 steps ok; step 0 … not verified … step 1 … not verified", selections wrapper verified:false |
| 6 | Form.io | fast_fill "First Name" → refused (rows 0-2, rowFirst Joe/Mary/empty); fields index:2 → `filled.row` {row:2, rowFirst:"Ada"}; "Dependant" true index:2 → checkbox checked (was: value "true" written, nothing ticked); "Birthdate" no index → refused (Joe's + Ada's) |
| 6 | (N) SurveyJS dynamic matrix | fast_fill "Yes" → refused (11 visible, each with row + name); index:2 → `filled.row` {row:3} |
Not fixed: Choices' grouped single select ("Option groups", index:1) opens but its grouped choices are not found — honest "no matching option", nothing changed.

## 2026-09-15 — holdout gap 6: repeated rows — a row-ambiguous write is refused with each row named; a landed write names its row
- **What:** page.js row groups: `rowContextOf(el)` = the nearest ancestor whose same-shaped siblings
  (tag + class tokens; state/numbered tokens ignored) hold a field sharing a label/aria-label/name
  with it (a form's field groups never qualify — each holds a DIFFERENT label; a shared placeholder
  does not count). `rowInfoOf` → `{row, rows, rowFirst}` (rowFirst = the row's first non-empty field
  value, else its visible text). fast_fill: a label matching 2+ visible fields is refused even when
  `section` still holds several (it used to write the first in the section); ONE visible match whose
  label also exists HIDDEN in another row of the same group (`hiddenCopiesOf`) is refused too;
  candidates carry row info + `visible`; the index-out-of-range miss lists row info and
  `hiddenMatches`; a write into a row names it (`filled.row`); the section hint is offered only when
  it tells candidates apart. fast_select_option uses the same rule (below). Checkbox/radio fill:
  value true/false is a STATE set by a click and read back as `checked` (writing "true" into
  `.value` ticked nothing while the result read back "true").
- **Why:** holdout h_repeat (ce062850): `fast_fill {match:"Birthdate"}` with no index wrote Joe's
  seeded row (1982-05-18 → 2015-12-10); `fast_select_option {field:"Gender"}` opened Joe's widget;
  `fast_fill {match:"Dependant", value:"true", index:2}` "verified" a value, ticked nothing.
- **Files:** `fast-ext/src/actions/page.js`, both `tools.js`, `fast-runner/test/fill-ambiguity.test.mjs`.
- **Watch out:** `index` still counts VISIBLE matches in document order (not rows) — every listing
  names each candidate's row. A hidden copy inside a row that already has a visible match is that
  row's widget internals, never a second copy. Two same-shaped blocks sharing a LABEL (billing /
  shipping "Address") are rows by this rule — correct: that label is ambiguous.
- **Status:** committed; live proof in the entry above.

## 2026-09-15 — holdout gaps 3+4: ambiguous dropdowns refused; fast_select_option gets index + section; a hidden backing select IS its widget
- **What:** fast_select_option resolves EVERY candidate (`findFields`: name/id → first name tier
  with a visible match, exact name beating substring → titled section incl. hidden controls) into
  one entry per control (`toControls`: a wrapper and its inner control are one; a hidden native
  <select> with ONE visible enhancing widget next to/around it — `widgetFor` — becomes that widget,
  `backing` kept). New `index` (N-th VISIBLE candidate, document order) and `section` args (same
  outline resolver as fast_fill; no page-wide fallback); `selections` values may be
  {option, index, section}. 2+ visible candidates → error `N visible dropdown(s) match …` with
  `candidates` {index, tag, role, label, section, visible, value (shown), backing, row…}. Read-back
  = the VISIBLE control's shown value (`shownValueOf`: selected option / input value / widget's
  visible text minus buttons, hidden option lists and nested popups; `showsValue` whole-word match,
  "Female" never passes for "Male"), `backingValue` reports the hidden select. Generic ARIA path:
  a control saying aria-expanded="false" is closed whatever option rows are visible; options inside
  ANOTHER combobox are never offered (Choices draws each widget's value as role=listbox/option);
  trigger and option get the full pointer sequence (Select2 commits on mouseup, Choices on
  mousedown). fast_click: an explicit `role` prefers elements whose OWN role attribute matches; when
  the best match is a dropdown trigger and another distinct dropdown also matches, nothing is
  clicked — `candidates` {index, tag, role, label, section, value, row}. Section names drop a
  trailing permalink glyph (¶ § 🔗 ⚓, spaced/zero-width "#") everywhere they are read or listed.
  Custom [role=combobox] snapshot entries are live (text = shown value, not a stale/option-list
  textContent). `fieldVisible`: a widget's invisible typing input (react-select dummy, Tom Select)
  is visible when its widget box is (no more react-select class sniffing).
- **Why:** holdout h_combobox (245d4c2b): `fast_click {text:"Alaska", role:"combobox"}` clicked
  select2.org's plain native twin (implicit combobox), then `fast_select_option {field:"Single select
  boxes¶"}` set the twin `verified:true` while the Select2 widget still showed Alaska. h_repeat:
  `fast_select_option` had no index, and its option sweep offered Mary's selected "Female" item.
- **Files:** `fast-ext/src/actions/page.js`, both `tools.js`.
- **Watch out:** a label that used to resolve to its first match now errors when it matches 2+
  visible dropdowns — pass index/section. `usableField` and the old single-answer `findField` are
  gone (replaced).
- **Status:** committed; live proof in the entry above.

## 2026-09-15 — holdout gap 2: script-driven click targets (no-href <a>, cursor:pointer text) are clickable, ranked below real controls
- **What:** `a:not([href])` joins SELECTOR as a WEAK entry (no role/onclick/tab stop) and a
  text-bearing content element with computed `cursor:pointer` (not inside a control, not a label's
  text) is also listed — both as `clickable:"script"`, implicit role "generic", matchScore ×0.01 (always
  below any real control/link, still a candidate), rank −10. fast_click's last resort before "No
  element matching": `pointerTargetByText` — a visible pointer-cursor element whose own text /
  aria-label / title / alt IS the text. Script targets and custom (non-native) elements get the full
  pointer sequence (`pointerSeq`: pointerover/mouseover → pointerdown/mousedown → pointerup/mouseup
  → click, at the element centre, stopping if a handler detached it); native controls keep
  el.click(). `pointerSeq` replaces the three ad-hoc event loops (react-select open/pick, ARIA open,
  suggestion fallback).
- **Why:** holdout h_datepicker: jQuery UI's Prev/Next are `<a>` with no href — not in any
  snapshot, and `fast_click {text:"Next", role:"generic"}` ×3 → "non-interactive match" → run stopped.
- **Files:** `fast-ext/src/actions/page.js`, both `tools.js`.
- **Watch out:** snapshots list more items on pages that put cursor:pointer on text (ranked last).
- **Status:** committed; live proof in the entry above.

## 2026-09-15 — holdout gap 1: a radio/checkbox drawn by its <label> is a visible control
- **What:** serializeSnapshot: a native radio/checkbox that fails `visible()` (opacity 0, clipped,
  1px, display:none) but has a visible `<label>` (for= or wrapping; `el.labels`) is listed AS the
  control — geometry = the label box(es) plus the input's own box when it sits by the label,
  `via:"label"`. Every radio/checkbox item carries `checked` (+ its role); its `text` is its label,
  never the value attribute ("on"). ARIA radio/checkbox/switch carry `checked` from aria-checked.
  fast_click: role/tag "label" also matches a label-proxied control; a check-type target's result
  carries `checked` + `verified` (radio: selected now; checkbox: toggled) + `reason`.
- **Why:** holdout h_conditional: GOV.UK radios are opacity-0 inputs under visible labels —
  `fast_snapshot` listed 0 controls and seven fast_click variants on "Text message" missed.
- **Files:** `fast-ext/src/actions/page.js`, both `tools.js`.
- **Watch out:** the label's own text is not listed separately (it is the control's name).
- **Status:** committed; live proof in the entry above.

## 2026-09-15 — holdout gap 5: wrapper honesty — a batch step is ok only when its own result is clean; the gate sees child failures
- **What:** `fast-dxt/server/batch.js` (mirror `fastlink-relay/src/batch.js`, identical): new exported
  `notVerified(result)` — a successful call whose result says `verified:false`, or has `missed>0` /
  `failed>0`, is NOT ok: the step is `ok:false` (its `result` kept), counted in `missed`, and the
  summary names it `step N (…) not verified: <reason|summary>`. Batch still never aborts. A
  selections step's label names its keys. `fast-runner/runner.mjs` `partialFailures`: every field of
  a fields-mode fill and every `selections` entry that errored OR read back `verified:false` is a
  failed action (top-level or inside a batch step — a batch fill/select step reports its children,
  not itself). The extension side (selections wrapper `verified` = AND of its fields) is in the
  extension commit below. fast_batch description updated identically in both tools.js.
- **Why:** holdout h_repeat (ce062850): the batch said `"3/3 steps ok"` over a fields fill that
  filled 0/2 ("section not found"), and a `selections` pick said `verified:true, picked:1` over its
  only field's `verified:false` — both overclaims passed the report_done gate because the wrapper
  said ok.
- **Files:** `fast-dxt/server/batch.js`, `fastlink-relay/src/batch.js`, `fast-runner/runner.mjs`,
  `fast-dxt/server/tools.js`, `fastlink-relay/tools.js`, `fast-runner/test/batch.test.mjs`,
  `fast-runner/test/holdout-replay.test.mjs` (new).
- **Watch out:** a batch fill whose page reformatted the value (verified:false) now reads "not
  verified" — that is the point. A top-level single write with `verified:false` is still NOT a gate
  failure (its own `reason` tells the model); only wrapper children are. The gate refuses once per
  run for an unresolved child failure (existing one-refusal rule).
- **Status:** committed; `node --test test/*.test.mjs` all pass, incl. the holdout replay: both
  baseline logs (h_combobox 245d4c2b, h_repeat ce062850) pass the gate with the baseline tools'
  results and are REFUSED with the fixed tools' results for the same calls (unresolved
  fast_select_option "Single select boxes¶"; fast_select_option "Gender" + fast_fill "Birthdate").

---

## 2026-09-15 — fast_text on a form control returns its live value; an empty read says empty:true
- **What:** `extractText` (fast-ext/src/actions/text.js) uses `querySelectorAll`. When a match is
  input / textarea / select / [contenteditable] / role=combobox|textbox|searchbox, `text` is the
  live VALUE (select: selected option text, `optionValue` the value; checkbox/radio add `checked`;
  a role wrapper reads the control inside; passwords masked) with `field:{tag, label, value}`
  (label = aria-label → aria-labelledby → <label>'s own text, never a wrapped control's →
  placeholder/name/id), `kind:"value"`. Several matches → `fields:[…]`, `matches:N`, text one
  `label: value` line each (non-controls as their text). A read whose text is blank returns
  `empty:true` + hint "the element has no text; if it is a form field its value is in value (shown
  here) — an empty read is not confirmation". Body default, html:true, not-found and truncation
  are unchanged. fast_text description updated identically in `fast-dxt/server/tools.js` and
  `fastlink-relay/tools.js`.
- **Why:** gate=record mapsdir p2 (61581163): `fast_text {selector:'[aria-label*="Destination"]'}`
  returned "" (an <input> has no textContent); Grok read "nothing contradicts me" and reported the
  value it typed while Maps had rewritten the box — the one overclaim. flightsearch p1 (bed97274)
  read "" the same way from six inputs/selects on aa.com.
- **Files:** `fast-ext/src/actions/text.js`, `fast-dxt/server/tools.js`, `fastlink-relay/tools.js`,
  `fast-runner/test/text-controls.test.mjs`.
- **Watch out:** a selector that matches a container AND controls now lists every match (it used to
  return the first match's innerText). Helpers live INSIDE `extractText` — executeScript serializes
  only that function. Takes effect after ship-ext (owner) / extension reload (rig); relay needs
  `wrangler deploy` for the description.
- **Status:** committed; unit tests 6/6. Live, old vs new extractText on the same elements in a
  throwaway headless Chrome (not the owner's, not the rig — hvm was mid holdout run): selenium
  web-form typed input "" → "FastLink proof", native select option dump → "Two" (optionValue "2"),
  empty input → empty:true + hint, 4-field selector "" → 4 `label: value` lines; Google Maps
  /dir JFK → Times Square `[aria-label*="Destination"]` "" → "Times Square, Manhattan, NY 10036",
  both direction inputs "" → both values. aa.com blocks headless (no fields rendered). Extension
  path on hvm not yet exercised.

## 2026-09-15 — fast-runner gate: a write's own verified read-back is its read; a redirected failure is superseded; first-load claims are structural
- **What:** runner.mjs. (1) New exported `entryFacts(name, args, text, ok)` is the ONE parse of a
  result for the toolLog entry: `partial`, `sections`, `url`, `verified` (a fast_fill /
  fast_fill {fields} / fast_select_option with `verified:true`, or a fast_batch whose LAST
  state-changing step is such a write), and on a failed call whose error carries `selectField`,
  `redirect:"fast_select_option"`. The loop and the test harness both use it. Check 1: the last
  state-changing call's own `verified` counts as the read after it (never for a later action).
  Check 3: a failed call with `redirect` is resolved by a later successful call of that tool.
  (2) Check 4: `TAB_OPEN` wording deleted; the FIRST fast_tab/fast_nav satisfies an
  opened/navigated claim whose clause (sentence / ;-part / line) names that call's URL — requested
  or landed, scheme/www/query/trailing slash ignored — or a tab when the call was fast_tab.
- **Why:** gate=record bench: overlay p1-p3 would have been refused "no read after
  fast_select_option" although the select returned `verified:true, picked:"Forest"`; p1 also for
  the failed `fast_click "Ocean"` whose error said "this is a select control … use
  fast_select_option" (it had matched the Multi Select chip, react-select-8; the model then used
  fast_select_option on Single — so no same-field id link exists, the redirect is the structural
  one). flightsearch p1-p3: "New tab opened to https://www.aa.com/…" was flagged because only
  "opened a new tab" was exempt. All six scored full.
- **Files:** `fast-runner/runner.mjs`, `fast-runner/test/gate.test.mjs`.
- **Watch out:** an UNverified write still needs a fast_snapshot/fast_text after it. A claim that
  names the first URL but means another page ("Opened https://first/… and the Worker") passes; a
  fast_nav first load names no tab. cfworkers fbc16cf2 ('Worker "fastlink-relay" opened', list
  page only) is still flagged (test).
- **Status:** committed; `node --test test/*.test.mjs` 47/47. Replay of the 7 would-refuse rows
  (toolLogs from hvm runs.jsonl through the new gateProblems; evidence verdict carried over — the
  corpus is not stored): overlay ×3 and flightsearch ×3 now pass; only mapsdir p2 (61581163) still
  refuses (unquoted evidence + unretried wait) — the one the gate was right about.

## 2026-09-15 — bench HOLDOUT set: 6 untuned public sites (bench/holdout.js, ids h_*)
- **What:** `bench/holdout.js` exports `HOLDOUT` (same shape as suite.js): `h_conditional` GOV.UK
  conditional-reveal radios, `h_datepicker` jQuery UI inline calendar (no input), `h_combobox`
  Select2 single select, `h_table` DataTables sort+paginate, `h_repeat` Form.io data grid
  (Add Another + Choices.js select + conditional Birthdate), `h_spa` jsDelivr search → package →
  Files tab. `suite.js` resolves both (`ALL_TESTS`, `SUITES`), so `run.js --test h_table` and
  `--list --suite holdout` work with no second code path; hvm-report / drive-runner / report render
  ALL_TESTS. Baseline: `docs/GROK_RUNNER_HOLDOUT_2026-09-15.md`.
- **Why:** owner's rule — "every website is different, you can't tailor fixes to one site". The
  main suite has been fixed against for weeks; these sites were never used in a fix or a proof.
- **Validation (METHOD RULE, hvm rig, by hand through the local FastLink tools):** untouched →
  done: h_conditional 1/6 → 6/6, h_datepicker 1/4 → 4/4, h_combobox 1/4 → (typed, not committed)
  1/4 → 4/4, h_table 1/6 → 6/6, h_repeat 1/7 → 7/7, h_spa 1/5 → 5/5. The only untouched pass is
  the `tab` checkpoint (same as suite.js). "Not submitted" is folded into a checkpoint that needs
  real work, never scored alone.
- **Files:** `bench/holdout.js` (new), `bench/{suite,run,hvm-report,drive-runner,report}.js`,
  `docs/GROK_RUNNER_HOLDOUT_2026-09-15.md`.
- **Watch out:** HARNESS TRAP — a reader must never return a field named `value` or `result`:
  `bench/fastlink.js evalIn` unwraps `r.value`, so `{value:'AK', shown:'Alaska'}` scored every pick
  as "AK" (widget "shows OR" on a page showing Oregon). No backticks inside reader strings (they
  are template literals — one pushed a parse error that broke every suite.js import for a commit).
  Never tune a FastLink fix until one of these passes; a fix is proven on the main suite and only
  CHECKED here. Tool gaps the validation hit by hand (each generic): `fast_click` ignores a
  `<label for>` over a visually-hidden radio and an `<a>` with no href; `fast_select_option` on
  Select2 reports the pick but it never commits (honest `verified:false`); on a Choices.js field it
  resolves the enhanced, option-less hidden `<select>` ("available: []"). Workarounds used:
  fast_evaluate rect → fast_click_xy, and trusted click + fast_type + Enter.
- **Status:** in code / validated both ways on hvm / baseline run (grok-4.3, phase2, gate on,
  cdf5f6c): **18/32**, 58 calls, 103.9s, 2 overclaims — h_table 6/6, h_spa 5/5, h_repeat 4/7 (3/7
  with the tightened seed check: it overwrote Joe's seeded Birthdate), h_conditional 1/6,
  h_datepicker 1/4, h_combobox 1/4 (set the native twin select; Select2 unchanged). Both overclaims
  passed the gate because a tool's `verified` was wrong or wrongly aggregated. Six generic
  contracts are listed in the doc.

## 2026-09-15 — fast-runner gate mode: on | record | off (measure the model alone)
- **What:** one gate mode per run: `FASTRUN_GATE` env, `--gate <mode>` (cli.mjs), `gate` arg on
  `grok_run`. `on` (default) = the report_done gate as before. `record` = every check runs at the
  first report_done exactly as `on` would, but the report is always accepted; when `on` would
  have refused, the row gets `gateWouldRefuse:[{t, problems, evidence, result}]`. `off` = no checks,
  no gate fields. Every runs.jsonl row / snapshot carries `gate`. The report_done decision moved
  into an exported pure `reportDone(run, args, t)` (the loop only applies it); the row's gate
  fields come from one `gateFields(run)`. The system prompt is identical in all modes.
  Bench: `drive-runner.start()` passes `--gate` from `FASTRUN_GATE`; `bench/run.js` rows get `gate`
  and a `gate=<mode>` note; `hvm-run.sh` logs the mode per pass; `hvm-report.js` shows
  model/toolset/gate per pass and, for record runs, each would-refuse next to the cell's score
  plus the overclaims.
- **Why:** owner: "see how well 4.3 can get it done itself and why Grok doesn't check itself".
  With the gate on, a run's score measures model+gate; record isolates the model and says, per
  would-refuse, whether the gate was right (score short) or wrong (full score).
- **Files:** `fast-runner/runner.mjs`, `fast-runner/cli.mjs`, `fast-runner/caller-mcp.mjs`,
  `fast-runner/README.md`, `fast-runner/test/gate.test.mjs`, `bench/drive-runner.js`,
  `bench/run.js`, `bench/hvm-run.sh`, `bench/hvm-report.js`.
- **Watch out:** `on` behaviour is unchanged (tests: refuses 3×, then accepts flagged
  `gateOverridden`); a bad mode throws before any connect. `record` has exactly one report_done
  per run, so at most one gateWouldRefuse entry. hvm-report reads a row without `gate` as `on`.
- **Status:** committed; unit tests 38/38.

## 2026-09-15 — bench: the URL trail is read twice per cell (baseline + after exit), never polled mid-run
- **What:** `bench/monitor.js` `TrailWatcher` has `baseline()` (before the run) and `collect()`
  (after it) and counts its `reads`; `watchRun` no longer takes a trail watcher or touches the
  browser; `DEFAULTS.trailPollMs` deleted. `bench/run.js`: the runner branch drops its
  `setInterval(trailWatcher.poll, 3000)`; every cell calls `collect()` once after the watch
  returns and notes `trail: N fast_list read(s)`. The monitor CLI reads the trail once at exit.
- **Why:** recording #4: the FastLink panel showed "Listing tabs" every 3s during a cell — the
  bench's fast_list poll going through the service worker the run drives. Since 982ae6d the
  extension records each tab's URL trail passively (ring of 50), so polling added nothing.
  Liveness never came from it: runner cells derive STUCK / NO_ACTIVITY from the runner's own
  call rows (drive-runner `RunnerTrace`), chat cells from the relay /trace or the local timing
  log.
- **Files:** `bench/monitor.js`, `bench/run.js`, `bench/drive-web.js` (comment).
- **Watch out:** a tab that changes URL more than 50 times in one cell loses its earliest stops
  (the extension ring); none of the six cells comes close.
- **Status:** committed (684ebfb); hvm grok-4.3/phase2 local: multipage 6/6 (5 calls, run
  cc5479da), mapsdir 6/6 (9 calls, 743cd3b5) — same as the prior six rows each. fast_list rows
  in /tmp/fastlink-timing.jsonl inside the runner's run window: 0 and 0 (the cell's 5 are reset +
  baseline before start, collect + scoring after exit); row notes `trail: 2 fast_list read(s)`.

## 2026-09-15 — fast-runner gate: evidence matcher normalizes both sides and matches values, not raw JSON; refused reports are stored
- **What:** runner.mjs. (1) `normQuote` is the ONE normalization for result and quote: JSON
  escapes unescaped (\uXXXX \n \t \" \\ \/), NFKC, curly quotes → straight, dash variants →
  "-", zero-width dropped, whitespace collapsed, lowercased. (2) `recordResult` takes EVERY text
  block of a result (was: the first) and `corpusRow` pre-computes the result's LEAF lines: every
  JSON string/number value split into lines, plus keys that contain a space ({fields} labels);
  plain keys ("value", "name") are never evidence. (3) `evidenceFragments`: quoted spans paired
  per quote kind at ANY length ("…" “…” ‘…’ `…`, '…' only when not an apostrophe), unquoted
  segments between separators (newline, " ... ", ; | ( ) =, ", ", ": "), 3-6 word runs. (4)
  `quotes(row, f)`: a 3-char fragment must BE a whole value/line ("JFK"); one word of 4+ chars
  must stand as a whole word inside a value/line; a phrase must sit inside one value/line or the
  raw text. Replaces the old single-regex pairing + raw-JSON substring test. (5) Each
  `gateRefusals` row stores the refused report's `result` and `evidence`.
- **Why:** hvm flightsearch hit the refusal cap 4× (78477b54, 319ebee7, df8959b2, fcd7afc5,
  then gateOverridden) on evidence whose values WERE in the results: `value="JFK" ...
  value="LAX" ... value="10/15/2026" ...`. The old regex skipped the 3-char `"JFK"` and then
  paired every later closing quote with the next opening one, so every fragment read
  ` ... value=`; `value="10/15/2026"` never equals the result's `"value":"10/15/2026"`; and
  `value="JFK" (item 284 in snapshot)` had no 4+ char fragment at all. Matcher too strict, not
  fabricated quotes. Recording #4 (f96c8d9c) was refused twice the same way, but refused
  evidence was not stored, so its exact strings are lost (the accepted third one — two quoted
  headings — passes old and new).
- **Files:** `fast-runner/runner.mjs`, `fast-runner/test/gate.test.mjs`.
- **Watch out:** a real quote of a structure word alone ("value", "name") still fails; a 2-char
  quote never counts.
- **Status:** committed (a30aeb6); `node --test test/*.test.mjs` 35/35 (the four hvm evidences +
  the JSON-copied and `label=value` forms pass; fabricated values/phrases/2-char fragments
  fail). Live on hvm 3b5063e's parent (684ebfb): multipage 0 refusals; mapsdir's one refusal
  (two genuinely unretried clicks) now carries its `evidence` text on the row.

## 2026-09-15 — fast-runner gate: a missed label is resolved by a later fill in section:<that label>
- **What:** `succeededTargets` (runner.mjs) also returns the SECTION each written field sat in:
  args `section`/`near` (top-level or per field, only for fields not missed; batch steps too)
  and the result's own `filled.section` / `field.section` (`resultSections`, stored on the
  toolLog entry as `sections`). Target comparison is case-insensitive.
- **Why:** recording #4 filled both URI fields with `fast_fill {fields:{"URIs 1": …},
  section:"Authorized JavaScript origins"}` (t=26.4/26.9s, verified) — exactly what the
  section-miss hint says — but the gate matched only the label and refused "your last attempt
  to fast_fill \"Authorized JavaScript origins\" failed and was never retried"; Grok re-filled
  the same values (t=38.4/39.1s), ~10s of turns.
- **Files:** `fast-runner/runner.mjs`, `fast-runner/test/gate.test.mjs` (that log).
- **Watch out:** a fill in the section that MISSED its field resolves nothing.
- **Status:** committed (a30aeb6); gate.test.mjs replays recording #4's log: no unresolved-failure
  refusal after the two section fills; one section filled → the other label still unresolved.

## 2026-09-15 — fast_fill section miss: buttons ranked (add/+ first, help/close icons never named); a section label is a final miss (no auto-wait, no "not rendered yet")
- **What:** page.js, generic. (1) `rankCreateButtons` (module, pure): a section-with-no-input
  miss lists `buttons` by rank — tier 0 an add/new/create/insert/append word (letter/digit
  boundaries, so "Address"/"Renew" do not count) or a "+"/"＋"/"➕" glyph, 1 visible text, 2
  icon-only; DEMOTED below all a help/info/learn more/tooltip/close/dismiss/remove/delete/
  clear/cancel name or an icon-only button with a tooltip attribute / aria-describedby. The hint
  names the top button only when it is not demoted; otherwise it says the field appears after
  another step. (2) `sectionTitleFor(name)`: a heading/legend whose text IS the label (trailing
  ":"/"*"/"(…)" ignored) makes that miss FINAL — `resolveAll`'s 1.5s auto-wait loop no longer
  waits for it; `enrichMiss` then reports `section` + ranked `buttons` (no field in it) or
  `section` + `fieldsInSection` + a `{match, section}` hint (fields in it). Replaces the old
  `includes` heading match. (3) `missHead` (module, pure) builds the top-level hint of every
  miss result (single and `{fields}`): the first EXPLAINED miss's hint (section / select /
  duplicate-with-index / skipped); `settling:true` + "the field may not be rendered yet" only
  when the page is still changing AND an unexplained miss remains (then after the specific
  hint). Replaces the old `settleTail` that led every miss on a busy page.
- **Why:** gcpform recording #4 (relay, grok-4.3, 20:03:03Z f96c8d9c): `buttons:["Help with
  Javascript origins","Add URI"]` and the hint said click the HELP icon; the fill took 6.4s for
  1 fill + 2 section misses (each ran the 1.5s auto-wait) and the head said `settling:true` +
  "fast_wait … then fill again", contradicting the per-field section hint.
- **Files:** `fast-ext/src/actions/page.js`, `fast-runner/test/fill-miss-hint.test.mjs` (new).
- **Watch out:** a label that equals a heading no longer waits even if a field with that exact
  label mounts later (it would have to share the heading's text); a label that only CONTAINS
  a heading word is not a section miss any more (it waits and gets the generic path).
  Follow-up 3b5063e: `calmIfVerified(out, settled)` — a `{fields}` result whose writes held and
  whose misses are all explained also drops the auto-snapshot's own `settling:true`.
- **Status:** committed (a550ef0, 3b5063e); `fill-miss-hint.test.mjs` 3/3; proven live on hvm
  (before 976771f → after 3b5063e). sect.html (help "?" button, aria-describedby tooltip,
  BEFORE "Add email"): before `buttons:["?","Add email"]` + hint "click \"?\"", after
  `["Add email","?"]` + "click \"Add email\"". `{fields}` 1 fill + 2 section misses: quiet page
  1559/1563/1560ms → 46/50/52ms; `?tick=1` (never quiet, like GCP) 2574/2567/2572ms with
  `settling:true` + "may not be rendered yet" head → 26-29ms (one earlier after-run 1046/42/1062ms
  = the auto-snapshot's 1s settle cap), head = the Emails section hint, no settling. Single
  "Emails": 1525ms → 9-18ms, `waitedMs:1`. An unexplained "Zip code" miss still waits 1.5s and
  still gets settling + the generic hint on the ticking page. After "Add email": `fast_fill
  "Emails"` → `section` + `fieldsInSection:[Email 1]` + `{match, section}` hint (was a bare miss).
  jsonforms.io list-with-detail `fast_fill "Users"` (no input, buttons incl. per-row "Delete
  button"): 1622/1550ms → 78/20ms, "Delete button" ranked last; jsonforms.io array `"Comments"`
  (inputs present): 1625ms with no hint → 60ms, `section` + `fieldsInSection` + hint. Open: no
  public page found with a help ICON inside an empty repeatable section (scanned ant.design form,
  rjsf playground (iframe), json-editor, shadcn forms, surveyjs, primefaces); GCP recording #5
  is the first real one.

## 2026-09-15 — fast_fill miss: a select control's name redirects to fast_select_option; a section with no input names the button that creates it
- **What:** page.js `enrichMiss` (single + `{fields}` misses). (1) `selectControlByLabel(m)`: a
  visible select-type control (`DROPDOWN_SEL`: native select, ARIA combobox/listbox, popup
  button, react-select input) whose label / containerLabel / aria-label / placeholder holds the
  name → candidate `{kind:"select", …field}` first in `candidates`, `selectField`, and
  `hint:"\"<label>\" is a select control; use fast_select_option {field:\"<label>\",
  option:\"<choice>\"}"`. Replaces the `[role=combobox][aria-label*=…]`-only lookup (the
  copied-react-select-id path stays). (2) When the name matches an outline section (the
  `section:` resolver) that holds no visible fillable field but does hold button(s): `section`,
  `buttons:[≤5]`, `hint:"\"<label>\" is a section with no input yet; click \"<button>\" in it to
  create the field, then fill it (pass section:\"<heading>\")"`.
- **Why:** gcpform over relay 19:50:07Z (cc84b8b9, grok-4.3): `fast_fill {fields:{"Application
  type", …}}` listed only the page search box as a candidate (4.2s), and "Authorized JavaScript
  origins" / "Authorized redirect URIs" — headings with only an "Add URI" button until clicked —
  missed with "No visible fillable element"; Grok reported both as "(blank)".
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** the section path runs only when no hidden match and no select control explains
  the miss; a heading whose span has buttons but no inputs for another reason (a collapsed
  panel's "Expand") will name that button — the hint says to click it first, which is still the
  right move.
- **Status:** committed (976771f); proven live on hvm. Select redirect: local page "Plan tier"
  (div combobox, aria-labelledby), W3C APG select-only "Favorite Fruit", material.angular.dev
  mat-select "Favorite food" — each a `kind:"select"` candidate + the fast_select_option hint.
  Section: local repeatable-field page `{fields:{Emails}}` → `section:"Emails", buttons:["Add
  email"]` + hint; after the click `section:"Emails"` filled "Email 1". jsonforms.io array
  example with its items deleted: `fast_fill "Comments"` → `section:"Comments", buttons:["Add to
  Comments button"]` + hint (with items present the section holds inputs, so no hint — correct).
  Open, not this change: the inputs jsonforms creates carry no label FastLink resolves
  (`fieldsInSection` lists bare inputs), so `fast_fill {match:"Message", section:"Comments"}`
  still misses — fill by `index:` there.

## 2026-09-15 — fast-runner gate: each missed `{fields}` label / failed batch step is its own failed action
- **What:** `partialFailures(name, args, text)` (runner.mjs): a `fast_fill` result's `fields`
  entries with `error`, and each `fast_batch` step with `ok:false` (plus a batch fill step's
  missed fields) → `[{name, target}]`, stored on the toolLog entry as `partial` (the call itself
  stays `ok:true`). `unresolvedFailures` treats each as a failed ACTION on that label, resolved
  only by a later successful fill / select / batch that acted on it (`succeededTargets`: own
  target + `fields` / `selections` keys + batch step targets, minus that call's own misses). A
  failed single call is now also resolved by a later `{fields}` / batch that filled its target.
- **Why:** cc84b8b9: two `fast_fill {fields}` calls missed "Authorized JavaScript origins" /
  "Authorized redirect URIs", both logged ok:true, so the gate never saw them and "(blank)"
  passed as done.
- **Files:** `fast-runner/runner.mjs`, `fast-runner/test/gate.test.mjs` (that exact log).
- **Watch out:** rows written before this change carry no `partial`; replaying them sees only
  whole-call failures.
- **Status:** committed (b2852ac); `node --test test/*.test.mjs` 28/28.

## 2026-09-15 — hvm bench: 3 passes × six cells on 4584943 (grok-4.3 / phase2) = 177/177
- **What:** `docs/GROK_RUNNER_BENCH_hvm_autocomplete_2026-09-15.md` (rows since 19:49:28Z):
  pass 1 59/59 · 58.6s · 32c, pass 2 59/59 · 42.6s · 27c, pass 3 59/59 · 52.4s · 29c, vs the
  13:48 confirm run (59/59 · 58.6s · 27c, 59/59 · 59.3s · 31c, 58/59 · 54.4s · 32c) and the 14:20
  regression on 53fdb0b (57/59 · 85s · 28c, 57/59 · 70s · 27c). mapsdir 6/6 ×3 (18.6 / 8.6 /
  25.6s): every run's fast_fill carried `uncommitted:[origin, destination]` and the model pressed
  Enter next. staticform 12/12 ×3. Gate: 9 refusals over 18 runs (overlay ×3, flightsearch 1
  read-back + 3 evidence in pass 3 → overridden, mapsdir ×2 for a `fast_wait "route options"`
  that failed AFTER the last action), 0 claimMismatch, 0 overclaims.
- **Status:** doc committed on hvm (c3e7d2a) and pushed.

## 2026-09-15 — fast_select_option: field resolve text-first (no per-candidate document queries / layout), panel wait probes outside the MutationObserver callback
- **What:** page.js, generic (no site selectors). (1) `findField`: the one composed-tree walk
  also collects `<label>`s; `for=` text comes from a per-root map built once (module `labelFor`
  takes an optional `forLookup`); `containerLabel` runs only when a label holding the wanted
  name sits inside the candidate's ≤5-ancestor group; `usableField` (rect + computed style) is
  read only for a candidate whose text already matches. Same pass order (label → aria-label →
  placeholder, controls first) and the same answer as before. (2) `waitForPanel`: mutations only
  SCHEDULE one pending probe (≥30ms out, a macrotask) instead of probing inside the observer
  callback; each probe is the cheap aria-controls/-owns panel (`ariaOptionEls`), the
  document-wide overlay sweep + index options (`sweptOptionEls`) run at most every 250ms; 100ms
  tick kept for shadow-root panels.
- **Why:** GCP recording on 4a25024 (owner's Chrome, grok-4.3 over relay): `fast_select_option
  "Application type"` in a batch took 11.7s — `timing {resolveMs:5574, openMs:2811}`, the
  dropdown closed and idle for ~10s. `labelFor` ran two document-wide `label[for=…]` queries and
  `containerLabel` up to 5 `querySelectorAll('label')` per candidate over thousands of
  `[aria-haspopup]`/`[aria-label]` controls; the panel probe ran the overlay sweep + forced
  layout every 30ms in the middle of the page's render storm.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** a portal panel NOT named by aria-controls/-owns is now found ≤250ms after it
  renders (the sweep cadence), not ≤30ms. A `for=` label is looked up in the control's own root
  then the document, like before.
- **Status:** committed (3a374f7); measured on hvm (timing field, element already mounted):
  GCP-shaped storm page (3000 id'd `aria-haspopup` controls nested 8 deep, 200 two-label
  sections, ~40k nodes, 2000 spans rewritten every 16ms, `aria-controls` set at click, panel
  drawn 150ms later): resolveMs 4294-4407 → 56-83; openMs 266-613 both builds, of which the
  page's own (timer-starved) panel draw is 203-503ms → our detection 31-141ms after the panel
  exists. material.angular.dev mat-select: resolve 19 / open 28ms (771 → 536ms before a wait:
  that was the app still mounting). W3C APG select-only: resolve 1-6 / open 3-13ms (unchanged).
  Light storm page: resolve 32-52 → 14-21ms. GCP itself: lead re-records in the owner's Chrome.

## 2026-09-15 — fast-runner gate wording: "If the task asked you to <verb>, do it now"; system prompt "do every step the task names"
- **What:** the claimMismatch refusal reads `your result says "<verb>" but no <family> call
  succeeded. If the task asked you to <base verb>, do it now; only if it did not, rewrite result
  to say what you actually observed`. `SYSTEM` (shared by every toolset) gains one rule: `Do
  every step the task names, in order, before report_done; if you cannot do a step, say which
  and why in result.` Unit test asserts the "If the task asked you to" text.
- **Why:** cfworkers in the owner's Chrome 19:36:57Z (grok-4.3): refused once for "opened",
  4.3 took the rewrite branch ("fast_tab opened …; snapshot shows Workers list") and never
  drilled in — bench 2/5 with claimedComplete.
- **Files:** `fast-runner/runner.mjs`, `fast-runner/test/gate.test.mjs`.
- **Watch out:** the default toolset's prompt changes by exactly that one rule line.
- **Status:** committed; `node --test test/*.test.mjs`.

## 2026-09-15 — fast-runner gate: a result claiming an action no call performed is refused once (`claimMismatch`)
- **What:** `claimMismatch(toolLog, result)` (runner.mjs) parses only the model's OWN `result`:
  verbs opened|navigated|drilled|went to → needs a fast_click/click_xy/do or a fast_tab/fast_nav
  beyond the first page load; clicked|added|checked → a click; selected|picked →
  fast_select_option / a click / fast_fill (custom dropdowns are picked by clicking, a native
  select can be filled); filled|entered|typed → fast_fill (incl. a `fast_fill_form` batch step)
  / fast_type / fast_fill_vision / fast_do; submitted → a click or `fast_key_press Enter`.
  fast_batch steps (incl. ifFound then/else) count. Not claims: a verb with not/no/never/
  nothing/none/neither/without/n't in the 3 words before it ("Search NOT clicked", "form not
  submitted"), and "opened a (new) tab" when a page load happened. Refused ONCE: `your result
  says "<verb>" but no <family> call succeeded in this run; do it now, or rewrite result to say
  what you actually observed`; the refusal records `claimMismatch`, the next report_done passes
  and the row / `grok_status` carry `claimMismatch:[{verb,family}]`. System prompt: one sentence.
- **Why:** cfworkers over relay 19:28:48Z (fbc16cf2, grok-4.3): fast_tab → fast_wait →
  fast_snapshot, never clicked, result `Worker "fastlink-relay" opened; …` → bench 2/5 with
  claimedComplete; the gate passed it (no failed call, evidence quoted the current URL).
- **Files:** `fast-runner/runner.mjs`, `fast-runner/test/gate.test.mjs`.
- **Watch out:** replayed over every `done` row (hvm 106 + WSL 55 → 154): 1 refusal, fbc16cf2
  only. Word-level: a result that narrates a state ("checkbox: checked") needs a click in the
  run — every such run had one.
- **Status:** committed; `node --test test/*.test.mjs`.

## 2026-09-15 — fast_fill autocomplete follow-up: typing key events after the write; path-only "URL moved"
- **What:** after writing an autocomplete (`isAutocomplete`), fast_fill dispatches the last
  character's keydown/keyup (Backspace for a cleared field) before polling for the popup;
  `INDEX.acPending` compares origin+pathname, not the full URL.
- **Why:** hvm probe on 7f20f26: the W3C APG combobox filters on `keyup`, so `fast_fill "Ala"`
  verified but opened nothing (no suggestions, fast_click "Alabama" missed); Google's search page
  `replaceState`s `?zx=…` after a write, which "settled" the pending record and hid the
  fast_wait hint.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** synthetic key events insert no text; a handler that acts on a bare printable
  keydown would see one extra key.
- **Status:** committed; live proof on hvm below.

## 2026-09-15 — fast_fill reports an uncommitted autocomplete (`committed:false` + suggestions), per field; fast_wait timeout names it
- **What:** one autocomplete path in page.js: `isAutocomplete(el)` (typeable control with
  `role=combobox` on itself or its ARIA-1.1 wrapper, `aria-autocomplete` ≠ none,
  `aria-controls`/`aria-owns`, or `aria-haspopup`; a native `<input list=datalist>` is NOT one),
  `panelOptions(el)` (visible outermost option rows of the popup named by aria-controls/-owns on
  the control, its descendants or its combobox wrapper — shared by `openSuggestions` and
  `suggestionByText`), `openSuggestions(el)` → `{committed:false, suggestions:[≤5, icon-font
  glyphs stripped], hint:"autocomplete is open; pick a suggestion (fast_click its text) or
  fast_key_press Enter, then read back"}` on fast_fill / fast_key_press / fast_click alike.
  (1) **fast_fill** (single + `{fields}`): after writing an autocomplete it polls ≤1.2s for the
  popup (apps open it on a debounce/network round-trip) and captures it BEFORE the next field's
  write moves focus and closes it; each field result carries it, the multi head adds
  `uncommitted:[labels]` + the hint. `verified` stays about the value. (2) Per-page record
  `INDEX.acPending` (last ≤4 autocomplete writes: value + URL at write time); settled by a
  suggestion pick, an Enter/Tab that leaves no list open, a changed live value or a URL change.
  (3) **fast_wait** timeout (text + selector): when the focused / last-filled autocomplete still
  has its list open or its typed value was never accepted, the error carries
  `hint:"\"<field>\" has an open suggestion list|an uncommitted value; submit it (Enter or pick a
  suggestion) before waiting"` + `field` (+ `suggestions`). The bf55fda `suggestions`/hint shape
  (≤6, "a suggestion list is open…") is replaced by this one.
- **Why:** hvm mapsdir 9555f5ff / 3ceec99d (grok-4.3/phase2 on 53fdb0b): `fast_fill {fields:
  {origin, destination}}` returned verified:true for both in 29-228ms — before Maps' debounced
  grid appeared — so no suggestions were reported, the URL stayed /maps/dir///, and both waits
  timed out with `headings:["Delays"]` and no clue (10-25s lost).
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** a fill into an autocomplete whose list never opens now costs up to 1.2s (other
  fields: nothing). The pending record is heuristic (typed value unchanged + same URL): an exact
  typed value accepted by a click on the app's own Go button is still flagged — only on a
  fast_wait TIMEOUT. `commitSuggestion`'s "still open" check uses the same `openSuggestions`.
- **Status:** committed (7f20f26 + follow-up 823a17c); proven live on hvm: **Google Maps
  directions** `fast_fill {fields:{origin,destination}}` → both fields `committed:false`, origin
  `suggestions:["Your location"]`, destination the 5 Times Square rows, head `uncommitted:[both]`;
  a fast_wait timeout then carries `"Destination Times Square, New York" has an open suggestion
  list…` + suggestions; after `fast_key_press Enter` the routes render and a timeout carries no
  hint. **google.com search box** (`role=combobox`, aria-controls) → `committed:false` + 5
  "weather chicago…" suggestions, timeout hint names "Search". **W3C APG combobox-autocomplete-
  list** → `committed:false` + ["Alabama","Alaska","American Samoa","Arizona","Arkansas"]; an
  uncommitted value (list closed) gives the "has an uncommitted value" timeout hint. selenium
  web-form text + datalist fields: no `committed` flag (datalist is not an autocomplete). A fill
  ~350ms after fast_tab on APG opened nothing (page script not attached yet).

## 2026-09-15 — bench scorer: literal `\n` in a report compares as a newline (SCORER CHANGE)
- **What:** `bench/score.js` `reportContains` (every `live` checkpoint) and `runLiveList` read a
  literal `\n` / `\r\n` / `\r` as a newline on both sides before `norm()` folds whitespace.
  `reportContains` is exported; `fast-runner/test/score-report.test.mjs` (new).
- **Why:** staticform run fdc1ed25 (grok-4.3/phase2, 11/12): the model reported the textarea as
  `Multi-line\ntext here` (copied JSON-escaped from the tool result) and "reported the live
  textarea value" failed against the real newline.
- **Files:** `bench/score.js`, `fast-runner/test/score-report.test.mjs`.
- **Watch out:** comparability: only runs that failed a text checkpoint through an escaped
  newline score differently from earlier runs; everything else is unchanged.
- **Status:** committed; unit test.

## 2026-09-15 — fast-runner gate: a failed read/wait is resolved by a later action + read
- **What:** `unresolvedFailures` (runner.mjs): a failed READ/WAIT call (`fast_wait` or any
  `READ_TOOLS` tool — fast_snapshot, fast_text, …) is resolved by a later successful
  state-changing call followed by a successful read. A failed ACTION (click/fill/select/key/
  batch) still needs a retry on the same target (or another tool on it). New case in
  `test/gate.test.mjs`.
- **Why:** mapsdir run 9555f5ff was refused for `fast_wait "min" failed and was never retried`
  although the model had since pressed Enter and read the routes page (3ceec99d the same for
  `"route options"`).
- **Files:** `fast-runner/runner.mjs`, `fast-runner/test/gate.test.mjs`.
- **Watch out:** a failed read that was followed by ANY action + read counts as resolved even if
  the action was unrelated — the evidence/URL checks still guard the report itself.
- **Status:** committed; `node --test test/*.test.mjs`.

## 2026-09-15 — toolset test: 45 server tools (fast_ext_reload), asserted absent from phase2 / no-cdp
- **What:** `fast-runner/test/toolset.test.mjs` `TOOLS.length` 44 → 45 plus: `fast_ext_reload`
  is on the server (default `"*"` toolset exposes it) and is NOT in the phase2 or no-cdp tool
  lists (phase2-eval inherits phase2's allow list, already asserted equal + `fast_evaluate`).
- **Why:** the new INTERNAL ops tool broke the hard-coded count; the Grok toolsets must never
  offer it.
- **Files:** `fast-runner/test/toolset.test.mjs`.
- **Status:** committed; `node --test test/toolset.test.mjs` 7/7.

## 2026-09-15 — Passive URL trail: extension records tab URL changes, `fast_list` returns `trail`, bench polls 3s instead of 500ms
- **What:** new `fast-ext/src/actions/trail.js`: `chrome.tabs.onUpdated` URL changes are
  stamped `{t,url}` into a per-tab ring (≤50, deduped when unchanged, dropped on `onRemoved`,
  persisted in `chrome.storage.session` so a service-worker restart keeps it); `installTrail()`
  runs at `background.js` top level. `listTabs` (tab.js) adds `trail:[{t,url}]` to every tab
  that has one. `bench/monitor.js`: `mergeTrail(list, events, seen)` (pure) reconstructs the
  stops from the timestamps; `TrailWatcher` keeps a `(tabId,t,url)` seen-set, the first poll is
  the baseline, `.trail` is the ordered URL list `score.js` already consumes; a tab without a
  recorded change contributes its current URL. `DEFAULTS.trailPollMs` 500 → 3000. Tool
  description updated in `fast-dxt/server/tools.js` + `fastlink-relay/tools.js`.
- **Why:** the 500ms poll (entry "bench trail poll 3s → 0.5s") put a `fast_list` through the
  same service worker every half second while GCP was storming — the "Listing tabs" flood in
  the panel during the gcpform recording — and a sampled trail still could not prove a stop
  shorter than the poll. Timestamps make the 3s poll lossless.
- **Files:** `fast-ext/src/actions/trail.js` (new), `fast-ext/src/actions/tab.js`,
  `fast-ext/background.js`, `bench/monitor.js`, `fast-dxt/server/tools.js`,
  `fastlink-relay/tools.js`, `fast-runner/test/trail.test.mjs` (new).
- **Watch out:** STUCK / NO_ACTIVITY / FINISHED still come from the tool trace, not the trail.
  Entries are stamped with the browser's clock. Trails start when the service worker installs
  the listener — tabs opened before that show only later changes.
- **Status:** committed; unit tests (ring + reconstruction of a 2s stop between 3s polls).
  Live multipage bench cell pending the extension reload (the lead ships the Windows copy).

## 2026-09-15 — fast_select_option: generic ARIA open chain (click → ArrowDown → Enter, observer-waited), control-only field lookup, readback-confirmed pick, `timing`
- **What:** page.js `fast_select_option` generic branch, ARIA contract only (no framework
  selectors): (1) `findField` label/aria/placeholder passes consider only VISIBLE control-like
  elements (`select/input/textarea/[role=combobox|listbox|textbox|searchbox]/[aria-haspopup]/
  contenteditable`) first, then aria-labelled custom widgets, never a landmark/container role —
  one composed-tree walk instead of three. (2) Trigger = the field when it is the
  combobox/popup button, else its first such descendant. When no panel is open (visible options
  in the `aria-controls`/`aria-owns` panel or an overlay, or index options while the trigger
  says `aria-expanded=true`) the chain is: pointer/mouse/click sequence on the trigger →
  `ArrowDown` → `Enter` (skipped on text inputs and on a trigger already claiming expanded),
  each followed by `waitForPanel` — a MutationObserver on the document (attribute filter
  aria-expanded/-controls/-owns/hidden/style/class, ≥30ms between probes) plus a 100ms
  fallback tick for shadow-root panels, wall-clock capped (1500 / 600 / 600ms). Result carries
  `opened:"already"|"click"|"ArrowDown"|"Enter"`; when nothing opened the call returns at once
  with `opened:false`, `triedOpen:[…]` and a hint — no 3s option poll. (3) Options are
  visible-only (a closed APG listbox keeps `display:none` options in the DOM). (4) `withReadback`
  polls the control's read-back every 30ms and returns the moment it shows the pick (cap 1s)
  instead of a fixed DOM-quiet wait; a verified pick's auto-snapshot settles 150ms, not 1s
  (`withSnap(result, pre, {settleMs})`). (5) Every result carries
  `timing:{resolveMs, openMs, pickMs, readbackMs, snapshotMs}` (performance.now marks).
- **Why:** gcpform cell on grok-4.3 (18:51Z): `fast_select_option "Application type"` took 8.8s
  and failed "no listbox detected" — `findField` had matched GCP's hidden "Skip links"
  `[aria-label]` div (its containerLabel held the text), so the click opened nothing and the
  panel search ran the full budget under the render storm; after a plain `fast_click` opened
  the real `cfc-select`, the retry took 6.7s (settle 1s + snapshot settle 1s + storm) and read
  back the wrong element. Owner rule: works on every site, nothing keyed to GCP/Material.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** the react-select branch keeps its own mousedown open path (+250/400ms fixed
  waits); `Enter` is deliberately not sent to a trigger that already reports expanded (it would
  commit the highlighted entry of a list we cannot see). `mat-option`/`cfc-option` tags left the
  option selector — both carry `role=option`. Timings below are in-page; the bridge/broker add
  their own.
- **Status:** committed; `fast-runner` tests pass; verified live (hot-loaded page.js) on
  w3.org APG select-only combobox (opened:click, resolve 2 / open 1 / pick 0 / readback 0 /
  snapshot 154 ms, verified), ng-matero.github.io Angular Material `mat-select` (Pokemon,
  Colors: open 3–17 / readback 30 / snapshot 141 ms, verified), react-select.com "Single"
  (open 683 / readback 0, verified), native selects on selenium.dev web-form and the Bootstrap
  checkout example (≈0 ms), and the `opened:false` path on a text input (2.2s, nothing changed).
  material.angular.dev itself could not be hot-loaded (CSP `default-src 'self'` blocks fetch +
  eval) — the lead's post-reload GCP re-run covers `cfc-select`.

## 2026-09-15 — fast_fill REFUSES a label that matches several fields (candidates + section/index hint) instead of writing the first
- **What:** `fast_fill` (single and `{fields}`; page.js `resolveAll`): when a match resolves to
  >1 fillable element and neither `section`/`near` nor `index` picks one, the field is NOT
  written: `{error:"2 visible fields match \"URIs 1\" — nothing was filled", candidates:[{label,
  section, value, empty, index, offscreen?}], hint:"pass section:\"…\" | \"…\" or index:N"}`.
  In `{fields}` mode the other fields still fill and the refused one lands in `missed`/`fields`
  with the same shape. `section` per candidate = the deepest outline title the other candidates
  do not all share (module-scope `outlineTitles` + `distinguishingSections`, pure, unit-tested):
  GCP's two "URIs 1" rows both sit under an `<h3>Item 1</h3>`, so the `<h2>` above each is
  named — and that name is exactly what `section:` resolves. A top-level `index` is now the
  default for every `{fields}` entry (the bench run passed `{fields:{"URIs 1":…}, index:1}` and
  it was ignored). An ambiguous match is final (no 1.5s "still mounting" retry).
- **Why:** gcpform cell on grok-4.3 (runs.jsonl 18:51:03Z, frames 11/12): after two "Add URI"
  clicks `fast_fill {fields:{"URIs 1": ".../callback"}}` silently matched the first "URIs 1"
  (Authorized JavaScript origins), overwrote the origin with the callback URL ("Invalid Origin")
  and reported `verified:true`. Same class as the 2026-08-06 `section:` bug: a silent wrong-field
  write is worse than an error.
- **Files:** `fast-ext/src/actions/page.js`, `fast-runner/test/fill-ambiguity.test.mjs` (new).
- **Watch out:** a loose substring that hits several fields ("name" → First name / Last name /
  Name on card) now refuses too — the candidates list carries the exact labels to retry with.
  Structural only: N matches + the outline resolver; no site-specific selectors.
- **Status:** committed; unit test (synthetic GCP-shaped outline); verified live via a hot-loaded
  page.js on a local two-heading page (refusal → `section:` and `index:` each wrote the right
  input) and on getbootstrap.com/docs/5.3/examples/checkout ("name" → 4 candidates with
  sections Billing address / Payment; "Email" still fills).

## 2026-09-15 — No-click extension ship: `scripts/ship-ext.sh` (sync → build stamp → `fast_ext_reload` → build check)
- **What:** `scripts/ship-ext.sh` ships git HEAD, not the working tree (other sessions keep WIP
  in `fast-ext/`; commit to ship): `git archive HEAD fast-ext` → temp stage, stamps
  `build.json` `{sha, syncedAt}` (HEAD short sha) into the stage and the repo tree (gitignored),
  rsyncs the stage to the Windows copy (`--delete`), then through a stdio MCP server (`fast-runner/fastlink-client.mjs`, local
  transport) pins `fast_profile {install:$SLOT}` (default `primary`), calls `fast_ext_reload`,
  and polls `fast_status` until `installs.$SLOT.build == sha` (≤30s) → `PASS`/`FAIL` (exit 1).
- **Why:** shipping a build into the owner's real Chrome required them to open
  `chrome://extensions` and click Reload; nothing broker-reachable existed (entry below).
- **Files:** `scripts/ship-ext.sh` (new), `.gitignore`, `CLAUDE.md` (untracked), `CHANGELOG.md`
  header, `docs/GROK_RUNNER_PLAN.md` (pick-up line replaced).
- **Watch out:** the running broker must be on the ext-reload build — an older broker forwards
  `fast_ext_reload` to the extension as a page action and the script prints a restart hint.
  Never point `SLOT` at the relay-connected `secondary` profile (another session's).
- **Status:** committed. Live run against the owner's Chrome: FAIL as expected — the running
  primary worker is the pre-change build (hello has no `build`, no `{type:'reload'}` handler),
  so `fast_ext_reload` → `reloaded:false` after 20s. **Needs ONE manual Reload at
  chrome://extensions (bootstrap)**; every ship after that is no-click. The extension refuses
  its own `chrome-extension://` pages (`Restricted URL`), so the popup's Reload button is not
  broker-clickable either.

## 2026-09-15 — Broker `ext-reload` + `fast_ext_reload` (INTERNAL): reload the pinned profile's extension and wait for its hello
- **What:** MCP call `{type:'call', action:'fast_ext_reload', install}` is handled by the broker
  itself (`mcpBridge.js` → `router.js dispatchReload`): refused unless the envelope pins ONE
  label (unpinned / `"auto"` → `error`), else sends `{type:'reload'}` on that slot's socket,
  marks it `__closeReason='reload requested (fast_ext_reload)'`, and `state.awaitHello(label,
  20s)` answers `{result:{reloaded:true, install, build, previousBuild, ms}}` on the next hello
  from the same label or `{result:{reloaded:false, reason, previousBuild, ms}}` on timeout.
  Tool `fast_ext_reload` in `fast-dxt/server/tools.js` (no handler change — the generic
  `callExtension` path carries it). Log lines: `ext-reload install= sent`, `… back in <ms>
  build=`, `… no hello within`.
- **Why:** the only reload paths were the toolbar click, the options-page relay-reconnect
  message and updateCheck's 6h GitHub-release check (housekeeping entry below).
- **Files:** `fast-dxt/broker/router.js`, `mcpBridge.js`, `state.js`, `fast-dxt/server/tools.js`,
  `fast-dxt/test/broker.test.mjs`.
- **Watch out:** local broker only — NOT added to `fastlink-relay/tools.js` (the mirror already
  differs at `fast_upload`, deliberately relay-worded, so the byte-identical condition did not
  hold; the relay never lists a tool it would refuse). Hidden from the Grok toolsets
  (`toolset.phase2`/`no-cdp` allow lists); `toolset.json`'s `"*"` still exposes it. Takes
  effect after a broker restart + MCP restart.
- **Status:** committed; unit + throwaway-broker tests (`npm test` in `fast-dxt/`). Live broker
  restarted onto it 19:05Z (log: `hello install="primary" … build=n/a`, `ext-reload
  install="primary" sent (build n/a)`, `… no hello within 20000ms` against the old worker).

## 2026-09-15 — Extension: build id in the hello (`installs.<label>.build`) + ONE `reloadSelf(reason)` in the service worker
- **What:** (1) `src/reloadSelf.js` — the single `chrome.runtime.reload()` path; appends
  `{at, reason}` (last 20) to `fastlinkSelfReloadLog` first. Callers: updateCheck
  (`'update'`), broker `{type:'reload'}` (`'broker'`, connection.js), toolbar-click fallback
  and relay-reconnect (background.js). updateCheck's circuit breaker now counts only
  `reason:'update'` entries (a dev shipping 3 builds in 10 min is not a loop); the 6h GitHub
  check itself is unchanged. (2) `connection.js` reads `build.json` `{sha}` once per worker
  (`fetch(chrome.runtime.getURL('build.json'))`; absent → `"dev"`) and sends
  `{type:'hello', installId, build}`. Broker `extBridge.js` sanitizes it (`[A-Za-z0-9._-]{1,40}`),
  logs `hello … build=<sha>` / `connect … build=<sha>`, `state.js` keeps it per slot →
  `snapshot().installs.<label>.build` → `fast_status`.
- **Why:** verifying which build a profile runs needed the chrome://extensions page; the
  reload calls were scattered and the breaker log held bare timestamps.
- **Files:** `fast-ext/src/reloadSelf.js` (new), `src/updateCheck.js`, `src/connection.js`,
  `background.js`, `fast-dxt/broker/extBridge.js`, `state.js`, `fast-dxt/test/broker.test.mjs`.
- **Watch out:** `background.js handleSelfReloadResult` still wipes the whole
  `fastlinkSelfReloadLog` after a successful GitHub update (broker entries go with it —
  diagnostic only). popup.js / onboarding.js reload from page context and keep their direct
  `chrome.runtime.reload()`. The packaged zip (`fast-ext/scripts/package.sh` allowlist) carries
  no `build.json` → reports `"dev"`.
- **Status:** committed; broker side unit-tested; Windows copy synced to HEAD. Extension side
  unverified live until the one-time bootstrap Reload (entry above).

## 2026-09-15 — fast-runner: evidence gate checks the current URL + unretried failures
- **What:** `runner.mjs` tracks `urlTrail` (distinct `url`s carried by tool results —
  fast_tab/nav/click/snapshot/wait or their auto-snapshot) and tags every corpus entry
  with the URL it was read on. `report_done` now also refuses when (2) the evidence
  quote comes from a result read on an earlier URL than the last-seen one, and (3) a
  failed call was never followed by a successful one of the same intent (same tool +
  `text`/`field`/`match` target, or another tool on that target) — refused once
  ("your last attempt to fast_click "x" failed and was never retried; retry it or
  explain in `result` why it is not needed"); the next `report_done` passes but the
  row records `unresolvedFailures:[{name,target,t}]`. Rows and `grok_status` carry
  `urlTrail`. System prompt: one added sentence about unretried failures. Tests moved
  to `test/gate.test.mjs` (5 tests, synthetic tool logs).
- **Why:** cfworkers runs ae2428fc / d5c9ab8e (grok-4.3, phase2): the click into the
  "fastlink-relay" Worker failed (`role:"a"`) and was never retried, yet `report_done`
  passed because the evidence quoted a fresh `fast_text` of the list page — bench
  scored 2/5 with `claimedComplete=true`.
- **Files:** `fast-runner/runner.mjs`, `fast-runner/README.md`, `fast-runner/test/gate.test.mjs`,
  `fast-runner/test/toolset.test.mjs`.
- **Watch out:** the failure check is intent-based, not task-based — a disabled
  `fast_evaluate` that the model correctly abandoned also costs one refusal (then is
  flagged, not blocked). Corpus entries are now `{text,url}` objects. A URL only enters
  the trail from a result's top-level `url` or `snapshot.url`; `fast_text` carries none
  and inherits the last-seen URL.
- **Status:** in code / tests pass / committed.

## 2026-09-15 — Broker: ext listeners bind 0.0.0.0 only under WSL (loopback elsewhere), `FASTLINK_BROKER_BIND` override
- **What:** `broker/config.js` `resolveExtBind(env, procVersion)` → `FASTLINK_BROKER_BIND`
  if set, else `0.0.0.0` when `/proc/version` mentions microsoft/WSL, else `127.0.0.1`;
  `extBridge.js` binds `EXT_BIND.host` and logs `ext listeners bind <host> — <reason>`
  at startup (mcp port 9870 was already loopback).
- **Why:** 0.0.0.0 is needed only on WSL (Windows Chrome dials the VM IP when
  localhost-forwarding breaks); on the hvm rig / a container it exposed an
  unauthenticated browser bridge to the LAN — frontdesk found hvm's broker on
  0.0.0.0:9876/9877.
- **Files:** `fast-dxt/broker/config.js`, `extBridge.js`, `fast-dxt/test/broker.test.mjs`.
- **Watch out:** a non-WSL host that genuinely needs remote extension access must set
  `FASTLINK_BROKER_BIND=0.0.0.0` explicitly. Needs a broker restart on hvm after its
  bench run (WSL broker pid 38706 is on the prior commits and stays 0.0.0.0 anyway).
- **Status:** committed; unit test for the resolver + throwaway broker checked with `ss`.

## 2026-09-15 — `fast_profile` description: pin required on the local broker when >1 profile is connected
- **What:** one sentence added to `fast_profile` in `fast-dxt/server/tools.js` and the
  `fastlink-relay/tools.js` mirror (kept byte-identical): with more than one local
  profile connected, every tool except fast_status/fast_profile errors until the
  connection pins a label or "auto"; "auto" = most recent browser (relay) / active
  slot (local).
- **Why:** the broker now refuses unpinned calls in that state (entry below); the
  description said calls "go to the most recently connected browser".
- **Files:** `fast-dxt/server/tools.js`, `fastlink-relay/tools.js`.
- **Watch out:** relay routing unchanged; wording only. Needs `wrangler deploy` for
  the relay and an MCP restart / `.mcpb` rebuild locally.
- **Status:** committed (7219ab7).

## 2026-09-15 — Broker: an unpinned MCP session is REFUSED while >1 profile is connected (no more silent landing on the owner's main profile)
- **What:** `broker/router.js` `resolveSocket`: envelope `install` = label → that slot
  only (unchanged, BUG-5); `"auto"` → ACTIVE-then-any-connected (only when a session
  EXPLICITLY pinned "auto"); absent → one slot connected: use it; >1 connected:
  `{error:"2 Chrome profiles are connected (primary, work) and this session has not
  pinned one — call fast_profile {install:"<label>"} first (or install:"auto" …)",
  connectedInstalls, installs}` — mirrors the pinned-but-offline error.
  `server/brokerClient.js` now sends `install:"auto"` only after an explicit
  `fast_profile "auto"` (`explicitAuto`); a fresh session sends no `install`.
  `state.snapshot()` adds `connectedInstalls:[…]` + `pinRequired:boolean`
  (`routedInstall` still names the "auto" target). `fast_status` / `fast_profile`
  never go through the router, so they stay callable unpinned.
- **Why:** today a second session's first calls landed on the owner's main profile
  before it called fast_profile — `getExtensionSocket()` picked ACTIVE for any
  unpinned call.
- **Files:** `fast-dxt/broker/router.js`, `state.js`, `fast-dxt/server/brokerClient.js`,
  `fast-dxt/test/broker.test.mjs` (new), `docs/BUG-5-multi-install-routing.md`.
- **Watch out:** takes effect only after the running broker AND the MCP server restart
  (an OLD broker answers `install:"auto"` with "Unknown install"; a NEW broker with an
  old server still refuses unpinned sessions correctly). `handlers.js` `statusReport`
  hint still says "calls default to <routedInstall>" when >1 slot is connected — it
  should say calls are refused until `fast_profile`. Single-profile setups see no change.
- **Status:** committed (8498cbe); `npm test` in `fast-dxt/` (router unit test +
  throwaway broker on 19870/19876/19877).

## 2026-09-15 — Broker: durable log file + per-slot connection history (`recent[]`) in `fast_status`
- **What:** (1) `broker/lifecycle.js` `log()` appends every line to
  `os.tmpdir()/fastlink-broker.log` (`/tmp/fastlink-broker.log` under WSL; ISO
  timestamp per line; truncated when it passes 5 MB) and echoes to stderr only on a
  TTY; `server/brokerClient.js` spawns the broker with stdout/stderr on that same
  file (was `stdio:'ignore'`) so crash stacks land there too. `extBridge.js` logs
  `hello install= raw=`, `connect install= reason=` (hello / no-hello-default /
  replaced stale socket), `slotBusy install=`, `disconnect install= reason=`
  (close code+text, `heartbeat timeout`, `replaced by respawn`, `slotBusy`).
  (2) `broker/state.js` keeps per slot the last 20
  `{t:ISO, event:'connect'|'disconnect'|'slotBusy', reason}` (newest first) and
  `snapshot()` exposes it as `installs.<label>.recent` — what `fast_status` returns.
  (3) New `broker/config.js` owns the ports + pid/log paths: `FASTLINK_BROKER_PORT`
  (mcp, same var the server reads) and `FASTLINK_EXT_PORTS="9876,9877"` give a
  throwaway broker for tests — a non-default mcp port suffixes the pid/log files
  (`fastlink-broker-<port>.*`) and skips the cloudflared tunnel. `EXT_PORTS` moved
  out of state.js.
- **Why:** today's investigation could not date 7 reconnects — the broker had no
  record (stderr of a detached `stdio:'ignore'` child), and lifetime
  `totalConnections=7` was misread as "7 in ten minutes".
- **Files:** `fast-dxt/broker/config.js` (new), `lifecycle.js`, `state.js`,
  `extBridge.js`, `heartbeat.js`, `mcpBridge.js`, `tunnel.js`,
  `fast-dxt/server/brokerClient.js`, `fast-dxt/package.json` (`npm test`).
- **Watch out:** the RUNNING broker (pid from `pgrep -af broker/index.js`) keeps the
  old code until restarted — restart only when no bench cell is running and both
  profiles' sessions are idle. The log is shared by every broker instance on the
  machine (one file, append); a foreground run still prints to the terminal.
- **Status:** committed (e0ee7eb); `fast-dxt/test/broker.test.mjs` proves log lines
  + `recent[]`.

## 2026-09-15 — Suggestion picks are verified (keyboard first, coords for fast_click_xy on refusal); synthetic keys carry keyCode; fast_wait keeps its own deadline
- **What:** (1) `commitSuggestion` (page.js): ArrowDown×(index+1) + Enter on the input,
  then pointer/mouse events on the entry; `committed` = value/URL changed or the list
  closed. A pick the control ignores is now an ERROR carrying `suggestion:{text,x,y,w,h}`
  + hint "fast_click_xy at x,y (trusted click) commits it" — never a false `clicked`.
  (2) `keyInit` adds legacy `keyCode`/`which` to every synthetic KeyboardEvent
  (`fast_key_press` + the suggestion commit): Google's widgets switch on keyCode, so an
  ArrowDown without it was a no-op. (3) `runBridge` (index.js): the 20s page-action
  deadline is `max(20s, timeoutMs+3s)` capped at 28s for `fast_wait` — a 30s wait was
  cut at 20s with "page busy".
- **Why:** batch-build iteration 4 (57/59, mapsdir 5/6 in 19 calls / 94s): the mouse-
  event suggestion pick returned `clicked` while Maps ignored it, and two waits hit the
  new deadline.
- **Files:** `fast-ext/src/actions/page.js`, `fast-ext/src/actions/index.js`.
- **Status:** committed; verified on the hvm rig after the 4.6 control pass (below).

## 2026-09-15 — fast_click reaches open suggestion-list entries; fast_status says when a pin is required
- **What:** `fast_click` whose text matches no index entry looks in the OPEN suggestion
  list of the focused control (`aria-controls`/`aria-owns` panel: `[role=option|row|
  menuitem|treeitem]`, visible, exact > startsWith > substring) and commits it with a
  mousedown/mouseup/click sequence — result `clicked:{tag,role,text}, fromSuggestions:true,
  url, urlChanged, focused` + snapshot. `statusReport` (handlers.js): with the broker's
  `pinRequired:true` the hint reads "Multiple Chrome profiles connected (a, b); calls are
  refused until this session pins one with fast_profile {install:\"<label>\"|\"auto\"}"
  (uses `connectedInstalls`).
- **Why:** batch-build iteration 3 (56/59): mapsdir 4/6 — the new `suggestions` hint
  named "Times Square New York, Manhattan, NY", but Maps' rows are `role=row` divs in a
  `role=grid`, not index entries, so six clicks on that text missed (3 consecutive
  errors). Broker fixer's pin-required routing (8498cbe) needs the matching status line.
- **Files:** `fast-ext/src/actions/page.js`, `fast-dxt/server/handlers.js`.
- **Status:** committed; hvm iteration 4 below.

## 2026-09-15 — Open suggestion lists are reported (`suggestions` + hint) on fast_key_press / fast_fill; bench trail poll 3s → 0.5s
- **What:** `openSuggestions(el)` (page.js): when the active/written control names an
  open panel via `aria-controls`/`aria-owns` (Google Maps' `role=grid` of rows, ARIA
  listboxes, menus) the result carries `suggestions:[…≤6]` + `hint: "a suggestion list
  is open — the value is not committed until one entry is chosen: fast_click its text
  (or ArrowDown then Enter)"`. `fast_key_press` adds it for the focused element,
  `fast_fill` for the written field (per field in the `fields` form).
  `bench/monitor.js` `trailPollMs` 3000 → 500.
- **Why:** batch-build iteration 2 (57/59): mapsdir 5/6 — 4.3 pressed Enter in the
  destination box, Maps opened its suggestion grid instead of routing, and the model
  reported "route options" from the suggestions; multipage 5/6 was the 3s trail poller
  missing a ~2s stop on the Travel page (tools were right; the run is just faster now).
- **Files:** `fast-ext/src/actions/page.js`, `bench/monitor.js`.
- **Status:** committed; hvm iteration 3 below.

## 2026-09-15 — Select hints skip autocompletes; ARIA select resolves options via aria-controls under a wall clock; page-action deadline
- **What:** (1) `selectControlOf` (page.js) no longer treats a typeable input inside a
  `[role=combobox]` wrapper as a select control — Google Maps' search boxes carried
  `hint: use fast_select_option {field:"sb_ifc50"}` on a VERIFIED fill and 4.3 followed
  it into a dead end (batch-build iteration 1, mapsdir 4/6 → 3 consecutive errors);
  a successful `fast_fill` only hints when the written element is a react-select input.
  (2) `fast_select_option`'s generic ARIA branch resolves options synchronously on every
  look from the panel named by `aria-controls`/`aria-owns` (on the field, its inner
  combobox/input or a `[aria-haspopup]` child — mat-select / cfc-select set it), then the
  overlay sweep, then `INDEX.options`; the budget is WALL CLOCK checked after every wake
  (a starved 50ms timer on GCP's Angular storm used to run 10–30s past the 3s budget),
  and a miss reports `elapsedMs`, `panelIds`, `starved:true` + hint. `ariaPanelIds` is a
  pure module-scope helper unit-tested against a fake DOM (`fast-runner/test/aria-options.test.mjs`
  slices it out of page.js). (3) `runBridge` (index.js) races `executeScript` against a
  20s deadline and returns `{error:"page busy", phase, elapsedMs, hint}` — a stuck
  in-page script no longer outlives the 30s call timeout and queues the next call.
- **Files:** `fast-ext/src/actions/page.js`, `fast-ext/src/actions/index.js`,
  `fast-runner/test/aria-options.test.mjs` (new).
- **Watch out:** the deadline does not stop the in-page script; it only frees the caller.
  GCP `cfc-select` cannot be verified on hvm (no login) — owner's Chrome cell pending.
- **Status:** committed; unit tests pass; hvm iteration 2 below.

## 2026-09-15 — Batching is the default form path: `fast_batch` never aborts + `ifFound`, `fast_fill {fields}` absorbs `fast_fill_form`, `fillable:N` nudge, select-control hints, offscreen matching, `fast_wait` selector / emptyContainer / text+idle
- **What:**
  1. **`fast_batch`** (new shared `fast-dxt/server/batch.js`, mirrored byte-for-byte at
     `fastlink-relay/src/batch.js`; handlers.js + relay mcp.js only wire `call`/`gate`):
     every step runs (no abort, `continueOnError` gone); the result LEADS with
     `summary` ("5/6 steps ok; step 3 (fast_fill "Ocean") missed: …"), then per-step
     `{step,name,ok,result}` (verified state) or `{ok:false,error,candidates,hint…}`;
     only the LAST step keeps its `snapshot` (intermediate steps run `noSnapshot:true`
     unless they set it); conditional steps `{ifFound:"<text>|<css selector>",
     then:[…], else:[…], waitMs}` are decided in the batch with one `fast_wait` probe
     (a selector = string starting with `# . [ :` or containing `>`/`[`); steps naming
     `fast_fill_form` are rewritten to `fast_fill`. BUG-2 nav settle unchanged.
  2. **`fast_fill {fields:{label: value|{value,index,section,name,exact,append}}}`**
     replaces `fast_fill_form` (deleted from page.js, tools.js, relay mirror, manifest,
     toolsets, runner sets, ext UI maps; fill_vision's DOM fallback now calls
     `fast_fill {fields}` and reads `.fields`). Single and multi share one resolver
     (exact-first match, section scoping, index, 1.5s auto-wait for the whole set).
     Multi result: `{verified, filled, missed, summary?, fields:{label:{verified,value,…}},
     snapshot}`; misses carry `candidates` / `hiddenMatches` / `offscreenMatches` / hint.
  3. **Batching nudge in data:** `serializeSnapshot` counts EMPTY visible fillable
     fields (`fillable:N`, near the top of every snapshot / auto-snapshot) and when
     N ≥ 2 adds `hint: "N empty fillable fields visible; fill them in one fast_fill
     {fields:{label:value}} or one fast_batch"`. Descriptions (tools.js, phase2,
     phase2-eval, no-cdp, runner system prompt) say the same in one sentence.
  4. **Select-control hints:** `fast_click` / `fast_fill` whose target (or hidden
     match) is a native select, a react-select input/control/value chip/"Remove X"
     button, or an ARIA combobox return `hint` + `selectField` naming the field for
     `fast_select_option`; a click miss on a heading that titles a dropdown ("Single")
     says so too.
  5. **Offscreen matching:** click/fill match pools are built with `matchAll` (offscreen
     interactive entries kept, tagged `offscreen:true`, even when a heavy page forces
     viewport-only); the chosen target is `scrollIntoView`ed first
     (`scrolledIntoView:true`); index-out-of-range / miss reports list every match with
     `offscreen` + `section`. `fast_select_option` scrolls its field into view.
  6. **`fast_click` role aliases:** `role:"a"` = link, `"button"`/`"input"`/… match the
     tag; a role mismatch returns `available` with real role/tag + a hint.
  7. **`fast_wait`:** `selector` mode (first VISIBLE match); a content hit whose text is
     gone from the live DOM (stale index entry) or whose element has no visible box
     keeps polling and, at the deadline, returns `found` + `emptyContainer:true` + hint
     instead of a false "found"; `text`/`selector` + `networkIdle:true` resolves on the
     text and reports `networkIdle`/`pending` (index.js) — only a bare networkIdle wait
     times out (Cloudflare long-polls forever).
  8. **Calm verified results:** a `verified:true` fill / select drops the generic
     "page was still changing" `settling`/hint (GCP fills carried it on every call).
- **Why:** this morning's 4.3/phase2 hvm pass (57/59 · 98s · 60 calls): staticform =
  11 field-by-field calls, flightsearch 11 (the phase2-eval run did the same form in
  ONE 7-step batch → 4 calls), overlay 1/3 after 14 misses circling a react-select
  ("Ocean" → Remove chip, fill on react-select-8-input, click on heading "Single");
  afternoon gcpform 5/6 (second "Add URI" offscreen → "index 1 out of range" → redirect
  URI written into a JS-origins row), cfworkers overclaim after `role:"a"` refused the
  links it listed and a 10s networkIdle timeout.
- **Files:** `fast-dxt/server/batch.js` (new), `fastlink-relay/src/batch.js` (mirror),
  `fast-dxt/server/handlers.js`, `fastlink-relay/src/mcp.js`, `fast-dxt/server/tools.js`,
  `fastlink-relay/tools.js`, `fast-dxt/server/transports.js`, `fast-dxt/manifest.json`,
  `fast-ext/src/actions/page.js`, `fast-ext/src/actions/index.js`,
  `fast-ext/src/actions/waitIdle.js`, `fast-ext/background.js`, `fast-ext/sidepanel.js`,
  `fast-ext/src/overlay.js`, `fast-runner/runner.mjs`, `fast-runner/toolset.phase2.json`,
  `fast-runner/toolset.phase2-eval.json`, `fast-runner/toolset.no-cdp.json`,
  `fast-runner/test/toolset.test.mjs`, `fast-runner/test/batch.test.mjs` (new),
  `bench/suite.js`.
- **Watch out:** `fast_fill_form` no longer exists anywhere — a batch step naming it is
  rewritten, a direct call is an unknown action. Multi-fill results key on `fields`, not
  `results`. `fillable` counts EMPTY fields only (checkbox/radio/button/file excluded), so
  a filled form stops nudging. `matchAll` only affects the internal match pools; model-
  facing snapshots keep their viewport/cap rules. `selectControlOf` climbs ≤8 ancestors
  for a class token ending in `control` — never `container` (bootstrap page wrappers).
  Relay NOT deployed; Windows extension copy NOT synced.
- **Status:** committed; unit tests (`fast-runner`: 14 files incl. batch + aria-options);
  hvm bench `docs/GROK_RUNNER_BENCH_hvm_batch_2026-09-15.md` (rows since 18:16:53Z):
  4.3/phase2 iterations 1–4 = 57/59 (29c·57s), 57/59 (30c·45s), 56/59 (33c·67s),
  57/59 (42c·128s) vs this morning 57/59 · 98s · 60c; the remaining miss was always
  mapsdir (Maps ignored synthetic Enter/ArrowDown without keyCode) — pass 7 mapsdir-only
  on the keyCode build = 6/6 · 7c · 19s. Best full pass composed = 59/59 · ~36 calls ·
  ~65s. 4.6/phase2 control (pass 6) = 59/59 · 38c · 95s. Batch/fields usage per cell
  (4.3, iteration 2): staticform 1 batch (fill{fields}+select+2 clicks), flightsearch 1
  batch (fill{fields} of 5 + select), mapsdir fill{fields} of 2; multipage/overlay/extract
  need none.

## 2026-09-15 — `toolset.phase2-eval.json`: phase2 + read-only `fast_evaluate` (owner A/B)
- **What:** generated from `toolset.phase2.json` (test asserts it differs only by the
  added tool); evaluate described as read-only DOM queries, never cookies/storage,
  prefer fast_text for plain text. README lists the gate, the dated prompt and the
  toolsets.
- **Why:** the owner enabled evaluate on the relay account and wants to know whether it
  helps 4.3 once phase2 scores clean without it.
- **Files:** `fast-runner/toolset.phase2-eval.json`, `fast-runner/test/toolset.test.mjs`,
  `fast-runner/README.md`.
- **Watch out:** `no-cdp` never gets evaluate.
- **Status:** committed; A/B pass recorded in the hvm feedback doc.

## 2026-09-15 — hvm rig: clear the extension service-worker ScriptCache on Chrome launch; snapshot `hint` survives the spread
- **What:** `bench/hvm-rig.sh` removes `$RIG_PROFILE/Default/Service Worker/ScriptCache`
  before launching Chrome. `page.js` `markTruncated` always deletes the serializer's
  `hint:undefined` before spreading (it erased the truncation hint on explicit
  `fast_snapshot`).
- **Why:** two rig "restarts" after fast-forwarding the feedback build still ran the OLD
  background worker (`fast_key_press` returned `{keyDispatched,target:"INPUT#id"}`, the
  deleted `key.js` shape) while content scripts were current: Chrome serves an unpacked
  extension's SW script from the profile cache until the extension is reloaded. Clearing
  the cache dir fixed it on the spot.
- **Files:** `bench/hvm-rig.sh`, `fast-ext/src/actions/page.js`.
- **Watch out:** only the rig profile; the Windows copy still needs a manual reload at
  chrome://extensions after a sync.
- **Status:** committed; verified on hvm.

## 2026-09-15 — Extension: page results cross `executeScript` as a JSON string (Chrome sorts returned object keys)
- **What:** `index.js` `pageBridge` returns `JSON.stringify(result)` and `runBridge`
  parses it; `text.js` does the same for `fast_text`. `labelFor` strips a wrapping
  `<label>`'s own control text (every `<option>` of a `<select>`, an input's value).
- **Why:** the hvm smoke test of the feedback build came back with keys in
  ALPHABETICAL order (`{clicked, focused, index, snapshot, url…}`): Chrome marshals an
  object returned from `chrome.scripting.executeScript` through a `base::Value` dict,
  which sorts keys — so `verified` / `truncated` / `url` landed after `snapshot`, the
  opposite of "first field". A string crosses untouched; key order then survives
  JSON.parse → WebSocket → broker → server. `fast_select_option`'s `field.label` also
  read "Dropdown (select) Open this select menu One Two Three".
- **Files:** `fast-ext/src/actions/index.js`, `fast-ext/src/actions/text.js`,
  `fast-ext/src/actions/page.js`.
- **Watch out:** anything that returns an object from page.js must be JSON-serializable
  (it already had to be — executeScript serialized it before); `undefined` → `null`
  keeps the "injected script returned no value" error path.
- **Status:** committed; hvm rig.

## 2026-09-15 — phase2 toolset: drop `fast_evaluate`, miss/truncation/wait guidance, exact-quote `report_done`
- **What:** `fast-runner/toolset.phase2.json` is 12 FastLink tools + 2 native = 14:
  `fast_evaluate` is gone (was disabled on the runner's relay account; 11 of 32 bench
  cells burned a call on it). Descriptions now carry the tool-contract signals: "on a
  miss retry with a name from `candidates`", "truncated:true → full:true / limit:N",
  "fast_wait text is a substring — use ≥2 words", "index = N-th match, not a snapshot
  id", fast_key_press returns a snapshot, and `report_done` demands names/numbers/values
  quoted EXACTLY as the page shows them (the terse report made 4.3 write "US" and
  "1.429B", which the extract scorer cannot match) plus a verbatim evidence quote.
  `toolset.no-cdp.json` untouched (never had evaluate).
- **Why:** hvm pass 4 (grok-4.3 / phase2, 52/59): extract 19/22 from abbreviations,
  wasted evaluate calls, snapshot-id-as-index misses.
- **Files:** `fast-runner/toolset.phase2.json`, `fast-runner/test/toolset.test.mjs` (14
  tools, evaluate excluded, ≤2 sentences still enforced).
- **Watch out:** `toolset.json` (default baseline) is untouched; the phase-3 fold list in
  `docs/TOOL_TRIAGE_DRAFT.md` still lists evaluate as CORE — the owner has since enabled
  evaluate on the relay account; an A/B with it re-added is part of the feedback bench.
- **Status:** committed; benched on hvm (`docs/GROK_RUNNER_BENCH_hvm_feedback_2026-09-15.md`).

## 2026-09-15 — Runner: `report_done` evidence gate, dated system prompt, loud 80k cap
- **What:** `fast-runner/runner.mjs` — (1) **evidence gate** (every toolset; it is the
  caller-facing contract): `report_done` is refused unless a successful READ
  (fast_snapshot / fast_text / text-mode fast_wait / screenshot / evaluate…) came AFTER
  the run's last state-changing call (an action's own auto-snapshot is not a read-back),
  and unless `evidence` quotes a tool result of this run verbatim (a quoted fragment,
  any 3–6-word window, or a ≥6-char number, matched against the normalized full result
  texts). The refusal names what is missing ("no tool has read the page since your last
  fast_fill; call fast_snapshot or fast_text and cite it"); after 3 refusals the report
  is accepted and flagged `gateOverridden`. Refusals are logged per run
  (`gateRefusals[]` in `runs.jsonl` + the run snapshot). (2) The system prompt carries
  today's date + weekday in America/Chicago ("never guess the year") and the rule "a
  result that starts with truncated:true is partial — never report from it". (3) The
  80k result cap now PREFIXES `[truncated:true — N chars, first 80000 follow; narrow it]`
  instead of appending `[truncated]` at the end.
- **Why:** grok-4.3 overclaimed 4 of 8 cells (overlay / extract / mapsdir / cfworkers)
  by reporting without reading back; both models called fast_evaluate for today's date
  and 4.3 typed 2024.
- **Files:** `fast-runner/runner.mjs`, `fast-runner/test/toolset.test.mjs`
  (`gateProblems` unit-tested).
- **Watch out:** the date line changes the cached prefix once a day — expected. Gate
  cost = one extra read per run when the model stops one call short; watch
  `gateRefusals` in the bench doc.
- **Status:** committed; unit tests pass.

## 2026-09-15 — Extension: verified state on mutating tools, bounded auto-wait on misses, truncation-first, settled snapshots, `fast_key_press` in page.js
- **What:** `fast-ext/src/actions/page.js` (+ `index.js`, `text.js`; `key.js` deleted):
  1. **Verified state leads every mutating result.** `fast_fill` → `{ verified, value,
     filled… }` with the field's LIVE value after the page settled (`reason` when it
     did not hold; password masked). `fast_fill_form` verifies ALWAYS (the `verify` arg
     is gone): per-field `value` + `verified`, top-level `verified` + `reverted`.
     `fast_select_option` → `{ verified, picked, value, field, kind }` where `value` is
     what the control displays after the pick and `field` (label / aria / name / id /
     preceding heading) is the dropdown it actually acted on — the react-select.com
     "field:'Ocean' picked Forest in the wrong select" case is now visible. `fast_click`
     → `{ clicked, url, urlChanged, dialogOpened|dialogClosed, focused, … }` first.
  2. **Bounded auto-wait on targets.** `fast_fill`, `fast_select_option` (per field)
     and `fast_click` re-run the lookup every 150ms for up to 1.5s (`AUTO_WAIT_MS`)
     before returning a miss; the miss carries `waitedMs`, `settling` (page still
     mutating / resources still landing, from `pageActivity()`) and the fixer's
     `candidates` / `hiddenMatches` / `hint`. Nothing is clicked/filled on a miss.
  3. **Truncation first.** Any capped view now STARTS with `truncated:true`,
     `dropped:{items,content,offscreen,textTrimmed}` and a `hint` naming the exact
     call for the rest (`markTruncated`): explicit `fast_snapshot` (was a numeric
     `truncated` count + `contentTruncated`), the action auto-snapshot (count + byte
     cap), viewport-only snapshots (`dropped.offscreen` = visible interactive elements
     outside the viewport, counted in `serializeSnapshot`), and `fast_text` with
     `maxLen` (`dropped.chars`). `capAutoSnapshot` returns a NEW object — assign it.
  4. **Settled snapshots.** `withSnap` waits for the DOM to be quiet 150ms (≤1s,
     `SETTLE_MAX_MS`, `settleDom`) after the rAF before serializing; a page still
     mutating at the cap is flagged `settling:true` + hint at the top of the result.
     The observer stamps `INDEX.lastMutMs`; FastLink's own flash chip
     (`__fastlinkChip`) is neither activity nor indexed (it used to appear as a
     `{tag:"div",text:"fill"}` content block in every result).
  5. **`fast_key_press` runs in page.js** (PAGE_ACTIONS; `key.js` deleted): same DOM
     key events, now on the pinned target tab, returning `target`, `url`/`urlChanged`
     and a settled auto-snapshot — Enter on Google Maps used to return
     `{keyDispatched}` and nothing else, so the model reported route options it never
     saw. A navigating Enter returns `navigated:true` via the existing frame-teardown
     path.
  `fast-dxt/server/tools.js` + `fastlink-relay/tools.js` describe all of the above
  (mirrored; `fast_fill_form.verify` removed from the schema).
- **Why:** owner's thesis on the grok-4.3 bench (56/70 local, 52/59 hvm): "4.3 can do
  it, it needs more feedback". Each dropped checkpoint traced to a silent tool result:
  fill on a not-yet-rendered field, select_option on the wrong select, answering from a
  capped snapshot, fill 0.8s after a view change, Enter with no read-back.
- **Files:** `fast-ext/src/actions/page.js`, `fast-ext/src/actions/index.js`,
  `fast-ext/src/actions/text.js`, `fast-ext/src/actions/key.js` (deleted),
  `fast-dxt/server/tools.js`, `fastlink-relay/tools.js`.
- **Watch out:** every action result is ~150ms–1s later than before (settle) — cheaper
  than a model turn, but pages that never stop mutating (Maps) pay the full 1s and are
  flagged `settling`. A miss now costs up to 1.5s. Consumers of the old numeric
  `snapshot.truncated` / `contentTruncated` (none in-repo besides scout's own capping)
  must read `dropped`. `fast_fill_form` always spends ≤2.5s verifying.
- **Status:** committed; hvm rig loads the repo copy (bench below); Windows copy NOT
  synced by this change (other agent owns that sync).

## 2026-09-15 — Housekeeping: hvm bench branch merged, Windows extension copy synced (reload still manual)
- **What:** (1) hvm repo (`/home/dev/code/Fastlink`, commits `8eaff09…ba610e0`, bench passes
  1–4 on the rig) merged into WSL main as `fb94fd6` via a `hvm` git remote; both results
  docs kept (`docs/GROK_RUNNER_BENCH_2026-09-15.md` local, `…_hvm_2026-09-15.md` hvm);
  `bench/tool-usage.md` conflict resolved to the WSL render — it is generated per machine
  from the untracked `bench/tool-usage.jsonl`, the hvm histogram lives in the hvm doc.
  hvm main moved to the same commit by pushing a temp branch and `git reset` (mixed) +
  checkout of the 5 bench/doc files, so the rig's on-disk `fast-ext/` was never rewritten
  (its 3 rsynced files were byte-identical to WSL HEAD). (2) `fast-ext/` rsynced to
  `C:\Users\yjtur\FastLink\extension\` — differing files were `manifest.json` (0.4.3 →
  0.4.4), `src/actions/page.js`, `src/connection.js`; trees now identical. (3) No
  broker-reachable extension reload exists: `chrome.runtime.reload()` is only behind the
  toolbar click, the options-page `fastlink:relay-reconnect` message, and updateCheck's
  6h self-apply alarm, which needs a GitHub release newer than the running 0.4.3 (latest
  is `ext-v0.4.3`). Not hacked in; the one-line instruction is in
  `docs/GROK_RUNNER_PLAN.md` → Pick-up.
- **Verification:** `fast-runner/cli.mjs --local --toolset phase2` on selenium.dev web-form
  → 3 calls / 8.7s, `fast_select_option {field:"Dropdown (select)", option:"Two"}` →
  `picked:"Two", kind:"native-select"` — but that readback already existed in 0.4.3, so it
  does not discriminate builds. Discriminating probe: `fast_select_option` on a bogus field
  returned the bare `field … not found` (no `candidates`) → the user's Chrome is still
  running the OLD 0.4.3 code until it is reloaded.
- **Files:** `CHANGELOG.md`, `docs/GROK_RUNNER_PLAN.md`, `bench/tool-usage.md` (merge).
- **Status:** committed; WSL main == hvm main; Windows copy synced, NOT reloaded.

## 2026-09-15 — Grok runner latency study + terse `report_done` behind phase2
- **What:** `docs/GROK_LATENCY_2026-09-15.md`: 33-call synthetic matrix straight against
  api.x.ai (grok-4.6 / grok-4.3 × effort low / medium × 7k / 30k / 70k ctx × stream, plus
  sync and warm-cache controls) + per-turn evidence from the first instrumented live cells.
  Runner change: `toolset.describe` now also applies to the native `ask_caller` /
  `report_done`; `toolset.phase2.json` re-describes `report_done` as terse (≤3 sentences +
  one quote). Baseline toolset output is byte-identical (test asserts it).
- **Why:** the per-turn gap vs grok.com is **output tokens** on grok-4.6 (hidden reasoning +
  JSON at ~70 tok/s: 100 tok = 1.4s, the 877-token report_done turn = 12.7s), not context
  (warm-cache TTFT is 1.0s even at 72k tokens). `reasoning_effort` low ≈ medium; streaming
  and a smaller result cap gain nothing; grok-4.3 is 2–3× faster and flat with context.
- **Files:** `docs/GROK_LATENCY_2026-09-15.md`, `fast-runner/runner.mjs`,
  `fast-runner/toolset.phase2.json`, `fast-runner/test/toolset.test.mjs`.
- **Watch out:** recommended pass-3 order: phase2 on 4.6 first, then
  `FASTRUN_MODEL=grok-4.3 --toolset phase2` (env var already exists; judge score before wall).
  The report text is not what the bench scores, so the terse description cannot move scores.
- **Status:** committed; not yet benched.

## 2026-09-15 — Extension: one broker dial in flight (SW-start double dial); hvm launch delay root-caused (Chrome keyring wait, not FastLink)
- **What:** `fast-ext/src/connection.js` — `connect()` takes a synchronous `dialing`
  lock and delegates to `connectOnce()`. At service-worker start `startConnection()`
  and the `onInstalled`/`onStartup` `wake()` both call `connect()` within ~2ms; both
  passed the readyState guard on a still-null socket (the socket is created only
  AFTER `await hasAnyWindow()`), and the second's `recycle()` closed the first's
  brand-new socket — the SW console showed "WebSocket is closed before the connection
  is established" on every launch.
- **Why:** GLITCH hunt for the hvm rig's slow post-launch attach (~25s every Chrome
  start; a 90s case made `hvm-run.sh` skip pass 3 `multipage` as "rig down"). CDP
  attach to the SW showed the surviving dial "open after 24.8s", and a plain `fetch`
  to a local http server, a second WebSocket and a fetch to the broker port ALL
  released at that same instant — so it is Chrome's network service, not the
  extension or broker. `--no-proxy-server` changed nothing; `--password-store=basic`
  → "open after 19ms". The ≈25s is the D-Bus method-call timeout while os_crypt asks
  the session bus for a keyring on that headless box; the network service's cookie
  store waits on it. **Rig fix (not in this repo's code): add `--password-store=basic`
  to the Chrome flags in `bench/hvm-rig.sh`** (rig agent's file — handed over, not
  edited here). Also ruled out tonight: a SIGKILLed extension does NOT leave a busy
  slot — the kernel FIN reaches the broker in ~25ms ("primary disconnected"), so the
  slot-busy / 60s-cooldown path never ran.
- **Files:** `fast-ext/src/connection.js`.
- **Watch out:** the lock is per-call, released in `finally`; keep `connect()` the only
  public entry (alarm tick, window-created, wake and the slot-busy timer all go
  through it). It does NOT change backoff, fast-retry or recycle semantics — a
  CONNECTING socket older than `CONNECT_TIMEOUT_MS` is still recycled by
  `checkHealth()`.
- **Status:** committed; `node --check` clean; the double-dial itself was observed
  before the change on the isolated rig (two "dialing" lines 2ms apart, first one
  aborted) — the fixed file is rsynced to the hvm repo behind `bench/FIXER_READY` and
  not yet observed live there (the rig restarts on its own schedule). Windows copy
  NOT synced.

## 2026-09-15 — Auto-snapshot byte cap (≤ ~8k chars) on action results, `full` / `limit` pass-through
- **What:** the `snapshot` attached to every action result (fast_click / fast_fill /
  fast_wait / fast_select_option / fast_hover / … — everything through `withSnap`) is
  now capped by BYTES after the existing count caps: `byteCapSnapshot()` trims content
  block text to 100 chars, drops content blocks from the ranked tail, trims item
  text/innerText to 60 chars, then drops items from the tail (never below 8). Item ids
  (`i`) and geometry are never touched. When anything was dropped or trimmed (by count
  OR bytes) the snapshot carries `truncated:true`, `dropped:{items,content,textTrimmed}`
  and a `hint`. `full:true` on the ACTION returns the whole serialize uncapped;
  `limit:N` overrides the 30-item cap. (`capAutoSnapshot` is the single entry point;
  the stale-fallback path uses it too.) The explicit `fast_snapshot` path is unchanged
  (numeric `truncated` count, its own `full`/`limit`).
- **Why:** the Grok latency profile (`docs/GROK_LATENCY_2026-09-15.md`): click results
  reached ~37k chars on text-heavy pages because a single content block can be 500
  chars — ~0.9s of fresh prefill per model turn, every turn.
- **Files:** `fast-ext/src/actions/page.js`.
- **Watch out:** the cap measures `JSON.stringify(snap)` (the snapshot object, not the
  whole result) — a result lands at ~8.1k with its own fields. Loss order is
  deliberate (content before items, text before whole entries): don't reorder it or a
  click result loses the very control the model needs next. `full`/`limit` are read
  from the action's own args, so a `fast_batch` step passes them per step.
- **Status:** committed / verified on the isolated hvm rig on Wikipedia's Main_Page:
  default `fast_wait` result 8064 chars (`items 30, content 15, truncated:true,
  dropped {content:6, items:18}`), `full:true` → 11849 chars (48 items / 21 content,
  no `truncated`), `limit:3` → 2913 chars. Shipped to hvm via rsync + `bench/FIXER_READY`
  (rig agent restarts); Windows copy NOT synced.

## 2026-09-15 — Grok-runner bench fumbles → tool fixes: actionable misses, titled/emotion react-select, portal listbox sweep, storm-safe fast_wait
- **What:** Four tool defects surfaced by the 2026-09-15 Grok runner pass (local bench,
  8/8 cells, every fumble classified from `~/.local/state/fastrun/runs.jsonl`), all in
  `fast-ext/src/actions/page.js`:
  1. **`fast_fill` miss is now actionable.** A miss returns `candidates` (the visible
     fillable fields with label/placeholder/aria/name) and `hiddenMatches` + `hint` when
     a label-matching field EXISTS but is hidden, read straight from the live DOM
     (bounded, `FILLABLE_SEL`, ≤500 elements). `fast_fill_form` attaches the same
     report once per call when a field is `not found`. The match logic is unchanged —
     Wikipedia's `fast_fill {match:"Search"}` miss was CORRECT (the `#searchInput` is
     `display:none` behind Vector's `.search-toggle` at that width); the error just
     said nothing, so Grok guessed.
  2. **`fast_select_option` finds heading-titled and emotion-styled react-selects.**
     `findField` falls through to a document-outline section lookup (`resolveSection`
     with a new `DROPDOWN_SEL`): "Single" → `<h4>Single</h4>` → the first combobox /
     select / `react-select-*-input` in that section. React-select detection no longer
     needs a classNamePrefix: with none set, classes are emotion hashes
     (`css-1y6m8t7-control`) and both `[class*="select__control"]` and
     `[class*="__control"]` missed, so the control fell into the generic-ARIA branch;
     now the nearest ancestor whose class token ends in `control` is the control,
     open-state is read from the input's `aria-expanded` (the `--menu-is-open`
     modifier only exists with a prefix), and the menu is opened with a real
     `mousedown` (react-select opens on `onControlMouseDown`, not click — a bare
     `.click()` only ever worked when typed filter text opened the menu, which a
     non-searchable dummy-input select never does). A miss returns `candidates`
     (every visible dropdown-ish control with label/aria/placeholder/name/id + its
     `section` heading). Non-searchable react-selects render a 1px opacity-0 dummy
     input, so section resolution and the candidate list measure the CONTROL's
     visibility for `react-select-*-input`s (`fieldVisible`).
  3. **Generic-ARIA dropdown poll sweeps portals.** Options mounted in a portal
     (Angular `cdk-overlay-container`, end-of-body `[role=listbox]`) were only reached
     through the mutation drain, which on a storm-tripped / backlogged page (GCP) never
     indexed them → 3s to `no listbox detected` while a plain `fast_click` on the
     option worked because snapshots sweep overlays. The poll now calls
     `collectOverlayEls()` every 4th tick (bounded 60ms / 500 elements).
  4. **`fast_wait` on storm-tripped pages.** With the observer disconnected (Maps after
     "Directions": thousands of mutations), nothing new was ever indexed, and the
     body-textContent fallback cannot see attribute text (aria-label / placeholder), so
     `fast_wait {text:"Choose starting point"}` timed out at 6.8s while the input was
     on screen. The poll now re-seeds the resumable DOM walk when storm-tripped (same
     rule as `serializeSnapshot`), drains 2000/30ms like a snapshot, and probes
     `aria-label` / `placeholder` directly (bounded 1500 elements, every other poll),
     returning the element with coords + a stable id. The fallback also stops matching
     text that lives ONLY inside `<script>/<style>/<template>/<noscript>` bodies
     (`body.textContent` includes inline JSON state blobs) — that was a latent false
     "found".
  - `fast-runner/runner.mjs`: tool-log `preview` 160 → 1200 chars so a fumble can be
    post-mortemed from `runs.jsonl` (an error's candidates, a batch's per-step results);
    this hunk was swept into `f3d8b20` (another agent's runner commit) — noted here, not
    a separate commit. Touched `fast-runner/` per the owner's "change any code" word.
- **Why:** classification of tonight's runs: `overlay` (react-select.com) cost 24 calls /
  125s wall after one `field "Single" not found` (→ scout, xy-clicks, fast_do, typing);
  `gcpform` lost a 7s batch to `no listbox detected`; `mapsdir` lost 6.8s to the wait
  timeout; phase-0 Wikipedia lost 2 calls to the bare fill error. Not tool defects:
  `fast_evaluate` "disabled for this account" (relay setting, ×2 — a toolset item),
  `fast_click "Ocean"` hitting `Remove Ocean` (ranking picked the role=button; model
  choice), `fast_wait {text:"From"}` resolving on "Offers from our partners" (substring
  semantics as documented). No GLITCH-class failures tonight: 0 timeouts, 0 STUCK, no
  broker drops in any of the 8 local or 6 hvm pass-1 cells.
- **Files:** `fast-ext/src/actions/page.js` (only). No tool description changed, so
  `fast-dxt/server/tools.js` / `fastlink-relay/tools.js` are untouched.
- **Watch out:** a `fast_fill` / `fast_select_option` miss is STILL a hard error — the
  reports are advisory, nothing auto-reveals or auto-falls-back (a hidden match is
  reported, not filled). `fieldVisible` widens visibility ONLY for
  `input[id^="react-select-"]`; do not generalise it or hidden inputs become fill
  targets. The fast_wait attribute probe runs only on the fallback (odd) polls and only
  after the index scan misses — keep it there or every poll pays a querySelectorAll.
  `fast_wait`'s storm re-seed must keep the "only when nothing pending" guard (same
  reason as the snapshot's: nulling the cursor restarts DFS from `<body>` every poll).
  The hvm rig loads `fast-ext` UNPACKED, so shipping = copy the file + restart that
  Chrome; the runner spawns a fresh `fast-dxt/server` per cell, the broker is untouched.
- **Status:** committed / verified on an ISOLATED hvm rig (own Xvfb :97, patched-port
  broker 9886/9880, Chrome for Testing + this `fast-ext`, no contact with the bench rig):
  test page — hidden "Search" → `hiddenMatches` + `candidates`; portal listbox
  `Application type → Web application` picked (`kind:aria-listbox`, read back);
  storm + late aria-label input → `fast_wait` found it with coords in 1.9s; live
  react-select.com/home — `fast_select_option {field:"Single", option:"Forest"}` →
  `picked:"Forest"` (`kind:react-select`), first `singleValue` reads "Forest".
  **hvm bench passes:** pass 1 = unfixed baseline (`8eaff09`). The first fix build
  (this entry minus items "script-only text" and `fieldVisible`; file md5
  `2b1465f5…`, committed as-is) reached the rig 9s INTO pass 2 cell 1 — my boundary
  watcher started after the pass-1 commit line had already been written — so
  **pass 2 `multipage` (06:16:48Z, score 0/6, 48 calls, marked valid) is a rig
  restart artifact, exclude it**; pass 2 cells 2–6 ran on `2b1465f5…` (= commit
  `5ba6bd6`). Pass 3 (all 6 cells) runs on the final file (`cd7af46a…`, this commit),
  shipped at the pass-2 → 3 boundary at 06:22:31Z: the watcher fired the instant the
  pass-2 `mapsdir` run.js exited, before hvm-run.sh's `rig_up`, which relaunched the
  rig Chrome on the new file (06:22:38Z). That Chrome needed SIGKILL (SIGTERM had not
  finished in 0.5s) and the fresh extension then took ~90s to get its broker slot back,
  so `rig_up` gave up and **pass 3 `multipage` was SKIPPED by hvm-run.sh ("rig down",
  no row)**; pass 3 cells 2–6 ran on `cd7af46a…`. The slow re-slot is a broker defect
  (see the slot-probe entry above, if present). **Windows extension copy NOT synced
  tonight** (the local bench stays on unfixed tools); `chrome://extensions` reload
  still needed there later.

## 2026-09-15 — fast-runner: per-model-turn instrumentation (`turns[]` in runs.jsonl)
- **What:** every model call is logged to the run row as `turns[]`: `{turn, t, latencyMs,
  attempts, requestChars, inputTokens, cacheRead, cacheCreate, outputTokens, toolResultChars,
  stop_reason, tools, thinking, …any extra xAI usage keys}`; `usage` gains `cacheCreate` +
  `modelMs`. `createMessage` returns `_timing` on the body. No request/behaviour change.
- **Why:** the runner's per-turn latency (5–11s on heavy cells vs grok.com's ~2.6s) could only
  be inferred from toolLog gaps; result sizes were not stored at all (1200-char previews).
- **Files:** `fast-runner/xai.mjs`, `fast-runner/runner.mjs`.
- **Watch out:** the bench spawns `cli.mjs` per cell, so cells started after this commit carry
  `turns[]`; older rows don't. `bench/drive-runner.js` ignores the new keys.
- **Status:** committed; in flight on the pass-2/3 cells that start after it.

## 2026-09-15 — Grok runner bench, phase 1: full suite ×3 over the relay + tool-usage data
- **What:** All 8 bench tests run through `bench/run.js --client grok_runner --browser
  yaakovschrome` (fast-runner over relay.ytx.app, grok-4.6 effort low). Pass 1: **70/70,
  428.2s wall, 110 calls, 8/8 valid** vs the 08-06 grok.com baseline 70/70 / 259.3s / 99.
  Results + fumble review in `docs/GROK_RUNNER_BENCH_2026-09-15.md` (passes 2–3 appended as
  they land). Driver fixes in `bench/` only: runner rows re-summarize wall/calls from the run
  store's toolLog after exit (streamed stderr rows lagged by a call); negative `ms` from
  WSL clock skew clamped; `tool-usage.md` now aggregates ALL cells (n=3) with per-tool
  `retry` / `switch` / `fumble %` (next call on the same target), each usage row carrying a
  `target` per call (backfilled from the run store for older rows).
  Final 3-way (the lead's plan changed twice mid-run; an extra default pass `d2` = 70/70 /
  401.7s / 100 calls is kept as variance data): **pass 2 = phase2 toolset on grok-4.6: 70/70,
  414.5s, 91 calls, 0 reflex** (239.8s without overlay's 174.7s blow-up); **pass 3 = phase2 on
  grok-4.3: 56/70, 55.3s wall, 50 calls, 4 overclaims** — gcpform 2/6 (no recovery after the
  `<cfc-select>` select_option miss, 3 consecutive errors), overlay 1/3 (selected Forest in
  the wrong react-select), extract 19/22 (counted the World row), mapsdir 4/6 (fill before
  the input rendered), cfworkers 2/5 (never clicked the Worker). `run.js --toolset <name>`
  forwards to `cli.mjs --toolset`; rows carry `toolset` + `model`; `tool-usage.md` renders
  one histogram per toolset × model.
- **Why:** plan phase 1 — the data phase 2's tool triage needs.
- **Files:** `bench/{drive-runner,run}.js`, `bench/tool-usage.md`, `docs/GROK_RUNNER_BENCH_2026-09-15.md`.
- **Watch out:** `fast_evaluate` is BLOCKED for the runner's relay account (`evalBlocked`);
  both models reach for it in 11 of 32 cells (forms, tables, and "today's date") despite the
  phase2 description saying it may be disabled. On 4.6, round-trips are 80–96% of wall and the
  toolset does not move it; on 4.3 the wall collapses but the model stops one action short or
  skips the read-back. Two rows were re-run after my timestamp pruning of aborted passes
  caught them (d2 + p1 cfworkers; originals noted in the doc). The pre-pass 05:52 `extract`
  cell was pruned from `tool-usage.jsonl`. Snapshot `i` gets passed as `fast_click index` by
  both models.
- **Status:** all three passes committed; results doc final.

## 2026-09-15 — bench: self-driving hvm rig (grok_runner over the LOCAL transport, n=3)
- **What:** `bench/hvm-rig.sh` (env + idempotent bring-up: Xvfb `:98`, Chrome for Testing
  with the unpacked `fast-ext`, broker `:9876`, grokcode proxy `:8791`, proof that the
  extension is on the broker), `bench/hvm-run.sh` (PASSES×6 auth-free cells, commit per
  pass, doc regenerated per pass), `bench/hvm-report.js` (per test × pass score/wall/calls,
  best + median wall vs the relay baseline, all-pass tool histogram with per-tool fumble
  count, fumble list; targets read from the runner's run store). `drive-runner.start` takes
  `transport` so `run.js --transport local` spawns `cli.mjs --local` instead of always
  `--relay`.
- **Why:** run the Grok-runner suite on a box that does not sleep; phase 1 needs tool-choice
  data, not hop latency, so the local transport is fine there.
- **Files:** `bench/hvm-rig.sh`, `bench/hvm-run.sh`, `bench/hvm-report.js`,
  `bench/drive-runner.js`, `bench/run.js`.
- **Watch out:** hvm-specific facts baked into hvm-rig.sh — branded Chrome ≥137 ignores
  `--load-extension` (hence Chrome for Testing under `~/.local/share/fastlink-bench-chrome`),
  Chrome needs `--no-sandbox` there (AppArmor), `:8790` on hvm is an unrelated service so the
  proxy is on `:8791` (`GROKCODE_PORT/URL`, already env-driven in `xai.mjs`). `gcpform` /
  `cfworkers` are skipped (no login in that profile). hvm and WSL now hold separate copies of
  `~/.grok/auth.json`: if xAI rotates refresh tokens, one side's refresh can invalidate the
  other — cure is `grok login` on the side that breaks.
- **Status:** in code / committed / rig verified live on hvm.

## 2026-09-15 — fast-runner: explicit per-run toolsets (`--toolset`) + phase-2 / no-cdp sets
- **What:** `runner.mjs` `loadToolset(spec)` — `"default"`/unset → `toolset.json` (all 45 tools +
  the server's `instructions` essay, the A/B baseline, untouched); a bare name → `toolset.<name>.json`;
  a path → that file. `buildTools`/`buildSystem` exported; `runs.jsonl` rows + the finished-run
  snapshot carry `toolset`. Non-default toolsets DROP `client.instructions` from the system prompt.
  New `toolset.phase2.json` (13 raw tools + 2 native = 15, ≤2-sentence Grok descriptions) and
  `toolset.no-cdp.json` (12, no `chrome.debugger` tools), per `docs/TOOL_TRIAGE_DRAFT.md` §3.
  `cli.mjs --toolset <name|path>` and `--dump-tools` (reads `fast-dxt/server/tools.js`, no browser);
  `grok_run{toolset}`; `FASTRUN_TOOLSET` env. `npm test` → `test/toolset.test.mjs` (node:test).
- **Why:** owner: "we are looking to optimize" — the bench needs to A/B the triaged list against the
  baseline per cell, so selection must be explicit, not ambient.
- **Files:** `fast-runner/runner.mjs`, `cli.mjs`, `caller-mcp.mjs`, `package.json`, `README.md`,
  new `toolset.phase2.json`, `toolset.no-cdp.json`, `test/toolset.test.mjs`; `docs/TOOL_TRIAGE_DRAFT.md` §3a/3b.
- **Watch out:** `describe` keys are REAL tool names (pre-rename). A missing/mistyped toolset name
  throws before any connect. Bench slicing: filter `runs.jsonl` by `toolset`, not by date.
- **Status:** unit-tested + `--dump-tools` eyeballed; NOT yet run against a browser (both busy with bench passes).

## 2026-09-15 — docs: Grok runner phase-2 tool triage draft (`docs/TOOL_TRIAGE_DRAFT.md`) — 45-tool inventory + use counts, overlap map, ≤15-tool toolset (core/fold/internal/drop), Grok-tuned descriptions, no-cdp profile, phase-3 risks; source only, no code touched.

## 2026-09-15 — fast-runner phase 0b + 1: relay transport (OAuth client) + bench runner driver
- **What:** `fast-runner/relay-transport.mjs` — `connectRelay({browser})` is an MCP
  Streamable-HTTP client to `relay.ytx.app/mcp` authenticated the way claude.ai/grok.com
  are: the SDK's `OAuthClientProvider` does discovery → dynamic registration
  (`client_name` "fastrun", `token_endpoint_auth_method` none) → authorization_code +
  PKCE S256; the one-time login redirects to a loopback `http://127.0.0.1:47821/callback`
  the transport serves itself; tokens + client registration + PKCE verifier live in ONE
  file `~/.config/fastrun/relay-token.json` (dir 700, file 600) and the SDK refreshes
  silently on 401. ONE MCP session per connect; `browser` → `fast_profile` right after
  connect, so the pin is stored under the runner's own OAuth `cid`. `relay-login.mjs` =
  login + smoke (`--reset` re-registers). `bench/drive-runner.js` — bench driver that
  spawns `fast-runner/cli.mjs --relay [--browser N] "<prompt>"`, feeds the runner's
  streamed tool-call lines to a `RunnerTrace` (RelayTrace-shaped rows), then swaps in the
  exact `toolLog` from `~/.local/state/fastrun/runs.jsonl` at exit; process exit is the
  FINISH signal, STUCK/NO_ACTIVITY keep monitor.js's meaning; `ask_caller` is answered
  with a fixed "proceed" line. Appends every cell to `bench/tool-usage.jsonl` and
  regenerates `bench/tool-usage.md` (tool / calls / errors / avg ms / tests). `run.js`:
  client `grok_runner` (always the runner driver), `--browser`, runner preflight = a real
  `fast_status` over the runner's own relay session (no device token needed),
  `claimedComplete` = runner status (`done`) instead of phrase heuristics.
- **Why:** plan phases 0b/1 — same channel grok.com used in the 08-06 bench so numbers
  compare 1:1, and a driver that needs no chat site.
- **Files:** `fast-runner/{relay-transport,relay-login}.mjs`, `bench/{drive-runner,run}.js`,
  `bench/.gitignore`, `bench/tool-usage.md`.
- **Watch out:** the loopback port is REGISTERED with the relay at DCR — change
  `CALLBACK_PORT` and you must `relay-login.mjs --reset`. `OAuthError` is exported from
  `@modelcontextprotocol/sdk/server/auth/errors.js`, not `client/auth.js`. The account's
  browser names are now `browser-1` (offline), `fastlinkchrome`, `fastlinkchrome-2`,
  `yaakovschrome` (the live one) — the plan's "browser-1" is stale. `cli.mjs` has no
  `--json` flag: unknown flags become part of the task text, so the driver passes only
  `--relay`/`--browser`; the final JSON carries `so_far.recent` (last 10) — the full log
  is the run store. `FASTLINK_DEVICE_TOKEN` in `~/fastlink-secrets.txt` is REJECTED by
  `/devices` (invalid_device_token): chat-site cells (`--client grok|claude`) still need a
  valid one; the runner path does not.
- **Status:** committed / **verified live**: login completed by driving Chrome through the
  local connector (Google account chooser → loopback callback from Windows Chrome into
  WSL worked), `listTools` = 45 fast_* tools, `fast_status` over the relay shows
  `userId 115636077357721664019`, `selected:"yaakovschrome"`, `selectionMode:"pinned"`;
  `fast_tab` example.com → `fast_snapshot` h1 "Example Domain" (4 calls, 1.08s incl.
  connect). Bench cell `grok_runner × relay × extract`: **22/22, 7.4s wall, 6 calls**,
  `bench/tool-usage.md` produced. Other 7 tests not yet run through the runner.

## 2026-09-15 — fast-runner phase 0: Grok drives FastLink, Claude is the caller
- **What:** New `fast-runner/` (see `docs/GROK_RUNNER_PLAN.md`). `runner.mjs` runs an
  agent loop with grok-4.6 (Anthropic-Messages format via the grokcode proxy on :8790,
  which owns the xAI OAuth token) over FastLink's MCP tools listed dynamically from
  `fastlink-client.mjs` (`local` = spawn `fast-dxt/server/index.js` over stdio with the
  same env as the `fastlink` MCP entry in `~/.claude.json`; `relay` = `relay-transport.mjs`).
  Runner-native tools `ask_caller` / `report_done`; budgets 60 calls / 10 min / 3
  consecutive errors; runs logged to `~/.local/state/fastrun/runs.jsonl`. `caller-mcp.mjs`
  is the `fastrun` MCP server (user-scope) with `grok_run` / `grok_answer` /
  `grok_status` / `grok_cancel` (240s hold, question/running/done). `cli.mjs` runs one
  task from the shell; `toolset.json` = allow/rename/describe overrides Grok sees.
- **Why:** bench 2026-08-06 — Grok finished the suite 2× faster than claude.ai; make it
  the operator and keep Claude as dispatcher.
- **Files:** `fast-runner/{package.json,runner.mjs,xai.mjs,fastlink-client.mjs,caller-mcp.mjs,cli.mjs,toolset.json,README.md}`.
- **Watch out:** reasoning effort is fixed at proxy start (`GROKCODE_EFFORT`; runner starts
  it with `low`) — restart the proxy to change it. FastLink signals failures as
  `{"error":…}` text, not MCP `isError`; the runner parses that for its ok flag and the
  consecutive-error budget. The local server spawn is a SECOND fast-dxt process attached
  to the shared broker (no `--http`, so no port clash with Claude Code's own instance).
- **Status:** committed; verified live over `local` (Wikipedia search 58.6s/14 calls,
  ask_caller fill task 14.2s/4 calls, fill read back via fast_snapshot). Relay transport
  is phase 0b.

## 2026-08-06 — fast_tab returned before the tab existed → "Restricted URL: " in fast_batch
- **What:** `chrome.tabs.create` resolves BEFORE the navigation commits — the new tab's
  `.url` is `""` and only `.pendingUrl` holds the target. `openTab` pinned the tab and
  returned immediately (reporting `pendingUrl`, so it *looked* fine), and the next
  action resolved that pinned tab, hit `isInjectableUrl(tab.url)` with `""`, and failed
  with `Restricted URL: ` — an EMPTY url after the colon, which is the signature of
  this race. All three tab-creation paths in `openTab` now await a new
  `waitForUrlCommit()` before returning, and return the COMMITTED url.
- **Why:** every `fast_batch` starting with `fast_tab` lost all subsequent steps.
  Reproduced 100% on example.com: `[fast_tab, fast_snapshot]` → step 1
  `"Restricted URL: "`. Between two separate MCP calls the model's round-trip masks
  it, which is why it only ever showed up inside a batch.
- **Files:** `fast-ext/src/actions/tab.js`.
- **Watch out:** `waitForUrlCommit` deliberately does NOT reuse `waitForComplete()`.
  That one waits for `status:'complete'` via an `onUpdated` listener, so a load that
  finishes before the listener attaches would burn the FULL timeout on every single
  `fast_tab`. A committed URL is what callers actually need and it has a natural
  early-out. Do not "simplify" the two into one.
- **Status:** in code / synced to Windows copy / reloaded / **VERIFIED LIVE** as the
  running content script: `[fast_tab, fast_snapshot]` on example.com now returns real
  page content (was `"Restricted URL: "`), and the full original failure path
  `[fast_tab, fast_fill, fast_evaluate]` on selenium web-form succeeds with the value
  confirmed present in the DOM.

## 2026-08-06 — bench/: chat-vs-chat FastLink benchmark harness
- **What:** New `bench/` harness measuring how well different AI chats drive FastLink.
  EIGHT tests (`multipage`, `gcpform`, `staticform`, `overlay`, `extract`,
  `flightsearch` aa.com, `mapsdir` Google Maps, `cfworkers` Cloudflare dashboard), each scored
  by ORDERED CHECKPOINTS verified against **live page state read back through the
  LOCAL broker** — deliberately off-transport, so the channel under test (the relay)
  is never also the channel doing the verifying. Nothing is scored from what the model
  claims. A separate `claimedComplete` column records whether the chat asserted success,
  so "filled 3 of 4 fields" and "claimed 4" cannot blur into one number.
  `monitor.js` flags a run STUCK (no tool call for ~60s) or NO_ACTIVITY so a broken
  cell is marked `valid:false` instead of being recorded as a slow/failed model.
- **Why:** wall-clock alone is misleading — a model that quits at 60% looks fast. Also
  to quantify what FastLink fixes actually buy, by re-running the suite after changes.
- **Files:** `bench/{suite,score,monitor,drive-web,run,report,fastlink}.js`, `bench/package.json`.
- **Watch out:** Prompts MUST name the FastLink connector explicitly — with a neutral
  prompt, Grok answered from its own web browsing and made **zero** FastLink calls
  (scored 0/6 until the harness flagged NO_ACTIVITY). The suite then measures tool
  choice rather than driving speed.
  Test pages hand out FALSE results from their default state: on selenium's web-form
  the `<select>` starts non-empty, the FIRST radio is pre-checked, and BOTH checkboxes
  share `name="my-check"` so `form.elements['my-check'].checked` is `undefined` — that
  last one scored a false FAILURE against both models until fixed by reading
  `#my-check-2` directly. Verify every checkpoint against an UNTOUCHED page.
  Relay clients open a new MCP session per tool call, so traces must be aggregated
  across all sessions and sliced by time window.
  **Authed tests are NOT symmetric across two Chrome profiles on different accounts.**
  `gcpform` needed `gcloud projects add-iam-policy-binding booming-argon-464605-n5
  --member=user:yaakov@ytx.app --role=roles/editor`; `cfworkers` needed the second
  profile signed into the SAME Cloudflare account. Cookies are per-profile, so an
  OAuth flow completed in one profile does NOT give the other a session.
  **claude.ai asks tool permission PER TOOL** and blocks the whole turn until a human
  clicks — with no trace activity, so a blocked run records as NO_ACTIVITY / a low
  score. `drive-web.approveToolPrompts()` clears it, hooked to `watchRun`'s new
  `onQuiet` so it only fires when nothing is driving the browser.
  aa.com persists a submitted itinerary to `localStorage` and RE-FILLS the form from
  it on the next load — cleared via `reset.clearStorage`, since closing tabs cannot.
  `cfworkers` runs against a REAL production Cloudflare account: it is read-only by
  construction. Do NOT add a mutating step.
- **Status:** in code / all 8 tests validated in BOTH directions; suite running live.

## 2026-08-06 — Multi-browser: named browsers + per-client routing on the relay
- **What:** One relay account can now drive MANY named browsers, and a client picks
  which one. `devices.label` becomes the user-facing NAME (migration `0006` renumbers
  existing labels to `browser-N` and adds a **partial** unique index on
  `(user_id, label) WHERE revoked = 0`, so revoking frees a name). `extSocket()` is
  **deleted**, replaced by `resolveTarget(clientKey)` → name → `device_token` → the
  live socket carrying it; the socket is resolved ONCE per MCP request and threaded
  through consent probes, `fast_batch` nav-settle, `fast_evaluate`, `notifyExtension`
  and the vision tier, so two chat products calling concurrently cannot race.
  Relay `fast_profile` (`install:"<name>"|"auto"`) mirrors the local tool byte-for-byte;
  `fast_status` gains `browsers[]`, `selected`, `selectionMode`, `selectionSource`,
  `defaultBrowser`, `routedBrowser`. New `GET/POST /devices` (same device-token auth
  as `/consent`, `/trace`). Options page gains a "This browser's name" card modelled
  on the Broker-slot card.
  - Two bugs found en route: the `hello` frame's `serializeAttachment({installId,version})`
    was **erasing** the `{connectedAt, deviceToken}` stamp (which also broke targeted
    revoke) — now merged; and background prewarm-on-nav snapshotted "whichever
    connected last" instead of the browser that actually navigated.
- **Why:** `userRelay.js` routed every command to the MOST-RECENTLY-CONNECTED socket
  ("multi-device most-recent-wins"). With two browsers paired, which one got driven
  flipped whenever an MV3 service worker redialed — silently wrong, not merely
  blocked. The local broker had solved this years earlier with install slots; the
  relay never caught up.
- **Files:** `fastlink-relay/migrations/0006_device_names.sql` (new),
  `fastlink-relay/src/{db,auth,index,mcp,userRelay,composite,timing}.js`,
  `fastlink-relay/tools.js`, `fast-ext/options.html`, `fast-ext/options.js`.
- **Watch out:** Selection is keyed by **OAuth client id** (`cid`, stamped into grant
  props, forwarded as `X-Fastlink-Client-Id`), NOT the MCP session and NOT the raw
  bearer. This is load-bearing: relay clients open a NEW MCP session per tool call
  (measured: claude.ai 5 sessions for 5 calls; Grok 11 for 11), and access tokens
  refresh hourly — a session-scoped or raw-token-keyed pin would silently drop.
  Grants minted before the `cid` stamp fall back to `tokenKey()` until the client
  re-authorizes. Most-recent-wins survives ONLY inside the explicit `auto` branch —
  do NOT reintroduce it as a fallback; a pinned-but-offline browser must stay a hard
  error naming the connected ones.
- **Status:** deployed to relay.ytx.app (version `d1abf155`) + migration applied
  remote / extension synced to Windows copy, **needs `chrome://extensions` reload**
  for the options card. Verified live: `/devices` returns the new shape and the
  migration renamed the existing device to `browser-1`. NOT yet verified: any
  second-browser pairing — only one browser is paired, so multi-browser routing has
  never run end-to-end on the wire.

## 2026-08-06 — Snapshot served STALE input values; password leak; section-scoping rewrite
- **What:** Two bugs in `fast-ext/src/actions/page.js`, both reproduced live on the
  GCP "Create OAuth client ID" form.
  1. **Stale input values.** `makeClickEntry` baked `el.value` into the cached
     `entry.text`, and *nothing could ever invalidate it*: writing `.value` through
     the property setter mutates **no attribute**, so no MutationRecord exists; the
     observer's `attributeFilter` excludes `value` and `characterData` isn't
     observed. A filled field reported its pre-fill default forever. Fix: a
     control's value is **no longer cached** — `liveKindOf()` tags value-bearing
     entries and `refreshLiveEntry()` re-reads the DOM as the single derivation
     point (index time, serialize loop, and `fast_wait`'s scan). Snapshot items now
     also carry an explicit live `value`.
  2. **`section:` silently wrote the WRONG field.** Two defects: `fast_fill` did
     `if (scoped.length) pool = scoped;` so an unresolved section silently kept the
     page-wide pool and the first global match won; and the nearest-preceding-heading
     resolver could never resolve on GCP, which renders an `<h3>Item 1</h3> `directly
     above *each* URI row. Fix: sections resolve by **document outline** (anchor to
     next same-or-higher-level anchor), candidates collected from the DOM inside
     that span. An unresolved section is now a **hard error** listing the page's
     real sections.
  - Also: `input[type=password]` was putting the **raw password** into snapshot
    text — now reports a `•` mask of the right length.
  - Also: `fast_fill_form` was ignoring `section`/`near` **entirely and silently**
    (args forwarded verbatim); now wired to the same resolver, with the same hard error.
  - `near` was documented as "nearest context text" but implemented as heading
    scoping — it is now an explicit alias of `section` (one resolver).
- **Why:** benchmarking Claude vs Grok on the GCP form. The stale snapshot forced
  ~49s of screenshot round-trips in a single run because the agent couldn't trust
  the DOM; the `section:` bug silently overwrote the JavaScript-origins field while
  reporting success.
- **Files:** `fast-ext/src/actions/page.js`; descriptions only in
  `fast-dxt/server/tools.js` + `fastlink-relay/tools.js` (mirrors kept in sync).
- **Watch out:** Do NOT re-add `el.value` to `makeClickEntry`'s text chain — the
  cache cannot be invalidated for property-setter writes, that IS the bug.
  `refreshLiveEntry()` must stay the single derivation point. Do NOT reintroduce a
  silent fallback when a section fails to resolve — silent wrong-field writes are
  worse than errors. Note this page hits the `MAX_WALK` ceiling (`capped:true`,
  ~130 entries), which is why a plain `fast_fill {match:"Name"}` can miss right
  after render; section-scoped fills bypass it by reading candidates from the DOM.
- **Status:** in code / synced to Windows copy / **needs `chrome://extensions`
  reload**; root causes verified live in-page, but nothing yet exercised as the
  actual content script (password masking, `fast_fill_form` section path, and
  `fast_wait`'s live re-read are unverified).

## 2026-08-06 — Relay per-tool-call timing instrumentation
- **What:** The cloud relay recorded no timing, so only the local path could be
  measured. Added per-call `{t, name, gapMs, durMs}` traces (same semantics as the
  local `logTiming`: `gapMs` = model think time, `durMs` = action time) stored in
  the user's own Durable Object, scoped per session and stamped with the MCP
  `clientInfo` name so a trace can be attributed to grok / claude / gpt. Read them
  back with `relay-timing-report.js` (device-token authed `/trace`). The local
  report's inline summarizer was **deleted**; both now render through the shared
  `fast-dxt/server/timing-format.js`.
- **Why:** to compare how different AI clients drive FastLink. Without this there
  was zero data on any relay-driven client.
- **Files:** new `fastlink-relay/src/timing.js`, `fastlink-relay/relay-timing-report.js`,
  `fast-dxt/server/timing-format.js`; modified `fastlink-relay/src/mcp.js`,
  `src/userRelay.js`, `src/auth.js`, `src/index.js`, `package.json`,
  `fast-dxt/server/timing-report.js`.
- **Watch out:** Caps are deliberate — 500 rows/session, 20 sessions/user, 7-day
  TTL. `/trace` is device-token authed and deliberately sends **no** CORS header
  (its consumer is a CLI), unlike `/consent` and `/settings/gemini-key`.
  **Grok's connector opens a NEW MCP session per tool call** (11 sessions for 11
  calls), so any consumer must aggregate across ALL sessions sorted by timestamp
  and slice by time window — never assume one run maps to one session. In the rows,
  `t` is the END timestamp, so gap = (thisEnd − prevEnd) − thisDur.
- **Status:** deployed to relay.ytx.app (version `614f1ebc`) / verified live —
  captured a full 11-call Grok trace and a 14-call Claude trace.

## 2026-07-12 — Alex's laptop moved to the official release channel (fplhij → ockcja)
- **What:** HKLM forcelist entry repointed to the official channel
  (`ockcja…;raw.githubusercontent…/release/updates.xml`); signed 0.4.3 installed,
  auto-updates from now on. Dead local-channel artifacts deleted (kept `fast-ext-pack.pem`).
- **Why:** Laptop stuck on 0.4.2 — local repacking hit the manifest-`"key"` gotcha
  (crx signed as fplhij but manifest pins ockcja → Chrome silently refuses).
- **Files:** none in-repo (registry + local cleanup); channel per `release/README.md`.
- **Watch out:** releases per `release/README.md` are now the ONLY way to ship
  extension changes to self-hosted installs; never resurrect a local-file channel.
- **Status:** done; verified live 2026-07-12.

## 2026-07-12 — Launch-time fast-retry burst for broker connect (+ connect-path logging)
- **What:** For 8s after a window opens / SW wakes, failed broker dials retry every
  250ms instead of climbing the 1s→30s backoff ladder; pending slow reconnects are
  cancelled. Sparse timestamped `[conn …]` SW-console logs added (dial/open/close/retry).
- **Why:** Cold Chrome launch ate 1s+2s+4s of backoff — "extension connects ~5s late".
- **Files:** `fast-ext/src/connection.js`.
- **Watch out:** burst must not override the slot-busy cooldown (`connect()` checks
  `slotBusyUntil` first); steady-state failure pacing unchanged outside the burst.
- **Status:** committed; verified live 2026-07-12 (instant attach on quit/relaunch).

## 2026-07-11 — fast_locate scroll, empty-snapshot iframe hint, update-check tag parse
- **What:** Three fixes.
  1. **`fast_locate` `scroll:true`** — on a not-found vision tier, wheel-scrolls
     and re-points (up to 4 passes), mirroring `handlePoint`'s loop, so
     below-the-fold visual-only targets no longer return `found:false`. Added on
     the server (`handleLocate` → `pointOnce`), the relay, and both tool schemas.
  2. **Empty-snapshot iframe hint** — `fast_snapshot` now attaches a `hint` field
     when the result is near-empty but a large cross-origin iframe is present,
     nudging toward the vision tier (`fast_point`/`fast_fill_vision`) instead of
     leaving the agent to screenshot-and-read.
  3. **Update-check tag parse** — `updateCheck.js` strips an `ext-` tag prefix so
     `1.x` version comparisons against `ext-`-prefixed release tags don't break.
- **Why:** aa.com finding #4a (off-viewport `fast_locate` miss); Apple-setup
  P2/P3/I1 (near-empty snapshot didn't steer to vision); self-hosted auto-update
  tag mismatch.
- **Files:** `fast-dxt/server/handlers.js`, `fast-dxt/server/tools.js`,
  `fastlink-relay/src/composite.js`, `fastlink-relay/tools.js`,
  `fast-ext/src/actions/page.js`, `fast-ext/src/updateCheck.js`.
- **Watch out:** `fast_locate scroll:true` is opt-in (default off) — don't make it
  default or every locate pays the scroll cost. The snapshot `hint` is advisory
  only; don't gate behavior on it. `updateCheck.js` tag stripping assumes the
  `ext-` prefix scheme — revisit if the release tag format changes.
- **Status:** committed + released as extension v0.4.3 (signed .crx +
  `updates.xml` bumped); synced to Windows copy — needs extension reload +
  Claude Code restart to take effect locally; relay deployed (`wrangler deploy`,
  2026-07-12).

## 2026-07-11 — issue-doc reconciliation (retroactive)
- **What:** Verified the following against current code and closed/deleted their
  issue docs (git history retains the deleted files):
  - **ISSUES-2026-06-08 #1–7** — all fixed (doc self-confirmed; deleted).
  - **BUG-1** (empty-string fill dropped) — fixed; fills now write empty strings
    through the same path (confirmed in the BUG-2 doc's session note).
  - **BUG-2** (batch inter-step rebind) — fixed; `settleIfNavigated` +
    urlBefore/after detection in `runBatch` (both `fast-dxt/server/handlers.js`
    and `fastlink-relay/src/mcp.js`), keyed off ACTUAL navigation. Doc deleted.
  - **BUG-3** — fixed (closed alongside the batch/fill work). Doc deleted.
  - **BUG-4** (fill_form response path) — fixed; `fast_fill_form` races `withSnap`
    against a `HANDLER_CAP_MS=8000` hard cap, `withSnap` bounded/non-fatal
    (`fast-ext/src/actions/page.js`). Doc deleted.
  - **aa.com #3** — `composed:true` shipped: fill/select paths dispatch
    `input`/`change` with `{bubbles:true, composed:true}` (`page.js`).
  - **FEEDBACK 06-21 #1** post-action snapshot (`withSnap` → `snapshotFresh:true`)
    + **#6** profile discoverability (`fast_profile` + `fast_status`
    `selectedInstall`, commit `0aa05f0`).
  - **FEEDBACK 06-24 P4** Gemini retry/backoff+OpenRouter fallback (`scout.js`);
    **P5** `fast_type` `force`/`allowIframe` (`input.js`); **P6** `fast_screenshot`
    `fresh` (`screenshot.js`); **P7** `fast_fill_vision` `freshCapture`-default +
    `verifyVisionFills` read-back (`tools.js`/`handlers.js`); **P8** target-tab pin.
- **Why:** The issue docs had drifted behind the code; this entry is the record
  that replaces the three deleted docs (ISSUES-2026-06-08, BUG-2, BUG-4).
- **Files:** deleted `docs/ISSUES-2026-06-08.md`,
  `docs/BUG-2-batch-inter-step-rebind.md`, `docs/BUG-4-fill-form-response-path.md`;
  updated `docs/FEEDBACK-aa-com-2026-06-10.md`, `FEEDBACK_2026-06-21.md`,
  `FEEDBACK_2026-06-24.md` (reconciled status blocks).
- **Still OPEN:** 06-21 #2 (conditional multi-step executor — batch still linear),
  #3 (transparent auto-wake/retry), #4 (atomic hidden-radio label-targeting),
  #5 (`fast_locate` top-N candidates); 06-24 P1 (unified "is FastLink ready?"
  preflight across the local + relay connectors).
- **Status:** documentation only; no code change in this entry.

## 2026-07-08 — Read-aloud widget: hidden by default, toggled from the popup
- **What:** The read-aloud pill no longer auto-mounts on every page. It now mounts
  only when toggled on via a new "🔊 Read aloud on this page" button in the toolbar
  popup (messages `fastlink:read-aloud-toggle` / `fastlink:read-aloud-state` to the
  content script). The ✕ button hides it fully again; removed the dead
  `readAloudEnabled` options flag; neural voices load lazily on first show.
- **Why:** The always-on bottom-right overlay was covering page buttons.
- **Files:** `fast-ext/src/readAloud.js`, `fast-ext/popup.html`, `fast-ext/popup.js`.
- **Watch out:** the popup button hides itself on tabs without a content script
  (chrome:// pages, tabs opened before the extension loaded — reload the tab).
  Shadow-DOM listeners now attach inside `mount()` (recreated per show), and
  `mount()` resets the paint signature so a re-show repaints fully.
- **Status:** in code / synced to Windows copy — needs extension reload at
  `chrome://extensions` to take effect.

## 2026-07-07 — `fast_select_option` react-select targeting fix
- **What:** Made react-select detection class-prefix-agnostic and scoped option
  matching to the specific react-select instance.
  1. Detect the control with `[class*="select__control"]` (covers both the default
     `react-select__control` prefix AND `select__control`, which Greenhouse uses),
     plus a structural fallback via the `react-select-<N>-input` id for any other
     custom prefix.
  2. New `containerLabel()` helper resolves a field's human label from a sibling
     `<label>` in the same field group — rescues inputs whose only `aria-label` is
     an opaque internal id (`question_6132162009`, `gender`, `veteran_status`).
  3. Option lookup now queries `[id^="react-select-<N>-option"]`, so it can only
     return THIS control's options and can never fall back to another react-select
     on the page.
- **Why:** Reported by the Claude-fellowship (Greenhouse form) session: on that form
  `fast_select_option` failed for every dropdown ("no matching option in listbox /
  no listbox detected") and, worse, returned the **phone-country widget's** dial-code
  list — because the old code matched only `.react-select__control`, missed
  Greenhouse's `select__` prefix, fell through to the generic ARIA branch, and there
  grabbed the first react-select's options on the page.
- **Files:** `fast-ext/src/actions/page.js` (containerLabel helper, findField label
  loop, react-select branch of `fast_select_option`).
- **Watch out:** `containerLabel` deliberately stops climbing when an ancestor holds
  >1 `<label>` (a form section, not a field) — don't loosen that or unrelated labels
  will match. The instance-scoped `[id^="react-select-N-option"]` query assumes the
  default react-select option-id scheme; the id-derived `-listbox` and
  `[class*="select__menu"]` fallbacks cover non-standard builds. Native `<select>`
  and generic-ARIA-listbox branches are untouched.
- **Status:** committed + pushed (`0aa05f0`), synced to Windows copy. Needs extension
  reload + live retest on the Greenhouse form.

## 2026-07-07 — `fast_upload` (file upload without the OS picker)
- **What:** New tool `fast_upload` that sets file(s) on a `<input type=file>` via the
  trusted CDP `DOM.setFileInputFiles` (fires input/change), bypassing the native OS
  file-picker that browser automation can't drive. Windows-path aware: accepts a
  Windows path (`C:\...`), a WSL mount path (`/mnt/c/...`), or a native WSL path
  (`/home/...`) — the WSL server resolves each to a path the Windows Chrome process
  can open (native WSL → `\\wsl.localhost\<distro>\...` via `wslpath`) and verifies it
  exists first. Targeting by `selector` / `text` / `index`, default = the page's only
  file input. Returns `{ uploaded, accepted:[{name,size,type}], input }`.
- **Why:** User request ("drop in a file upload feature, make it work from Windows");
  also the exact "nice-to-have" the fellowship session asked FastLink for.
- **Files:** `fast-ext/src/actions/upload.js` (new), `fast-ext/src/actions/index.js`
  (wire), `fast-dxt/server/handlers.js` (`handleUpload` + `wslpath` path resolver +
  add to MUTATING_TOOLS), `fast-dxt/server/tools.js` (schema),
  `fastlink-relay/tools.js` (mirror schema), `fastlink-relay/src/mcp.js` (mark
  mutating), overlay/background/sidepanel ("Uploading file" label).
- **Watch out:** Requires "Advanced control" (CDP) enabled — same gate as
  `fast_click_xy`. Searches the TOP document only (not cross-origin iframes). The
  extension-side `winifyPath` is idempotent (safe on already-Windows paths) so the
  relay passthrough handles `/mnt/c` and `C:/` too; native-WSL translation only
  happens server-side (WSL MCP), not on the relay.
- **Status:** committed + pushed (`0aa05f0`), synced to Windows copy. Needs extension
  reload + Claude Code restart (to expose the new tool) before it's callable.

---

## Pre-existing in-flight work (bundled into commit `0aa05f0`, 2026-07-07)

The tree already carried a large body of **uncommitted** changes when this log
started (~997 insertions across 24 files) — now committed together with the above in
`0aa05f0` (they were entangled in the same files, so couldn't be split cleanly). Not
written entry-by-entry because they predate the log. High level, so we don't
accidentally revert them:

- **BUG-5 multi-install routing** — arbitrary N Chrome profiles via slot labels
  (`fast_profile`, `fast_status` selectedInstall); broker demux by label.
  See `docs/BUG-5-multi-install-routing.md`. Touches `fast-dxt/broker/*`,
  `server/handlers.js`, `server/config.js`, `options.*`, `connection.js`.
- **scout.js** — substantial additions (~+200 lines).
- **Read-aloud / Edge neural TTS** — new `fast-ext/src/readAloud.js`,
  `fast-ext/src/edgeTts.js` (untracked).
- Feedback logs `FEEDBACK_2026-06-21.md`, `FEEDBACK_2026-06-24.md` (untracked).

> These should be reviewed and committed in logical chunks so the history reflects
> them; until then, treat them as load-bearing and don't overwrite.

## 2026-09-15 — hvm rig: --password-store=basic
- **What:** Chrome for Testing on the hvm rig launches with `--password-store=basic`.
- **Why:** every service-worker network path (fetch, WS, broker dial) was frozen ~24.8s after launch — Chrome's os_crypt keyring D-Bus timeout on a headless box; with the flag the extension attaches in ~19ms. Root-caused by the fixer via CDP; it made the rig look like a slot-busy stall and cost a bench cell.
- **Files:** `bench/hvm-rig.sh`.
- **Watch out:** rig-only flag; not a FastLink change. The same symptom will appear in any headless container without a keyring — the box10 image needs the same flag.
- **Status:** in code / rsynced to hvm; takes effect on the next Chrome restart there.

## 2026-09-15 — relay: fast_evaluate enabled for the operator account (config, no code)
- **What:** D1 `users` row for the operator (yjturetsky@gmail.com): `allow_evaluate=1, eval_allow_all=1` via `wrangler d1 execute --remote`. Was 0/0.
- **Why:** owner: "get it on for now and see the numbers" — both Grok models reached for fast_evaluate in 11/32 bench cells and every call was blocked, one wasted turn each. Aug's Grok speed came partly from pushing work into the page with it.
- **Files:** none (remote D1 data). Revert: same UPDATE with 0/0.
- **Watch out:** allow_all is honored only because the row is `is_operator=1`; other relay users still need per-origin allowlisting. The box10 container profile excludes fast_evaluate regardless (cookie reach).
- **Status:** applied remote / verified via the runner over the relay (see next entry or bench doc).

## 2026-09-15 — hvm rig: clear the whole Service Worker dir, not just ScriptCache
- **What:** `bench/hvm-rig.sh` removes `Default/Service Worker` (registration DB + cache) before launching Chrome.
- **Why:** c12716f deleted only `ScriptCache`; the registration DB still referenced the cached script and every SW start failed (`DidStartWorkerFail ockcja…: 5` in chrome.log), so the extension never connected and the overnight queue (4.3 feedback pass, 4.6 control, evaluate A/B) ran zero cells.
- **Files:** `bench/hvm-rig.sh`.
- **Watch out:** rig-only. Any container start script that wipes SW cache must wipe the registration with it.
- **Status:** in code / pushed / applied on hvm via git pull.

## 2026-09-15 — bench: observation readback pins `primary` by default
- **What:** `runCell` default `install` is now `primary` (was `null`).
- **Why:** since 8498cbe the local broker refuses unpinned calls when >1 profile is connected; an unpinned scoring readback returned errors for every checkpoint, so two 4.3 cells at 18:44Z scored all-FAIL while the runner had actually filled the form (runs.jsonl: all four GCP values set, 10 calls, 38s).
- **Files:** `bench/run.js`.
- **Watch out:** pass `--install <label>` explicitly when observing another profile; never rely on the broker default again.
- **Status:** in code.
