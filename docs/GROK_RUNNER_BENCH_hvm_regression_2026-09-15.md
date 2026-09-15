# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 2 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T23:30:53.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: regression after holdout fixes on d6df710, 4.3/phase2 n=2; pass 1 on d6df710 (grok-4.3, toolset phase2, gate on);

Run store per pass (model/toolset/gate): pass 1 = grok-4.3/phase2/gate on.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 0/6 0.0s 0c X~ | – | – | – | – | – | 16.9s | – |
| staticform | 0/12 0.0s 0c X~ | – | – | – | – | – | 30.4s | – |
| overlay | 0/3 0.0s 0c X~ | – | – | – | – | – | 66.0s | – |
| flightsearch | 1/10 10.7s 7c m=19.8s ! | – | 10.7s | 10.7s | 7 | 1–1/10 | 23.3s | −12.6s (-54%) |
| mapsdir | 6/6 10.6s 7c m=16.0s | – | 10.6s | 10.6s | 7 | 6–6/6 | 41.9s | −31.3s (-75%) |
| extract | 0/2 0.0s 0c X~ | – | – | – | – | – | 5.7s | – |

Totals over valid cells: 2 cells, 7/16 checkpoints, 14 tool calls, 21.3s wall.

Outcomes: multipage#1=NO_ACTIVITY (runner exited (code 1) without a single FastLink call), staticform#1=NO_ACTIVITY (runner exited (code 1) without a single FastLink call), overlay#1=NO_ACTIVITY (runner exited (code 1) without a single FastLink call), extract#1=NO_ACTIVITY (runner exited (code 1) without a single FastLink call), flightsearch#1=FINISHED, mapsdir#1=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 5 | 3 | 44 | 3 | flightsearch, mapsdir |
| fast_tab | 3 | 0 | 204 | 0 | flightsearch, mapsdir |
| fast_fill | 2 | 0 | 1141 | 0 | mapsdir |
| fast_nav | 2 | 0 | 427 | 0 | flightsearch |
| fast_click | 1 | 0 | 507 | 0 | mapsdir |
| fast_key_press | 1 | 0 | 229 | 0 | mapsdir |

Total: 14 calls across 6 distinct tools, 3 fumbles.

## Fumbles

- pass 1 flightsearch #2: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242225 (Frame with ID 0 is showing error
- pass 1 flightsearch #4: `fast_snapshot` — failed → followed by fast_tab — {"error":"fast_snapshot: could not inject into target tab 81242225 (Frame with ID 0 is showing error
- pass 1 flightsearch #6: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242226 (Frame with ID 0 is showing error
