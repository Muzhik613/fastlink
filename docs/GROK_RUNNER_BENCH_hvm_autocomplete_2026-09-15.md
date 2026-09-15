# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 3 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T19:49:28.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: autocomplete commit signal (committed:false+suggestions per field), fast_wait autocomplete hint, gate: read/wait overtaken + claimMismatch + do-every-step prompt, scorer literal \n, select_option text-first resolve; pass 1 on 4584943 (grok-4.3, toolset phase2);

Run store per pass (model/toolset): pass 1 = grok-4.3/phase2.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | pass 3 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 5.4s 5c m=8.9s | – | – | 5.4s | 5.4s | 5 | 6–6/6 | 16.9s | −11.5s (-68%) |
| staticform | 12/12 7.2s 4c m=9.2s | – | – | 7.2s | 7.2s | 4 | 12–12/12 | 30.4s | −23.2s (-76%) |
| overlay | 3/3 9.4s 6c m=11.2s | – | – | 9.4s | 9.4s | 6 | 3–3/3 | 66.0s | −56.6s (-86%) |
| flightsearch | 10/10 14.8s 7c m=17.8s | – | – | 14.8s | 14.8s | 7 | 10–10/10 | 23.3s | −8.5s (-37%) |
| mapsdir | 6/6 18.6s 7c m=16.3s | – | – | 18.6s | 18.6s | 7 | 6–6/6 | 41.9s | −23.3s (-56%) |
| extract | 22/22 3.2s 3c m=7.7s | – | – | 3.2s | 3.2s | 3 | 22–22/22 | 5.7s | −2.5s (-43%) |

Totals over valid cells: 6 cells, 59/59 checkpoints, 32 tool calls, 58.6s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 13 | 0 | 89 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 6 | 0 | 341 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 4 | 1 | 548 | 1 | multipage, overlay, mapsdir |
| fast_fill | 2 | 0 | 427 | 0 | flightsearch, mapsdir |
| fast_select_option | 2 | 0 | 474 | 0 | overlay, flightsearch |
| fast_text | 2 | 0 | 32 | 0 | overlay, extract |
| fast_batch | 1 | 0 | 2047 | 0 | staticform |
| fast_key_press | 1 | 0 | 217 | 0 | mapsdir |
| fast_wait | 1 | 1 | 10086 | 1 | mapsdir |

Total: 32 calls across 9 distinct tools, 2 fumbles.

## Fumbles

- pass 1 overlay #3: `fast_click` (text=Ocean) — failed → followed by fast_select_option — {"error":"Found 1 match(es) for \"Ocean\" but none satisfied role=\"combobox\". Nothing was clicked 
- pass 1 mapsdir #6: `fast_wait` (text=route options) — failed → followed by fast_snapshot — {"error":"Timed out waiting for \"route options\"","settling":false,"sinceMutMs":2485,"sinceNetMs":8
