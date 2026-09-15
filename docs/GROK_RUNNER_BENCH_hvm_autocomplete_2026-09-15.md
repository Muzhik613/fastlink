# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 3 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T19:49:28.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: autocomplete commit signal (committed:false+suggestions per field), fast_wait autocomplete hint, gate: read/wait overtaken + claimMismatch + do-every-step prompt, scorer literal \n, select_option text-first resolve; pass 1 on 4584943 (grok-4.3, toolset phase2); pass 2 on 13cbc70 (grok-4.3, toolset phase2);

Run store per pass (model/toolset): pass 1 = grok-4.3/phase2; pass 2 = grok-4.3/phase2.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | pass 3 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 5.4s 5c m=8.9s | 6/6 4.8s 5c m=8.6s | – | 4.8s | 5.1s | 5 | 6–6/6 | 16.9s | −12.1s (-71%) |
| staticform | 12/12 7.2s 4c m=9.2s | 12/12 7.7s 4c m=9.6s | – | 7.2s | 7.5s | 4 | 12–12/12 | 30.4s | −23.2s (-76%) |
| overlay | 3/3 9.4s 6c m=11.2s | 3/3 6.4s 4c m=7.9s | – | 6.4s | 7.9s | 5 | 3–3/3 | 66.0s | −59.6s (-90%) |
| flightsearch | 10/10 14.8s 7c m=17.8s | 10/10 10.6s 4c m=13.8s | – | 10.6s | 12.7s | 5.5 | 10–10/10 | 23.3s | −12.7s (-55%) |
| mapsdir | 6/6 18.6s 7c m=16.3s | 6/6 8.6s 7c m=12.1s | – | 8.6s | 13.6s | 7 | 6–6/6 | 41.9s | −33.3s (-79%) |
| extract | 22/22 3.2s 3c m=7.7s | 22/22 4.5s 3c m=11.2s | – | 3.2s | 3.9s | 3 | 22–22/22 | 5.7s | −2.5s (-43%) |

Totals over valid cells: 12 cells, 118/118 checkpoints, 59 tool calls, 101.4s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED, multipage#2=FINISHED, staticform#2=FINISHED, overlay#2=FINISHED, extract#2=FINISHED, flightsearch#2=FINISHED, mapsdir#2=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 24 | 0 | 88 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 12 | 0 | 493 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 7 | 1 | 391 | 1 | multipage, overlay, mapsdir |
| fast_batch | 3 | 0 | 2161 | 0 | staticform, flightsearch |
| fast_fill | 3 | 0 | 378 | 0 | flightsearch, mapsdir |
| fast_select_option | 3 | 0 | 610 | 0 | overlay, flightsearch |
| fast_text | 3 | 0 | 39 | 0 | overlay, extract |
| fast_key_press | 2 | 0 | 224 | 0 | mapsdir |
| fast_wait | 2 | 1 | 5134 | 1 | mapsdir |

Total: 59 calls across 9 distinct tools, 2 fumbles.

## Fumbles

- pass 1 overlay #3: `fast_click` (text=Ocean) — failed → followed by fast_select_option — {"error":"Found 1 match(es) for \"Ocean\" but none satisfied role=\"combobox\". Nothing was clicked 
- pass 1 mapsdir #6: `fast_wait` (text=route options) — failed → followed by fast_snapshot — {"error":"Timed out waiting for \"route options\"","settling":false,"sinceMutMs":2485,"sinceNetMs":8
