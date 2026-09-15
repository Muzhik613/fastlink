# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 1 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T23:52:22.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: pass 1 on 7de370d (grok-4.3, toolset phase2, gate on);

Run store per pass (model/toolset/gate): pass 1 = grok-4.3/phase2/gate on.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 7.0s 6c m=10.0s | 7.0s | 7.0s | 6 | 6–6/6 | 16.9s | −9.9s (-59%) |
| staticform | 12/12 7.6s 3c m=10.8s | 7.6s | 7.6s | 3 | 12–12/12 | 30.4s | −22.8s (-75%) |
| overlay | 3/3 4.4s 4c m=6.3s | 4.4s | 4.4s | 4 | 3–3/3 | 66.0s | −61.6s (-93%) |
| flightsearch | 10/10 11.2s 5c m=10.7s | 11.2s | 11.2s | 5 | 10–10/10 | 23.3s | −12.1s (-52%) |
| mapsdir | 6/6 19.4s 7c m=19.1s | 19.4s | 19.4s | 7 | 6–6/6 | 41.9s | −22.5s (-54%) |
| extract | 22/22 3.2s 3c m=8.2s | 3.2s | 3.2s | 3 | 22–22/22 | 5.7s | −2.5s (-43%) |

Totals over valid cells: 6 cells, 59/59 checkpoints, 28 tool calls, 52.8s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 8 | 0 | 139 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 6 | 0 | 310 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 3 | 0 | 220 | 2 | multipage, mapsdir |
| fast_wait | 3 | 1 | 3408 | 1 | multipage, mapsdir |
| fast_batch | 2 | 0 | 3319 | 0 | staticform, flightsearch |
| fast_fill | 2 | 0 | 202 | 0 | flightsearch, mapsdir |
| fast_select_option | 2 | 1 | 513 | 1 | overlay |
| fast_key_press | 1 | 0 | 37 | 0 | mapsdir |
| fast_text | 1 | 0 | 36 | 0 | extract |

Total: 28 calls across 9 distinct tools, 4 fumbles.

## Fumbles

- pass 1 multipage #2: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 1 multipage #5: `fast_click` (text=It's Only the Himalayas) — switched to fast_wait on the same target
- pass 1 overlay #3: `fast_select_option` — failed → followed by fast_select_option — {"error":"2 visible dropdown(s) match \"Single\" — nothing was selected","candidates":[{"tag":"input
- pass 1 mapsdir #6: `fast_wait` (text=route options) — failed → followed by fast_snapshot — {"error":"Timed out waiting for \"route options\"","settling":false,"sinceMutMs":2203,"sinceNetMs":2
