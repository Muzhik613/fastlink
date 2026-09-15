# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 1 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T18:16:53.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: batch build 3b2c772: fast_batch never aborts+ifFound, fast_fill{fields}, fillable nudge, select hints, offscreen matching, fast_wait selector/emptyContainer/text+idle; pass 1 on 3b2c772 (grok-4.3, toolset phase2);

Run store per pass (model/toolset): pass 1 = grok-4.3/phase2.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 5.4s 5c m=9.2s | 5.4s | 5.4s | 5 | 6–6/6 | 16.9s | −11.5s (-68%) |
| staticform | 12/12 8.4s 4c m=9.5s | 8.4s | 8.4s | 4 | 12–12/12 | 30.4s | −22.0s (-72%) |
| overlay | 3/3 6.8s 5c m=8.7s | 6.8s | 6.8s | 5 | 3–3/3 | 66.0s | −59.2s (-90%) |
| flightsearch | 10/10 9.5s 4c m=17.0s | 9.5s | 9.5s | 4 | 10–10/10 | 23.3s | −13.8s (-59%) |
| mapsdir | 4/6 25.7s 9c m=11.7s ~ | 25.7s | 25.7s | 9 | 4–4/6 | 41.9s | −16.2s (-39%) |
| extract | 22/22 1.2s 2c m=7.9s | 1.2s | 1.2s | 2 | 22–22/22 | 5.7s | −4.5s (-79%) |

Totals over valid cells: 6 cells, 57/59 checkpoints, 29 tool calls, 57.1s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 8 | 0 | 49 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_tab | 6 | 0 | 366 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 4 | 1 | 544 | 1 | multipage, mapsdir |
| fast_text | 4 | 0 | 25 | 0 | staticform, overlay, mapsdir, extract |
| fast_batch | 2 | 0 | 2784 | 0 | staticform, flightsearch |
| fast_select_option | 2 | 1 | 2031 | 0 | overlay, mapsdir |
| fast_fill | 1 | 0 | 59 | 0 | mapsdir |
| fast_key_press | 1 | 0 | 34 | 0 | mapsdir |
| fast_wait | 1 | 1 | 10162 | 1 | mapsdir |

Total: 29 calls across 9 distinct tools, 2 fumbles.

## Fumbles

- pass 1 mapsdir #7: `fast_wait` (text=min via) — failed → followed by fast_click — {"error":"Timed out waiting for \"min via\"","settling":false,"sinceMutMs":13605,"sinceNetMs":7452,"
- pass 1 mapsdir #8: `fast_click` (text=Times Square) — failed → followed by fast_select_option — {"error":"Found 1 match(es) for \"Times Square\" but none satisfied role=\"button\". Nothing was cli
