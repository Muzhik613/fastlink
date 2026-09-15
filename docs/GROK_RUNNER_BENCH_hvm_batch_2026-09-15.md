# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 3 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T18:16:53.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: pass 1 on 3b2c772 (grok-4.3, phase2): batch build; pass 2 on 7d43d8a: select hints skip autocompletes, ARIA aria-controls wall clock, runBridge deadline; pass 3 on fe1614e: suggestions signal on key_press+fill, trail poll 0.5s; pass 3 on fe1614e (grok-4.3, toolset phase2);

Run store per pass (model/toolset): pass 1 = grok-4.3/phase2; pass 2 = grok-4.3/phase2; pass 3 = grok-4.3/phase2.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | pass 3 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 5.4s 5c m=9.2s | 5/6 5.1s 5c m=8.1s ! | 6/6 5.6s 5c m=9.2s | 5.1s | 5.4s | 5 | 5–6/6 | 16.9s | −11.8s (-70%) |
| staticform | 12/12 8.4s 4c m=9.5s | 12/12 7.0s 4c m=8.5s | 11/12 8.7s 4c m=8.7s ! | 7.0s | 8.4s | 4 | 11–12/12 | 30.4s | −23.4s (-77%) |
| overlay | 3/3 6.8s 5c m=8.7s | 3/3 8.2s 5c m=8.4s | 3/3 5.2s 4c m=6.6s | 5.2s | 6.8s | 5 | 3–3/3 | 66.0s | −60.8s (-92%) |
| flightsearch | 10/10 9.5s 4c m=17.0s | 10/10 11.6s 6c m=13.9s | 10/10 9.7s 4c m=19.0s | 9.5s | 9.7s | 4 | 10–10/10 | 23.3s | −13.8s (-59%) |
| mapsdir | 4/6 25.7s 9c m=11.7s ~ | 5/6 9.6s 7c m=13.4s ! | 4/6 36.8s 15c m=19.4s ~ | 9.6s | 25.7s | 9 | 4–5/6 | 41.9s | −32.3s (-77%) |
| extract | 22/22 1.2s 2c m=7.9s | 22/22 3.5s 3c m=7.7s | 22/22 2.1s 3c m=9.8s | 1.2s | 2.1s | 3 | 22–22/22 | 5.7s | −4.5s (-79%) |

Totals over valid cells: 18 cells, 170/177 checkpoints, 94 tool calls, 170.2s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED, multipage#2=FINISHED, staticform#2=FINISHED, overlay#2=FINISHED, extract#2=FINISHED, flightsearch#2=FINISHED, mapsdir#2=FINISHED, multipage#3=FINISHED, staticform#3=FINISHED, overlay#3=FINISHED, extract#3=FINISHED, flightsearch#3=FINISHED, mapsdir#3=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 26 | 0 | 69 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 18 | 0 | 346 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 16 | 7 | 822 | 6 | multipage, overlay, mapsdir |
| fast_text | 15 | 0 | 25 | 1 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_batch | 6 | 0 | 2641 | 0 | staticform, flightsearch |
| fast_key_press | 4 | 0 | 34 | 0 | mapsdir |
| fast_select_option | 4 | 1 | 1516 | 0 | overlay, mapsdir |
| fast_fill | 3 | 0 | 54 | 0 | mapsdir |
| fast_wait | 2 | 2 | 10145 | 2 | mapsdir |

Total: 94 calls across 9 distinct tools, 9 fumbles.

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
