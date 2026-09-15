# fast-runner tool usage

128 cell(s), ALL passes, one table per toolset × model, from `bench/tool-usage.jsonl`. Regenerate: `node bench/drive-runner.js usage`.

fumble columns: `retry` = call immediately followed by the same tool on the same target; `switch` = followed by a different tool on the same target; `fumble %` = (retry+switch)/calls.

## toolset `default / ?` — 6 cell(s): multipage×1, gcpform×1, staticform×1, overlay×1, extract×2

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_click | 9 | 0 | 170 | 0 | 0 | 0 | multipage, gcpform, overlay |
| fast_snapshot | 9 | 0 | 159 | 0 | 0 | 0 | gcpform, staticform, overlay, extract |
| fast_wait | 7 | 0 | 433 | 0 | 0 | 0 | multipage, gcpform, overlay, extract |
| fast_tab | 6 | 0 | 1183 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, extract |
| fast_status | 5 | 0 | 147 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, extract |
| fast_click_xy | 4 | 0 | 208 | 0 | 0 | 0 | overlay |
| fast_scroll | 4 | 0 | 241 | 0 | 0 | 0 | gcpform, overlay |
| fast_batch | 3 | 0 | 2976 | 0 | 0 | 0 | gcpform, staticform |
| fast_fill | 3 | 0 | 141 | 0 | 0 | 0 | gcpform |
| fast_prewarm | 3 | 0 | 75 | 0 | 0 | 0 | gcpform, overlay, extract |
| fast_text | 3 | 0 | 118 | 0 | 0 | 0 | staticform, extract |
| fast_evaluate | 2 | 2 | 154 | 0 | 0 | 0 | staticform, extract |
| fast_key_press | 2 | 0 | 224 | 0 | 0 | 0 | staticform, overlay |
| fast_scout | 2 | 0 | 1654 | 0 | 0 | 0 | gcpform, overlay |
| fast_do | 1 | 0 | 3600 | 0 | 0 | 0 | overlay |
| fast_screenshot | 1 | 0 | 440 | 0 | 0 | 0 | staticform |
| fast_select_option | 1 | 1 | 117 | 0 | 0 | 0 | overlay |
| fast_type | 1 | 0 | 192 | 0 | 0 | 0 | overlay |

Total: 66 calls across 18 distinct tools; 0 fumbles (0%).

## toolset `default / grok-4.6` — 18 cell(s): multipage×3, staticform×3, overlay×3, flightsearch×3, mapsdir×3, extract×3

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_status | 54 | 0 | 5 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_wait | 39 | 4 | 177 | 0 | 10 | 26 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 22 | 2 | 57 | 0 | 5 | 23 | multipage, overlay, flightsearch, mapsdir |
| fast_snapshot | 22 | 0 | 40 | 0 | 0 | 0 | multipage, overlay, flightsearch, mapsdir |
| fast_tab | 18 | 0 | 273 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_evaluate | 16 | 0 | 36 | 0 | 0 | 0 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 14 | 0 | 80 | 0 | 0 | 0 | flightsearch, mapsdir |
| fast_prewarm | 12 | 0 | 2 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_click_xy | 9 | 0 | 53 | 0 | 0 | 0 | overlay, mapsdir |
| fast_select_option | 5 | 1 | 444 | 0 | 0 | 0 | overlay, flightsearch |
| fast_batch | 4 | 0 | 1592 | 0 | 0 | 0 | staticform, flightsearch |
| fast_scout | 3 | 0 | 3317 | 0 | 0 | 0 | flightsearch |
| fast_type | 3 | 0 | 59 | 0 | 2 | 67 | overlay, mapsdir |
| fast_list | 2 | 1 | 10 | 0 | 0 | 0 | multipage, flightsearch |
| fast_text | 2 | 0 | 13 | 0 | 0 | 0 | mapsdir |
| fast_fill_form | 1 | 0 | 66 | 0 | 0 | 0 | mapsdir |
| fast_key_press | 1 | 0 | 17 | 0 | 0 | 0 | mapsdir |
| fast_nav | 1 | 1 | 3 | 0 | 0 | 0 | multipage |
| fast_scroll | 1 | 0 | 65 | 0 | 0 | 0 | overlay |

