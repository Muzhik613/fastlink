# Grok runner bench — hvm, local transport (2026-09-16)

Client `grok_runner`, 1 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-16T18:27:15.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: pass 1 on b62ad86 (grok-4.6, toolset phase2, gate on);

Run store per pass (model/toolset/gate): pass 1 = grok-4.6/phase2/gate on.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 8.3s 6c m=13.9s | 8.3s | 8.3s | 6 | 6–6/6 | 16.9s | −8.6s (-51%) |
| staticform | 12/12 16.5s 4c m=25.4s | 16.5s | 16.5s | 4 | 12–12/12 | 30.4s | −13.9s (-46%) |
| overlay | 3/3 13.0s 5c m=16.0s | 13.0s | 13.0s | 5 | 3–3/3 | 66.0s | −53.0s (-80%) |
| flightsearch | 10/10 70.3s 12c m=72.9s | 70.3s | 70.3s | 12 | 10–10/10 | 23.3s | +47.0s (202%) |
| mapsdir | 6/6 28.3s 7c m=43.1s | 28.3s | 28.3s | 7 | 6–6/6 | 41.9s | −13.6s (-32%) |
| extract | 20/22 4.2s 3c m=14.4s ! | 4.2s | 4.2s | 3 | 20–20/22 | 5.7s | −1.5s (-26%) |

Totals over valid cells: 6 cells, 57/59 checkpoints, 37 tool calls, 140.6s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_click | 10 | 0 | 264 | 2 | multipage, flightsearch, mapsdir |
| fast_snapshot | 9 | 0 | 62 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_tab | 6 | 0 | 329 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_wait | 4 | 0 | 218 | 0 | multipage, mapsdir, extract |
| fast_batch | 2 | 0 | 2276 | 0 | staticform, flightsearch |
| fast_fill | 2 | 0 | 460 | 0 | flightsearch, mapsdir |
| fast_select_option | 2 | 1 | 472 | 1 | overlay |
| fast_scroll | 1 | 0 | 202 | 0 | flightsearch |
| fast_text | 1 | 0 | 45 | 0 | extract |

Total: 37 calls across 9 distinct tools, 3 fumbles.

## Fumbles

- pass 1 multipage #2: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 1 multipage #5: `fast_click` (text=It's Only the Himalayas) — switched to fast_wait on the same target
- pass 1 overlay #3: `fast_select_option` — failed → followed by fast_select_option — {"error":"2 visible dropdown(s) match \"Single\" — nothing was selected","candidates":[{"tag":"input
