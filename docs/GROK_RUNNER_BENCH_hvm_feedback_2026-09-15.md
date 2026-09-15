# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 2 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T07:06:06.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: feedback bench; WSL commits: 653f33e dffa7c7 999d58e f37fcf8 c12716f 13bf127; pass 1 = grok-4.3/phase2; pass 2 on 2188c26 (grok-4.6, toolset phase2);

Run store per pass (model/toolset): pass 1 = grok-4.3/phase2; pass 2 = grok-4.6/phase2.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 5.0s 5c m=8.9s | 6/6 8.3s 6c m=13.1s | 5.0s | 6.7s | 5.5 | 6–6/6 | 16.9s | −11.9s (-71%) |
| staticform | 12/12 7.2s 11c m=11.0s | 12/12 33.2s 6c m=39.5s | 7.2s | 20.2s | 8.5 | 12–12/12 | 30.4s | −23.2s (-76%) |
| overlay | 1/3 35.9s 17c m=20.7s ~ | 3/3 29.7s 6c m=32.8s | 29.7s | 32.8s | 11.5 | 1–3/3 | 66.0s | −36.3s (-55%) |
| flightsearch | 10/10 10.5s 11c m=18.8s | 10/10 34.3s 15c m=36.5s | 10.5s | 22.4s | 13 | 10–10/10 | 23.3s | −12.8s (-55%) |
| mapsdir | 6/6 21.9s 14c m=25.5s | 6/6 46.3s 21c m=52.1s | 21.9s | 34.1s | 17.5 | 6–6/6 | 41.9s | −20.0s (-48%) |
| extract | 22/22 1.6s 2c m=23.0s | 22/22 5.9s 3c m=19.1s | 1.6s | 3.7s | 2.5 | 22–22/22 | 5.7s | −4.1s (-72%) |

Totals over valid cells: 12 cells, 116/118 checkpoints, 117 tool calls, 239.8s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED, multipage#2=FINISHED, staticform#2=FINISHED, overlay#2=FINISHED, extract#2=FINISHED, flightsearch#2=FINISHED, mapsdir#2=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_click | 24 | 8 | 576 | 9 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_snapshot | 24 | 0 | 91 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 21 | 4 | 419 | 4 | staticform, overlay, flightsearch, mapsdir |
| fast_tab | 12 | 0 | 260 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_text | 11 | 0 | 26 | 0 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_wait | 11 | 0 | 274 | 0 | multipage, flightsearch, mapsdir |
| fast_key_press | 5 | 0 | 39 | 0 | overlay, mapsdir |
| fast_select_option | 5 | 0 | 252 | 0 | staticform, overlay, flightsearch |
| fast_batch | 2 | 0 | 2167 | 0 | staticform, flightsearch |
| fast_click_xy | 1 | 0 | 117 | 0 | mapsdir |
| fast_scroll | 1 | 0 | 39 | 0 | mapsdir |

Total: 117 calls across 11 distinct tools, 13 fumbles.

## Fumbles

- pass 1 overlay #3: `fast_click` (text=Ocean) — failed → followed by fast_click — {"error":"Found 1 match(es) for \"Ocean\" but none satisfied role=\"combobox\". Nothing was clicked 
- pass 1 overlay #5: `fast_fill` (match=react-select-8-input) — failed → followed by fast_fill — {"error":"No visible fillable element matching \"react-select-8-input\". Nothing was filled.","waite
- pass 1 overlay #6: `fast_fill` (match=react-select-8-input) — failed → followed by fast_key_press — {"error":"No visible fillable element matching \"react-select-8-input\". Nothing was filled.","waite
- pass 1 overlay #8: `fast_click` (text=Ocean) — failed → followed by fast_fill — {"error":"No element matching \"Ocean\". Nothing was clicked.","waitedMs":1559,"settling":false,"dia
- pass 1 overlay #9: `fast_fill` (match=react-select-8-input) — failed → followed by fast_key_press — {"error":"No visible fillable element matching \"react-select-8-input\". Nothing was filled.","waite
- pass 1 overlay #11: `fast_click` (text=Single) — failed → followed by fast_click — {"error":"No element matching \"Single\". Nothing was clicked.","waitedMs":1549,"settling":false,"di
- pass 1 overlay #13: `fast_fill` (match=react-select-4-input) — failed → followed by fast_key_press — {"error":"No visible fillable element matching \"react-select-4-input\". Nothing was filled.","waite
- pass 1 overlay #15: `fast_click` (text=Ocean) — failed → followed by fast_click — {"error":"No element matching \"Ocean\". Nothing was clicked.","waitedMs":1561,"settling":false,"dia
- pass 1 overlay #16: `fast_click` (text=Ocean) — failed → followed by fast_click — {"error":"No element matching \"Ocean\". Nothing was clicked.","waitedMs":1550,"settling":false,"dia
- pass 2 multipage #2: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 2 multipage #5: `fast_click` (text=It's Only the Himalayas) — switched to fast_wait on the same target
- pass 2 mapsdir #9: `fast_click` (text=Times Square New York, Manhattan, NY) — failed → followed by fast_click — {"error":"No element matching \"Times Square New York, Manhattan, NY\". Nothing was clicked.","waite
- pass 2 mapsdir #10: `fast_click` (text=Times Square) — failed → followed by fast_click_xy — {"error":"Only 1 matches for \"Times Square\", index 1 out of range","matches":[{"tag":"input","text
