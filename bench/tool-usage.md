# fast-runner tool usage

32 cell(s), ALL passes, one table per toolset × model, from `bench/tool-usage.jsonl`. Regenerate: `node bench/drive-runner.js usage`.

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

## toolset `phase2 / grok-4.6` — 8 cell(s): multipage×1, gcpform×1, staticform×1, overlay×1, flightsearch×1, mapsdir×1, extract×1, cfworkers×1

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_snapshot | 19 | 0 | 211 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_click | 18 | 4 | 1839 | 1 | 2 | 17 | multipage, gcpform, overlay, flightsearch, mapsdir, cfworkers |
| fast_fill | 10 | 1 | 160 | 0 | 0 | 0 | gcpform, overlay, flightsearch, mapsdir |
| fast_text | 9 | 0 | 141 | 0 | 0 | 0 | gcpform, staticform, overlay, extract, cfworkers |
| fast_tab | 8 | 0 | 420 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_wait | 6 | 0 | 231 | 0 | 1 | 17 | multipage, mapsdir, cfworkers |
| fast_evaluate | 5 | 5 | 207 | 0 | 0 | 0 | gcpform, staticform, overlay, flightsearch, extract |
| fast_scroll | 4 | 0 | 232 | 0 | 0 | 0 | gcpform, overlay |
| fast_batch | 3 | 0 | 1366 | 0 | 0 | 0 | staticform, flightsearch |
| fast_click_xy | 3 | 0 | 224 | 0 | 0 | 0 | overlay |
| fast_select_option | 3 | 2 | 2380 | 0 | 1 | 33 | gcpform, overlay |
| fast_key_press | 2 | 0 | 156 | 0 | 0 | 0 | staticform, mapsdir |
| fast_nav | 1 | 0 | 730 | 0 | 0 | 0 | overlay |

Total: 91 calls across 13 distinct tools; 5 fumbles (5%).

## toolset `phase2 / grok-4.3` — 8 cell(s): multipage×1, gcpform×1, staticform×1, overlay×1, flightsearch×1, mapsdir×1, extract×1, cfworkers×1

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_fill | 13 | 3 | 137 | 0 | 0 | 0 | gcpform, staticform, flightsearch, mapsdir |
| fast_snapshot | 11 | 0 | 208 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_click | 9 | 3 | 137 | 2 | 1 | 33 | multipage, staticform, overlay, mapsdir |
| fast_tab | 8 | 0 | 436 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_select_option | 6 | 1 | 1206 | 0 | 0 | 0 | gcpform, staticform, overlay, flightsearch |
| fast_evaluate | 1 | 1 | 114 | 0 | 0 | 0 | flightsearch |
| fast_text | 1 | 0 | 99 | 0 | 0 | 0 | staticform |
| fast_wait | 1 | 0 | 2987 | 0 | 0 | 0 | cfworkers |

Total: 50 calls across 8 distinct tools; 3 fumbles (6%).
