# Grok runner bench — hvm, local transport (2026-09-16)

Client `grok_runner`, 1 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-16T18:37:57.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: pass 1 on 2b9e4be (grok-4.6, toolset default, gate on);

Run store per pass (model/toolset/gate): pass 1 = grok-4.6/default/gate on.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 12.9s 8c m=18.7s | 12.9s | 12.9s | 8 | 6–6/6 | 16.9s | −4.0s (-24%) |
| staticform | 12/12 47.9s 9c m=55.0s | 47.9s | 47.9s | 9 | 12–12/12 | 30.4s | +17.5s (58%) |
| overlay | 3/3 17.3s 6c m=23.2s | 17.3s | 17.3s | 6 | 3–3/3 | 66.0s | −48.7s (-74%) |
| flightsearch | 10/10 36.1s 16c m=42.5s | 36.1s | 36.1s | 16 | 10–10/10 | 23.3s | +12.8s (55%) |
| mapsdir | 6/6 28.8s 9c m=35.2s | 28.8s | 28.8s | 9 | 6–6/6 | 41.9s | −13.1s (-31%) |
| extract | 22/22 19.2s 4c m=37.5s | 19.2s | 19.2s | 4 | 22–22/22 | 5.7s | +13.5s (236%) |

Totals over valid cells: 6 cells, 59/59 checkpoints, 52 tool calls, 162.1s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_wait | 11 | 0 | 272 | 2 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 7 | 0 | 257 | 2 | multipage, staticform, flightsearch, mapsdir |
| fast_snapshot | 7 | 0 | 42 | 0 | multipage, staticform, flightsearch, mapsdir |
| fast_tab | 6 | 0 | 372 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 5 | 0 | 268 | 0 | staticform, flightsearch, mapsdir |
| fast_status | 5 | 0 | 7 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_prewarm | 3 | 0 | 2 | 0 | staticform, flightsearch, mapsdir |
| fast_text | 3 | 0 | 38 | 0 | staticform, overlay, extract |
| fast_select_option | 2 | 1 | 466 | 1 | overlay |
| fast_batch | 1 | 0 | 330 | 0 | flightsearch |
| fast_evaluate | 1 | 0 | 51 | 0 | extract |
| fast_scroll | 1 | 0 | 39 | 0 | flightsearch |

Total: 52 calls across 12 distinct tools, 5 fumbles.

## Fumbles

- pass 1 multipage #3: `fast_wait` (text=Travel) — switched to fast_click on the same target
- pass 1 multipage #4: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 1 multipage #7: `fast_click` (text=It's Only the Himalayas) — switched to fast_wait on the same target
- pass 1 overlay #4: `fast_select_option` — failed → followed by fast_select_option — {"error":"2 visible dropdown(s) match \"Single\" — nothing was selected","candidates":[{"tag":"input
- pass 1 mapsdir #4: `fast_wait` (text=Directions) — switched to fast_click on the same target
