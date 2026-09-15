# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 4 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T06:12:56.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: pass 1 on d35cb3c; pass 2 on d35cb3c (fixer page.js 5ba6bd6 rsynced + rig Chrome killed mid-pass → multipage#2 lost the extension); pass 3 on d35cb3c + fixer page.js 853f5d7 (multipage#3 skipped after the Chrome kill, made up at 06:28Z); fixer applied: 853f5d7 page.js: actionable fast_fill/fast_select_option misses, heading-titled + emotion react-select, portal listbox sweep, storm-safe fast_wait (file already in place on this rig since the pass-2→3 boundary, md5 cd7af46a; 5ba6bd6 = the pass-2 build, md5 2b1465f5). No broker/server/proxy change. ; pass 4 on 76b8d83 (grok-4.3, toolset phase2);

Run store per pass (model/toolset): pass 1 = grok-4.6/default; pass 2 = grok-4.6/default; pass 3 = grok-4.6/default; pass 4 = grok-4.3/phase2.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | pass 3 | pass 4 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 6/6 14.8s 9c | 0/6 107.4s 48c ! | 6/6 10.6s 7c | 6/6 4.8s 5c m=9.0s | 4.8s | 12.7s | 8 | 0–6/6 | 16.9s | −12.1s (-72%) |
| staticform | 12/12 19.8s 5c | 12/12 25.3s 6c | 12/12 23.6s 6c | 11/12 10.7s 4c m=11.8s ! | 10.7s | 21.7s | 5.5 | 11–12/12 | 30.4s | −19.7s (-65%) |
| overlay | 3/3 53.3s 19c | 3/3 24.7s 7c | 3/3 22.2s 7c | 3/3 13.1s 11c m=15.2s | 13.1s | 23.4s | 9 | 3–3/3 | 66.0s | −52.9s (-80%) |
| flightsearch | 10/10 57.9s 21c | 10/10 47.8s 17c | 10/10 42.7s 16c | 8/10 5.5s 7c m=9.8s ! | 5.5s | 45.3s | 16.5 | 8–10/10 | 23.3s | −17.8s (-76%) |
| mapsdir | 6/6 20.8s 11c | 6/6 32.6s 17c | 6/6 53.1s 24c | 5/6 104.2s 8c m=106.4s ! | 20.8s | 42.8s | 14 | 5–6/6 | 41.9s | −21.1s (-50%) |
| extract | 22/22 7.0s 3c | 20/22 6.5s 3c ! | 20/22 6.0s 3c ! | 19/22 2.8s 2c m=9.1s ! | 2.8s | 6.3s | 3 | 19–22/22 | 5.7s | −2.9s (-51%) |

Totals over valid cells: 24 cells, 219/236 checkpoints, 266 tool calls, 717.2s wall.

Outcomes: multipage#1=FINISHED, staticform#1=FINISHED, overlay#1=FINISHED, extract#1=FINISHED, flightsearch#1=FINISHED, mapsdir#1=FINISHED, multipage#2=FINISHED, staticform#2=FINISHED, overlay#2=FINISHED, extract#2=FINISHED, flightsearch#2=FINISHED, mapsdir#2=FINISHED, staticform#3=FINISHED, overlay#3=FINISHED, extract#3=FINISHED, flightsearch#3=FINISHED, mapsdir#3=FINISHED, multipage#3=FINISHED, multipage#4=FINISHED, staticform#4=FINISHED, overlay#4=FINISHED, extract#4=FINISHED, flightsearch#4=FINISHED, mapsdir#4=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_status | 54 | 0 | 5 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_wait | 39 | 4 | 177 | 10 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 33 | 7 | 55 | 12 | multipage, overlay, flightsearch, mapsdir |
| fast_snapshot | 30 | 0 | 73 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 24 | 0 | 265 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 20 | 0 | 78 | 0 | flightsearch, mapsdir |
| fast_evaluate | 16 | 0 | 36 | 0 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_prewarm | 12 | 0 | 2 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_click_xy | 11 | 0 | 56 | 0 | overlay, mapsdir |
| fast_select_option | 6 | 1 | 378 | 1 | overlay, flightsearch |
| fast_batch | 5 | 0 | 1895 | 0 | staticform, flightsearch |
| fast_scout | 3 | 0 | 3317 | 0 | flightsearch |
| fast_text | 3 | 0 | 14 | 0 | staticform, mapsdir |
| fast_type | 3 | 0 | 59 | 2 | overlay, mapsdir |
| fast_key_press | 2 | 0 | 34 | 0 | mapsdir |
| fast_list | 2 | 1 | 10 | 1 | multipage, flightsearch |
| fast_fill_form | 1 | 0 | 66 | 0 | mapsdir |
| fast_nav | 1 | 1 | 3 | 1 | multipage |
| fast_scroll | 1 | 0 | 65 | 0 | overlay |

