# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 5 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T18:16:53.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: pass 1 on 3b2c772 (grok-4.3, phase2): batch build; pass 2 on 7d43d8a: select hints skip autocompletes, ARIA aria-controls wall clock, runBridge deadline; pass 3 on bf55fda: suggestions signal on key_press+fill, trail poll 0.5s; pass 4 on 99001f6: fast_click commits suggestion entries (mouse); pass 5 on 1a73176 = mapsdir ONLY (keyboard commit of suggestions); pass 5 on 1a73176 (grok-4.3, toolset phase2);

Run store per pass (model/toolset): pass 1 = grok-4.3/phase2; pass 2 = grok-4.3/phase2; pass 3 = grok-4.3/phase2; pass 4 = grok-4.3/phase2; pass 5 = grok-4.3/phase2.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | pass 3 | pass 4 | pass 5 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 5.4s 5c m=9.2s | 5/6 5.1s 5c m=8.1s ! | 6/6 5.6s 5c m=9.2s | 6/6 7.2s 6c m=10.1s | – | 5.1s | 5.5s | 5 | 5–6/6 | 16.9s | −11.8s (-70%) |
| staticform | 12/12 8.4s 4c m=9.5s | 12/12 7.0s 4c m=8.5s | 11/12 8.7s 4c m=8.7s ! | 12/12 7.9s 4c m=8.5s | – | 7.0s | 8.2s | 4 | 11–12/12 | 30.4s | −23.4s (-77%) |
| overlay | 3/3 6.8s 5c m=8.7s | 3/3 8.2s 5c m=8.4s | 3/3 5.2s 4c m=6.6s | 3/3 8.6s 5c m=10.2s | – | 5.2s | 7.5s | 5 | 3–3/3 | 66.0s | −60.8s (-92%) |
| flightsearch | 10/10 9.5s 4c m=17.0s | 10/10 11.6s 6c m=13.9s | 10/10 9.7s 4c m=19.0s | 9/10 9.5s 6c m=13.8s ! | – | 9.5s | 9.6s | 5 | 9–10/10 | 23.3s | −13.8s (-59%) |
| mapsdir | 4/6 25.7s 9c m=11.7s ~ | 5/6 9.6s 7c m=13.4s ! | 4/6 36.8s 15c m=19.4s ~ | 5/6 93.8s 19c m=31.4s ! | 5/6 47.2s 13c m=23.1s ! | 9.6s | 36.8s | 13 | 4–5/6 | 41.9s | −32.3s (-77%) |
| extract | 22/22 1.2s 2c m=7.9s | 22/22 3.5s 3c m=7.7s | 22/22 2.1s 3c m=9.8s | 22/22 1.3s 2c m=20.1s | – | 1.2s | 1.7s | 2.5 | 22–22/22 | 5.7s | −4.5s (-79%) |

Totals over valid cells: 25 cells, 232/242 checkpoints, 149 tool calls, 345.8s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED, multipage#2=FINISHED, staticform#2=FINISHED, overlay#2=FINISHED, extract#2=FINISHED, flightsearch#2=FINISHED, mapsdir#2=FINISHED, multipage#3=FINISHED, staticform#3=FINISHED, overlay#3=FINISHED, extract#3=FINISHED, flightsearch#3=FINISHED, mapsdir#3=FINISHED, multipage#4=FINISHED, staticform#4=FINISHED, overlay#4=FINISHED, extract#4=FINISHED, flightsearch#4=FINISHED, mapsdir#4=FINISHED, mapsdir#5=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 42 | 0 | 56 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 27 | 8 | 578 | 7 | multipage, overlay, mapsdir |
| fast_tab | 25 | 0 | 367 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_text | 20 | 1 | 23 | 2 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_batch | 8 | 0 | 2413 | 0 | staticform, flightsearch |
| fast_key_press | 8 | 0 | 30 | 0 | mapsdir |
| fast_wait | 8 | 8 | 13840 | 8 | mapsdir |
| fast_fill | 6 | 0 | 128 | 0 | mapsdir |
| fast_select_option | 5 | 1 | 1414 | 0 | overlay, mapsdir |

