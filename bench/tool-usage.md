# fast-runner tool usage

30 cell(s), ALL passes, one table per toolset, from `bench/tool-usage.jsonl`. Regenerate: `node bench/drive-runner.js usage`.

fumble columns: `retry` = call immediately followed by the same tool on the same target; `switch` = followed by a different tool on the same target; `fumble %` = (retry+switch)/calls.

## toolset `default` — 24 cell(s): multipage×4, gcpform×1, staticform×4, overlay×4, flightsearch×3, mapsdir×3, extract×5

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_status | 59 | 0 | 17 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_wait | 46 | 4 | 216 | 0 | 10 | 22 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 31 | 2 | 90 | 0 | 5 | 16 | multipage, gcpform, overlay, flightsearch, mapsdir |
| fast_snapshot | 31 | 0 | 75 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 24 | 0 | 501 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_evaluate | 18 | 2 | 49 | 0 | 0 | 0 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 17 | 0 | 91 | 0 | 0 | 0 | gcpform, flightsearch, mapsdir |
| fast_prewarm | 15 | 0 | 17 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click_xy | 13 | 0 | 101 | 0 | 0 | 0 | overlay, mapsdir |
| fast_batch | 7 | 0 | 2185 | 0 | 0 | 0 | gcpform, staticform, flightsearch |
| fast_select_option | 6 | 2 | 390 | 0 | 0 | 0 | overlay, flightsearch |
| fast_scout | 5 | 0 | 2652 | 0 | 0 | 0 | gcpform, overlay, flightsearch |
| fast_scroll | 5 | 0 | 206 | 0 | 0 | 0 | gcpform, overlay |
| fast_text | 5 | 0 | 76 | 0 | 0 | 0 | staticform, mapsdir, extract |
| fast_type | 4 | 0 | 92 | 0 | 2 | 50 | overlay, mapsdir |
| fast_key_press | 3 | 0 | 155 | 0 | 0 | 0 | staticform, overlay, mapsdir |
| fast_list | 2 | 1 | 10 | 0 | 0 | 0 | multipage, flightsearch |
| fast_do | 1 | 0 | 3600 | 0 | 0 | 0 | overlay |
| fast_fill_form | 1 | 0 | 66 | 0 | 0 | 0 | mapsdir |
| fast_nav | 1 | 1 | 3 | 0 | 0 | 0 | multipage |
| fast_screenshot | 1 | 0 | 440 | 0 | 0 | 0 | staticform |

Total: 295 calls across 21 distinct tools; 17 fumbles (6%).

## toolset `phase2` — 6 cell(s): multipage×1, staticform×1, overlay×1, flightsearch×1, mapsdir×1, extract×1

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_click | 11 | 5 | 51 | 3 | 0 | 27 | multipage, overlay, mapsdir |
| fast_snapshot | 8 | 0 | 164 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 6 | 0 | 72 | 0 | 0 | 0 | flightsearch, mapsdir |
| fast_tab | 6 | 0 | 243 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click_xy | 2 | 0 | 67 | 0 | 0 | 0 | overlay |
| fast_batch | 1 | 0 | 3105 | 0 | 0 | 0 | staticform |
| fast_key_press | 1 | 0 | 51 | 0 | 0 | 0 | mapsdir |
| fast_select_option | 1 | 0 | 48 | 0 | 0 | 0 | flightsearch |
| fast_text | 1 | 0 | 16 | 0 | 0 | 0 | staticform |

Total: 37 calls across 9 distinct tools; 3 fumbles (8%).