Total: 266 calls across 19 distinct tools, 27 fumbles.

## Fumbles

- pass 1 multipage #4: `fast_wait` (text=Travel) — switched to fast_click on the same target
- pass 1 multipage #5: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 1 multipage #8: `fast_click` (text=It's Only the Himalayas) — switched to fast_wait on the same target
- pass 1 overlay #5: `fast_select_option` — failed → followed by fast_click — {"error":"field \"Single\" not found","origin":"https://react-select.com"}
- pass 1 overlay #9: `fast_wait` (text=Forest) — switched to fast_click on the same target
- pass 1 overlay #16: `fast_type` (text=Forest) — switched to fast_wait on the same target
- pass 1 flightsearch #4: `fast_wait` (text=From) — failed → followed by fast_list — {"error":"fast_wait: could not inject into target tab 81232633 (Frame with ID 0 was removed.). The t
- pass 1 mapsdir #4: `fast_wait` (text=Directions) — switched to fast_click on the same target
- pass 2 multipage #4: `fast_wait` (text=Travel) — switched to fast_click on the same target
- pass 2 multipage #5: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 2 multipage #6: `fast_wait` (text=Travel) — failed → followed by fast_status — {"error":"Chrome extension not connected."}
- pass 2 multipage #29: `fast_list` — failed → followed by fast_status — {"error":"Chrome extension not connected."}
- pass 2 multipage #36: `fast_nav` (url=https://books.toscrape.com/catalogue/category/books/travel_2) — failed → followed by fast_status — {"error":"Chrome extension not connected."}
- pass 2 mapsdir #4: `fast_wait` (text=Directions) — switched to fast_click on the same target
- pass 2 mapsdir #13: `fast_click` (text=Times Square New York, Manhattan, NY) — failed → followed by fast_click_xy — {"diagnostics":["Text \"Times Square New York, Manhattan, NY\" not found in document, open shadow DO
- pass 3 flightsearch #8: `fast_wait` (text=John F. Kennedy) — failed → followed by fast_snapshot — {"error":"Timed out waiting for \"John F. Kennedy\"","headings":["Book flights","Cities and dates","
- pass 3 mapsdir #4: `fast_wait` (text=Directions) — switched to fast_click on the same target
- pass 3 mapsdir #8: `fast_type` (text=John F. Kennedy International Airport) — switched to fast_wait on the same target
- pass 3 mapsdir #11: `fast_click` (text=Jamaica, NY) — failed → followed by fast_click_xy — {"diagnostics":["2 non-interactive match(es) — fast_click only fires on buttons/links/inputs/[role]/
- pass 3 mapsdir #13: `fast_wait` (text=Times Square) — failed → followed by fast_snapshot — {"error":"Timed out waiting for \"Times Square\"","headings":["Delays"],"origin":"https://www.google
- pass 3 multipage #3: `fast_click` (text=Travel) — switched to fast_wait on the same target
- pass 3 multipage #6: `fast_click` (text=It's Only the Himalayas) — switched to fast_wait on the same target
- pass 4 overlay #3: `fast_click` (text=Ocean) — failed → followed by fast_click — {"available":[{"role":"button","tag":"div","text":"Remove Ocean"}],"error":"Found 1 match(es) for \"
- pass 4 overlay #5: `fast_click` (text=Purple) — failed → followed by fast_click — {"available":[{"role":"button","tag":"div","text":"Remove Purple"}],"error":"Found 1 match(es) for \
- pass 4 overlay #7: `fast_click` (text=Ocean) — failed → followed by fast_click_xy — {"diagnostics":["1 match(es) hidden via display:none / visibility:hidden / opacity:0 (div). A parent
- pass 4 overlay #10: `fast_click` (text=Ocean) — failed → followed by fast_click_xy — {"diagnostics":["1 match(es) hidden via display:none / visibility:hidden / opacity:0 (div). A parent
- pass 4 mapsdir #3: `fast_click` (text=Directions) — failed → followed by fast_click — {"error":"Only 1 matches for \"Directions\", index 8 out of range","matches":[{"tag":"button","text"