Total: 149 calls across 9 distinct tools, 17 fumbles.

## Fumbles

- pass 1 mapsdir #7: `fast_wait` (text=min via) — failed → followed by fast_click — {"error":"Timed out waiting for \"min via\"","settling":false,"sinceMutMs":13605,"sinceNetMs":7452,"
- pass 1 mapsdir #8: `fast_click` (text=Times Square) — failed → followed by fast_select_option — {"error":"Found 1 match(es) for \"Times Square\" but none satisfied role=\"button\". Nothing was cli
- pass 2 overlay #3: `fast_click` (text=Ocean) — failed → followed by fast_select_option — {"error":"Found 1 match(es) for \"Ocean\" but none satisfied role=\"combobox\". Nothing was clicked 
- pass 3 extract #2: `fast_text` (selector=table.wikitable) — retry (same tool, same target)
- pass 3 mapsdir #7: `fast_click` (text=Times Square New York, Manhattan, NY) — failed → followed by fast_text — {"error":"No element matching \"Times Square New York, Manhattan, NY\". Nothing was clicked.","waite
- pass 3 mapsdir #9: `fast_click` (text=Times Square) — failed → followed by fast_key_press — {"error":"Found 1 match(es) for \"Times Square\" but none satisfied role=\"button\". Nothing was cli
- pass 3 mapsdir #11: `fast_wait` (text=min without traffic) — failed → followed by fast_snapshot — {"error":"Timed out waiting for \"min without traffic\"","settling":false,"sinceMutMs":21384,"sinceN
- pass 3 mapsdir #13: `fast_click` (text=Times Square New York, Manhattan, NY) — failed → followed by fast_click — {"error":"No element matching \"Times Square New York, Manhattan, NY\". Nothing was clicked.","waite
- pass 3 mapsdir #14: `fast_click` (text=Times Square New York, Manhattan, NY) — failed → followed by fast_click — {"error":"No element matching \"Times Square New York, Manhattan, NY\". Nothing was clicked.","waite
- pass 4 overlay #4: `fast_text` (selector=h4 + div[role=combobox]) — failed → followed by fast_snapshot — {"error":"selector \"h4 + div[role=combobox]\" not found","origin":"https://react-select.com"}
- pass 4 mapsdir #3: `fast_click` (text=Directions) — failed → followed by fast_click — {"error":"Only 1 matches for \"Directions\" (1 visible, 0 offscreen), index 8 out of range","matches
- pass 4 mapsdir #9: `fast_wait` (text=min) — failed → followed by fast_click — {"error":"Timed out waiting for \"min\"","settling":false,"sinceMutMs":14727,"sinceNetMs":9868,"head
- pass 4 mapsdir #12: `fast_wait` (text=min via) — failed → followed by fast_click — {"error":"Timed out waiting for \"min via\"","settling":false,"sinceMutMs":33759,"sinceNetMs":7916,"
- pass 4 mapsdir #15: `fast_wait` (text=min via) — failed → followed by fast_snapshot — {"error":"page busy","phase":"fast_wait","elapsedMs":20000,"hint":"fast_wait did not return within 2
- pass 4 mapsdir #18: `fast_wait` (text=via I-678 S) — failed → followed by fast_snapshot — {"error":"page busy","phase":"fast_wait","elapsedMs":20001,"hint":"fast_wait did not return within 2
- pass 5 mapsdir #6: `fast_wait` (text=route options) — failed → followed by fast_key_press — {"error":"Timed out waiting for \"route options\"","settling":false,"sinceMutMs":12799,"sinceNetMs":
- pass 5 mapsdir #10: `fast_wait` (text=min) — failed → followed by fast_text — {"error":"Timed out waiting for \"min\"","settling":false,"sinceMutMs":33801,"sinceNetMs":6382,"head
