# Grok runner bench — hvm, local transport (2026-09-16)

Client `grok_runner`, 1 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-16T18:35:49.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: pass 1 on 9267557 (grok-4.3, toolset default, gate on);

Run store per pass (model/toolset/gate): pass 1 = grok-4.3/default/gate on.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 7.1s 5c m=11.1s | 7.1s | 7.1s | 5 | 6–6/6 | 16.9s | −9.8s (-58%) |
| staticform | 12/12 8.4s 5c m=14.5s | 8.4s | 8.4s | 5 | 12–12/12 | 30.4s | −22.0s (-72%) |
| overlay | 3/3 3.8s 3c m=6.8s | 3.8s | 3.8s | 3 | 3–3/3 | 66.0s | −62.2s (-94%) |
| flightsearch | 8/10 15.2s 7c m=16.4s ! | 15.2s | 15.2s | 7 | 8–8/10 | 23.3s | −8.1s (-35%) |
| mapsdir | 6/6 15.2s 6c m=15.7s | 15.2s | 15.2s | 6 | 6–6/6 | 41.9s | −26.7s (-64%) |
| extract | 22/22 7.4s 4c m=13.3s | 7.4s | 7.4s | 4 | 22–22/22 | 5.7s | +1.7s (31%) |

Totals over valid cells: 6 cells, 57/59 checkpoints, 30 tool calls, 57.2s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 7 | 0 | 119 | 0 | multipage, staticform, flightsearch, mapsdir, extract |
| fast_tab | 6 | 0 | 283 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 4 | 0 | 65 | 0 | multipage, staticform |
| fast_select_option | 4 | 1 | 297 | 1 | overlay, flightsearch |
| fast_fill | 3 | 0 | 786 | 0 | staticform, flightsearch, mapsdir |
| fast_batch | 2 | 0 | 2629 | 0 | flightsearch, mapsdir |
| fast_scout | 2 | 0 | 2732 | 0 | flightsearch, mapsdir |
| fast_key_press | 1 | 0 | 44 | 0 | mapsdir |
| fast_text | 1 | 0 | 165 | 0 | extract |

Total: 30 calls across 9 distinct tools, 1 fumbles.

## Fumbles

- pass 1 overlay #2: `fast_select_option` — failed → followed by fast_select_option — {"error":"2 visible dropdown(s) match \"Single\" — nothing was selected","candidates":[{"tag":"input
