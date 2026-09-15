# Grok runner bench — hvm, local transport (2026-09-15)

> Copy of the doc written by `bench/hvm-run.sh` on hvm (commits b4e1e7e / 28e8a4f / 8098c44 there, not pushed). Run 18:40:43Z–18:45:48Z, PASSES=3, build c3ec766, grok-4.3 / phase2.

Client `grok_runner`, 3 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T18:40:43.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: confirming passes on final batch-first build c3ec766, 4.3/phase2 n=3; pass 1 on c3ec766 (grok-4.3, toolset phase2); pass 2 on b4e1e7e (grok-4.3, toolset phase2); pass 3 on 28e8a4f (grok-4.3, toolset phase2);

Run store per pass (model/toolset): pass 1 = grok-4.3/phase2; pass 2 = grok-4.3/phase2; pass 3 = grok-4.3/phase2.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | pass 3 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 5.4s 5c m=8.1s | 6/6 7.0s 6c m=10.2s | 6/6 6.5s 6c m=9.7s | 5.4s | 6.5s | 6 | 6–6/6 | 16.9s | −11.5s (-68%) |
| staticform | 12/12 10.8s 4c m=10.9s | 12/12 9.5s 4c m=9.7s | 12/12 9.6s 4c m=10.1s | 9.5s | 9.6s | 4 | 12–12/12 | 30.4s | −20.9s (-69%) |
| overlay | 3/3 6.4s 4c m=8.3s | 3/3 6.6s 5c m=7.7s | 3/3 7.8s 5c m=9.6s | 6.4s | 6.6s | 5 | 3–3/3 | 66.0s | −59.6s (-90%) |
| flightsearch | 10/10 12.0s 4c m=17.0s | 10/10 10.4s 5c m=11.6s | 10/10 8.8s 5c m=22.3s | 8.8s | 10.4s | 5 | 10–10/10 | 23.3s | −14.5s (-62%) |
| mapsdir | 6/6 19.1s 7c m=12.2s | 6/6 21.5s 8c m=14.7s | 5/6 19.8s 9c m=13.0s ! | 19.1s | 19.8s | 8 | 5–6/6 | 41.9s | −22.8s (-54%) |
| extract | 22/22 4.9s 3c m=13.6s | 22/22 4.3s 3c m=9.7s | 22/22 1.9s 3c m=7.0s | 1.9s | 4.3s | 3 | 22–22/22 | 5.7s | −3.8s (-66%) |

Totals over valid cells: 18 cells, 176/177 checkpoints, 90 tool calls, 172.3s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED, multipage#2=FINISHED, staticform#2=FINISHED, overlay#2=FINISHED, extract#2=FINISHED, flightsearch#2=FINISHED, mapsdir#2=FINISHED, multipage#3=FINISHED, staticform#3=FINISHED, overlay#3=FINISHED, extract#3=FINISHED, flightsearch#3=FINISHED, mapsdir#3=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 31 | 0 | 78 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 18 | 0 | 348 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 11 | 2 | 308 | 4 | multipage, mapsdir |
| fast_text | 11 | 1 | 22 | 2 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_batch | 5 | 0 | 2669 | 0 | staticform, flightsearch |
| fast_wait | 5 | 3 | 6101 | 3 | multipage, mapsdir |
| fast_fill | 4 | 0 | 196 | 0 | flightsearch, mapsdir |
| fast_select_option | 3 | 0 | 990 | 0 | overlay |
| fast_key_press | 2 | 0 | 113 | 0 | mapsdir |

Total: 90 calls across 9 distinct tools, 9 fumbles.

## Fumbles

- pass 1 mapsdir #6: `fast_wait` (text=route options) — failed → followed by fast_snapshot — {"error":"Timed out waiting for \"route options\"","settling":false,"sinceMutMs":2576,"sinceNetMs":2
- pass 2 mapsdir #6: `fast_click` (text=Times Square New York, Manhattan, NY) — failed → followed by fast_wait — {"error":"No element matching \"Times Square New York, Manhattan, NY\". Nothing was clicked.","waite
- pass 2 mapsdir #7: `fast_wait` (text=Driving directions) — failed → followed by fast_snapshot — {"error":"Timed out waiting for \"Driving directions\"","settling":false,"sinceMutMs":5586,"sinceNet
- pass 3 multipage #2: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 3 multipage #5: `fast_click` (text=It's Only the Himalayas) — switched to fast_wait on the same target
- pass 3 extract #2: `fast_text` (selector=table.wikitable) — retry (same tool, same target)
- pass 3 mapsdir #3: `fast_click` (text=Directions) — failed → followed by fast_click — {"error":"Only 1 matches for \"Directions\" (1 visible, 0 offscreen), index 6 out of range","matches
- pass 3 mapsdir #6: `fast_wait` (text=Driving directions) — failed → followed by fast_text — {"error":"Timed out waiting for \"Driving directions\"","settling":false,"sinceMutMs":10922,"sinceNe
- pass 3 mapsdir #7: `fast_text` (selector=input[aria-label*="destination"]) — failed → followed by fast_text — {"error":"selector \"input[aria-label*=\"destination\"]\" not found","origin":"https://www.google.co
