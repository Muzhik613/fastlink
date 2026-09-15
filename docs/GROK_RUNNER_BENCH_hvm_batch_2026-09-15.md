# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 2 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T18:16:53.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: pass 1 on 3b2c772 (grok-4.3, phase2): batch build; pass 2 on 32f28f0: select hints skip autocompletes, ARIA aria-controls wall clock, runBridge deadline; pass 2 on 32f28f0 (grok-4.3, toolset phase2);

Run store per pass (model/toolset): pass 1 = grok-4.3/phase2; pass 2 = grok-4.3/phase2.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 5.4s 5c m=9.2s | 5/6 5.1s 5c m=8.1s ! | 5.1s | 5.3s | 5 | 5–6/6 | 16.9s | −11.8s (-70%) |
| staticform | 12/12 8.4s 4c m=9.5s | 12/12 7.0s 4c m=8.5s | 7.0s | 7.7s | 4 | 12–12/12 | 30.4s | −23.4s (-77%) |
| overlay | 3/3 6.8s 5c m=8.7s | 3/3 8.2s 5c m=8.4s | 6.8s | 7.5s | 5 | 3–3/3 | 66.0s | −59.2s (-90%) |
| flightsearch | 10/10 9.5s 4c m=17.0s | 10/10 11.6s 6c m=13.9s | 9.5s | 10.5s | 5 | 10–10/10 | 23.3s | −13.8s (-59%) |
| mapsdir | 4/6 25.7s 9c m=11.7s ~ | 5/6 9.6s 7c m=13.4s ! | 9.6s | 17.7s | 8 | 4–5/6 | 41.9s | −32.3s (-77%) |
| extract | 22/22 1.2s 2c m=7.9s | 22/22 3.5s 3c m=7.7s | 1.2s | 2.4s | 2.5 | 22–22/22 | 5.7s | −4.5s (-79%) |

Totals over valid cells: 12 cells, 114/118 checkpoints, 59 tool calls, 102.0s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED, multipage#2=FINISHED, staticform#2=FINISHED, overlay#2=FINISHED, extract#2=FINISHED, flightsearch#2=FINISHED, mapsdir#2=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 17 | 0 | 84 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 12 | 0 | 368 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_text | 10 | 0 | 27 | 0 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 8 | 2 | 546 | 2 | multipage, overlay, mapsdir |
| fast_batch | 4 | 0 | 2571 | 0 | staticform, flightsearch |
| fast_select_option | 3 | 1 | 1690 | 0 | overlay, mapsdir |
| fast_fill | 2 | 0 | 60 | 0 | mapsdir |
| fast_key_press | 2 | 0 | 38 | 0 | mapsdir |
| fast_wait | 1 | 1 | 10162 | 1 | mapsdir |

Total: 59 calls across 9 distinct tools, 3 fumbles.

## Fumbles

- pass 1 mapsdir #7: `fast_wait` (text=min via) — failed → followed by fast_click — {"error":"Timed out waiting for \"min via\"","settling":false,"sinceMutMs":13605,"sinceNetMs":7452,"
- pass 1 mapsdir #8: `fast_click` (text=Times Square) — failed → followed by fast_select_option — {"error":"Found 1 match(es) for \"Times Square\" but none satisfied role=\"button\". Nothing was cli
- pass 2 overlay #3: `fast_click` (text=Ocean) — failed → followed by fast_select_option — {"error":"Found 1 match(es) for \"Ocean\" but none satisfied role=\"combobox\". Nothing was clicked 
