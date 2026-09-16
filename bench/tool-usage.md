# fast-runner tool usage

58 cell(s), ALL passes, one table per toolset × model, from `bench/tool-usage.jsonl`. Regenerate: `node bench/drive-runner.js usage`.

fumble columns: `retry` = call immediately followed by the same tool on the same target; `switch` = followed by a different tool on the same target; `fumble %` = (retry+switch)/calls.

## toolset `default / grok-4.6` — 16 cell(s): multipage×2, gcpform×2, staticform×2, overlay×2, flightsearch×2, mapsdir×2, extract×2, cfworkers×2

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_click | 41 | 5 | 179 | 0 | 4 | 10 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, cfworkers |
| fast_wait | 30 | 2 | 886 | 0 | 10 | 33 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_snapshot | 27 | 0 | 148 | 0 | 0 | 0 | gcpform, staticform, overlay, flightsearch, mapsdir, cfworkers |
| fast_fill | 16 | 0 | 187 | 0 | 0 | 0 | gcpform, flightsearch, mapsdir |
| fast_tab | 16 | 0 | 679 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_status | 14 | 0 | 158 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, cfworkers |
| fast_prewarm | 12 | 0 | 87 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, cfworkers |
| fast_scroll | 9 | 0 | 193 | 0 | 0 | 0 | gcpform, overlay, flightsearch, cfworkers |
| fast_click_xy | 7 | 0 | 198 | 0 | 0 | 0 | overlay |
| fast_text | 7 | 0 | 125 | 0 | 0 | 0 | staticform, flightsearch, mapsdir, extract |
| fast_key_press | 6 | 0 | 152 | 0 | 0 | 0 | staticform, overlay, flightsearch, mapsdir |
| fast_scout | 6 | 0 | 1566 | 0 | 0 | 0 | gcpform, staticform, overlay, flightsearch, mapsdir, cfworkers |
| fast_select_option | 6 | 3 | 1138 | 0 | 1 | 17 | gcpform, staticform, overlay, flightsearch |
| fast_evaluate | 5 | 5 | 132 | 0 | 0 | 0 | staticform, flightsearch, extract |
| fast_batch | 3 | 0 | 2976 | 0 | 0 | 0 | gcpform, staticform |
| fast_screenshot | 2 | 0 | 461 | 0 | 0 | 0 | staticform |
| fast_type | 2 | 0 | 209 | 0 | 1 | 50 | overlay |
| fast_do | 1 | 0 | 3600 | 0 | 0 | 0 | overlay |
| fast_fill_form | 1 | 0 | 231 | 0 | 0 | 0 | staticform |

Total: 211 calls across 19 distinct tools; 16 fumbles (8%).

## toolset `phase2 / grok-4.6` — 11 cell(s): multipage×1, gcpform×2, staticform×1, overlay×1, flightsearch×1, mapsdir×1, extract×1, cfworkers×3

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_snapshot | 29 | 0 | 255 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_click | 24 | 4 | 1530 | 1 | 4 | 21 | multipage, gcpform, overlay, flightsearch, mapsdir, cfworkers |
| fast_text | 17 | 0 | 232 | 0 | 0 | 0 | gcpform, staticform, overlay, extract, cfworkers |
| fast_wait | 15 | 1 | 1593 | 0 | 1 | 7 | multipage, gcpform, mapsdir, cfworkers |
| fast_fill | 13 | 1 | 219 | 0 | 0 | 0 | gcpform, overlay, flightsearch, mapsdir |
| fast_tab | 11 | 0 | 429 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_scroll | 7 | 0 | 311 | 0 | 0 | 0 | gcpform, overlay |
| fast_evaluate | 5 | 5 | 207 | 0 | 0 | 0 | gcpform, staticform, overlay, flightsearch, extract |
| fast_select_option | 4 | 3 | 3346 | 0 | 2 | 50 | gcpform, overlay |
| fast_batch | 3 | 0 | 1366 | 0 | 0 | 0 | staticform, flightsearch |
| fast_click_xy | 3 | 0 | 224 | 0 | 0 | 0 | overlay |
| fast_key_press | 2 | 0 | 156 | 0 | 0 | 0 | staticform, mapsdir |
| fast_nav | 1 | 0 | 730 | 0 | 0 | 0 | overlay |

Total: 134 calls across 13 distinct tools; 8 fumbles (6%).

## toolset `phase2 / grok-4.3` — 30 cell(s): multipage×3, gcpform×16, staticform×1, overlay×1, flightsearch×1, mapsdir×1, extract×1, cfworkers×6

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_snapshot | 71 | 0 | 553 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_fill | 56 | 6 | 1512 | 6 | 0 | 11 | gcpform, staticform, flightsearch, mapsdir |
| fast_click | 38 | 6 | 425 | 8 | 4 | 32 | multipage, gcpform, staticform, overlay, mapsdir, cfworkers |
| fast_tab | 31 | 2 | 466 | 1 | 0 | 3 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_select_option | 18 | 6 | 5979 | 0 | 3 | 17 | gcpform, staticform, overlay, flightsearch |
| fast_wait | 12 | 1 | 5140 | 0 | 3 | 25 | gcpform, cfworkers |
| fast_text | 11 | 1 | 340 | 0 | 0 | 0 | gcpform, staticform, cfworkers |
| fast_batch | 9 | 0 | 9219 | 0 | 0 | 0 | gcpform |
| fast_evaluate | 1 | 1 | 114 | 0 | 0 | 0 | flightsearch |
| fast_nav | 1 | 0 | 2606 | 0 | 0 | 0 | cfworkers |

Total: 248 calls across 10 distinct tools; 25 fumbles (10%).

## toolset `phase2 / ?` — 1 cell(s): gcpform×1

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|

Total: 0 calls across 0 distinct tools; 0 fumbles (0%).
