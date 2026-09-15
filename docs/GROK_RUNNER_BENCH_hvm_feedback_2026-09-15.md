# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 1 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T07:06:06.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: feedback bench (relaunched 12:45 CDT after SW-cache rig bug 82fac20); WSL commits: 653f33e dffa7c7 999d58e f37fcf8 c12716f 13bf127; pass 1 = grok-4.3/phase2; pass 1 on 82fac20 (grok-4.3, toolset phase2);

Run store per pass (model/toolset): pass 1 = grok-4.3/phase2.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 5.0s 5c m=8.9s | 5.0s | 5.0s | 5 | 6–6/6 | 16.9s | −11.9s (-71%) |
| staticform | 12/12 7.2s 11c m=11.0s | 7.2s | 7.2s | 11 | 12–12/12 | 30.4s | −23.2s (-76%) |
| overlay | 1/3 35.9s 17c m=20.7s ~ | 35.9s | 35.9s | 17 | 1–1/3 | 66.0s | −30.1s (-46%) |
| flightsearch | 10/10 10.5s 11c m=18.8s | 10.5s | 10.5s | 11 | 10–10/10 | 23.3s | −12.8s (-55%) |
| mapsdir | 6/6 21.9s 14c m=25.5s | 21.9s | 21.9s | 14 | 6–6/6 | 41.9s | −20.0s (-48%) |
| extract | 22/22 1.6s 2c m=23.0s | 1.6s | 1.6s | 2 | 22–22/22 | 5.7s | −4.1s (-72%) |

Totals over valid cells: 6 cells, 57/59 checkpoints, 60 tool calls, 82.2s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_click | 15 | 6 | 724 | 5 | multipage, staticform, overlay, mapsdir |
| fast_fill | 15 | 4 | 506 | 4 | staticform, overlay, flightsearch, mapsdir |
| fast_snapshot | 11 | 0 | 105 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_tab | 6 | 0 | 241 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_key_press | 4 | 0 | 38 | 0 | overlay, mapsdir |
| fast_select_option | 4 | 0 | 69 | 0 | staticform, flightsearch |
| fast_text | 3 | 0 | 30 | 0 | mapsdir, extract |
| fast_wait | 2 | 0 | 523 | 0 | mapsdir |

Total: 60 calls across 8 distinct tools, 9 fumbles.

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
