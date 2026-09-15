# fast-runner tool usage

18 cell(s), ALL passes, one table per toolset, from `bench/tool-usage.jsonl`. Regenerate: `node bench/drive-runner.js usage`.

fumble columns: `retry` = call immediately followed by the same tool on the same target; `switch` = followed by a different tool on the same target; `fumble %` = (retry+switch)/calls.

## toolset `default` — 16 cell(s): multipage×2, gcpform×2, staticform×2, overlay×2, flightsearch×2, mapsdir×2, extract×2, cfworkers×2

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

## toolset `phase2` — 2 cell(s): multipage×1, gcpform×1

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_click | 6 | 1 | 5129 | 0 | 1 | 17 | multipage, gcpform |
| fast_fill | 3 | 0 | 152 | 0 | 0 | 0 | gcpform |
| fast_snapshot | 3 | 0 | 235 | 0 | 0 | 0 | multipage, gcpform |
| fast_scroll | 2 | 0 | 176 | 0 | 0 | 0 | gcpform |
| fast_tab | 2 | 0 | 548 | 0 | 0 | 0 | multipage, gcpform |
| fast_evaluate | 1 | 1 | 199 | 0 | 0 | 0 | gcpform |
| fast_select_option | 1 | 1 | 5763 | 0 | 1 | 100 | gcpform |
| fast_text | 1 | 0 | 116 | 0 | 0 | 0 | gcpform |
| fast_wait | 1 | 0 | 120 | 0 | 0 | 0 | multipage |

Total: 20 calls across 9 distinct tools; 2 fumbles (10%).
