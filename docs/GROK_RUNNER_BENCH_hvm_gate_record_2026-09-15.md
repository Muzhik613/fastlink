# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 3 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T20:32:47.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: 4.3 alone: gate record-only on 3839858 pass 1 on 3839858 (grok-4.3, toolset phase2, gate record); pass 2 on 4c2ee8f (grok-4.3, toolset phase2, gate record);

Run store per pass (model/toolset/gate): pass 1 = grok-4.3/phase2/gate record; pass 2 = grok-4.3/phase2/gate record.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | pass 3 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 5.1s 5c m=8.1s | 6/6 8.1s 7c m=11.7s | – | 5.1s | 6.6s | 6 | 6–6/6 | 16.9s | −11.8s (-70%) |
| staticform | 12/12 8.2s 4c m=8.3s | 12/12 7.5s 4c m=9.5s | – | 7.5s | 7.8s | 4 | 12–12/12 | 30.4s | −22.9s (-75%) |
| overlay | 3/3 7.3s 4c m=6.9s | 3/3 3.7s 3c m=5.6s | – | 3.7s | 5.5s | 3.5 | 3–3/3 | 66.0s | −62.3s (-94%) |
| flightsearch | 10/10 11.0s 5c m=15.2s | 10/10 8.9s 4c m=10.8s | – | 8.9s | 9.9s | 4.5 | 10–10/10 | 23.3s | −14.4s (-62%) |
| mapsdir | 6/6 7.6s 6c m=10.0s | 5/6 22.2s 7c m=14.2s ! | – | 7.6s | 14.9s | 6.5 | 5–6/6 | 41.9s | −34.3s (-82%) |
| extract | 22/22 5.0s 3c m=9.6s | 22/22 4.9s 3c m=10.7s | – | 4.9s | 4.9s | 3 | 22–22/22 | 5.7s | −0.8s (-14%) |

Totals over valid cells: 12 cells, 117/118 checkpoints, 55 tool calls, 99.4s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED, multipage#2=FINISHED, staticform#2=FINISHED, overlay#2=FINISHED, extract#2=FINISHED, flightsearch#2=FINISHED, mapsdir#2=FINISHED.

## Gate would-refuse (gate=record)

- pass 1 overlay: scored 3/3 (full — the gate would have been WRONG) — no tool has read the page since your last fast_select_option; call fast_snapshot or fast_text (its own auto-snapshot is not a read-back) and cite what it return | your last attempt to fast_click "Ocean" failed and was never retried; retry it or explain in `result` why it is not needed
- pass 2 overlay: scored 3/3 (full — the gate would have been WRONG) — no tool has read the page since your last fast_select_option; call fast_snapshot or fast_text (its own auto-snapshot is not a read-back) and cite what it return
- pass 1 flightsearch: scored 10/10 (full — the gate would have been WRONG) — your result says "opened" but no fast_click / fast_nav / fast_tab (beyond the first page load) call succeeded. If the task asked you to open, do it now; only if
- pass 2 flightsearch: scored 10/10 (full — the gate would have been WRONG) — your result says "opened" but no fast_click / fast_nav / fast_tab (beyond the first page load) call succeeded. If the task asked you to open, do it now; only if
- pass 2 mapsdir: scored 5/6 (short — the gate would have been RIGHT) — evidence does not quote any tool result of this run — copy a phrase exactly as the last fast_snapshot/fast_text result showed it (a content text, a field value, | your last attempt to fast_wait "Driving directions" failed and was never retried; retry it or explain in `result` why it is not needed

## Overclaims (reported done, score < total)

- pass 2 mapsdir: reported done at 5/6 (the gate would have refused)

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 19 | 0 | 118 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 12 | 0 | 349 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 7 | 1 | 420 | 3 | multipage, overlay, mapsdir |
| fast_batch | 4 | 0 | 2687 | 0 | staticform, flightsearch |
| fast_text | 4 | 0 | 37 | 0 | flightsearch, mapsdir, extract |
| fast_wait | 3 | 1 | 3413 | 1 | multipage, mapsdir |
| fast_fill | 2 | 0 | 341 | 0 | mapsdir |
| fast_key_press | 2 | 0 | 34 | 0 | mapsdir |
| fast_select_option | 2 | 0 | 889 | 0 | overlay |

Total: 55 calls across 9 distinct tools, 4 fumbles.

## Fumbles

- pass 1 overlay #3: `fast_click` (text=Ocean) — failed → followed by fast_select_option — {"error":"Found 1 match(es) for \"Ocean\" but none satisfied role=\"combobox\". Nothing was clicked 
- pass 2 multipage #3: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 2 multipage #6: `fast_click` (text=It's Only the Himalayas) — switched to fast_wait on the same target
- pass 2 mapsdir #6: `fast_wait` (text=Driving directions) — failed → followed by fast_text — {"error":"Timed out waiting for \"Driving directions\"","settling":false,"sinceMutMs":2041,"sinceNet