Total: 229 calls across 19 distinct tools; 17 fumbles (7%).

## toolset `phase2 / grok-4.3` — 86 cell(s): multipage×14, staticform×14, overlay×14, flightsearch×14, mapsdir×16, extract×14

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_snapshot | 148 | 0 | 71 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 86 | 0 | 343 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 83 | 22 | 434 | 10 | 2 | 14 | multipage, staticform, overlay, mapsdir |
| fast_text | 44 | 2 | 24 | 2 | 0 | 5 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 39 | 4 | 306 | 1 | 0 | 3 | staticform, overlay, flightsearch, mapsdir |
| fast_batch | 22 | 0 | 2561 | 0 | 0 | 0 | staticform, flightsearch |
| fast_wait | 22 | 17 | 9461 | 0 | 0 | 0 | multipage, mapsdir |
| fast_key_press | 20 | 0 | 81 | 0 | 0 | 0 | overlay, mapsdir |
| fast_select_option | 20 | 1 | 753 | 0 | 0 | 0 | staticform, overlay, flightsearch, mapsdir |
| fast_click_xy | 2 | 0 | 67 | 0 | 0 | 0 | overlay |

Total: 486 calls across 10 distinct tools; 15 fumbles (3%).

## toolset `phase2 / grok-4.6` — 12 cell(s): multipage×2, staticform×2, overlay×2, flightsearch×2, mapsdir×2, extract×2

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_snapshot | 24 | 0 | 57 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 17 | 2 | 328 | 0 | 4 | 24 | multipage, flightsearch, mapsdir |
| fast_tab | 12 | 0 | 291 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_wait | 12 | 0 | 191 | 0 | 0 | 0 | multipage, flightsearch, mapsdir |
| fast_text | 10 | 0 | 26 | 0 | 0 | 0 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 8 | 0 | 207 | 0 | 0 | 0 | flightsearch, mapsdir |
| fast_batch | 5 | 0 | 2230 | 0 | 0 | 0 | staticform, flightsearch, mapsdir |
| fast_key_press | 2 | 0 | 37 | 0 | 0 | 0 | mapsdir |
| fast_scroll | 2 | 0 | 44 | 0 | 0 | 0 | flightsearch, mapsdir |
| fast_select_option | 2 | 0 | 990 | 0 | 0 | 0 | overlay |
| fast_click_xy | 1 | 0 | 117 | 0 | 0 | 0 | mapsdir |

Total: 95 calls across 11 distinct tools; 4 fumbles (4%).

## toolset `phase2-eval / grok-4.3` — 6 cell(s): multipage×1, staticform×1, overlay×1, flightsearch×1, mapsdir×1, extract×1

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_click | 10 | 3 | 429 | 1 | 1 | 20 | multipage, staticform, overlay, mapsdir |
| fast_fill | 10 | 3 | 527 | 0 | 0 | 0 | staticform, overlay, mapsdir |
| fast_snapshot | 10 | 0 | 41 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_tab | 6 | 0 | 263 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_text | 4 | 0 | 28 | 1 | 0 | 25 | mapsdir, extract |
| fast_batch | 1 | 0 | 2819 | 0 | 0 | 0 | flightsearch |
| fast_key_press | 1 | 0 | 52 | 0 | 0 | 0 | mapsdir |
| fast_select_option | 1 | 0 | 27 | 0 | 0 | 0 | staticform |
| fast_wait | 1 | 0 | 518 | 0 | 0 | 0 | mapsdir |

Total: 44 calls across 9 distinct tools; 3 fumbles (7%).
