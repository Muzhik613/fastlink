# fast-runner tool usage

Aggregated over 23 cell(s), ALL passes (multipage×3, gcpform×1, staticform×4, overlay×4, flightsearch×3, mapsdir×3, extract×5) from `bench/tool-usage.jsonl`. Regenerate: `node bench/drive-runner.js usage`.

fumble columns: `retry` = call immediately followed by the same tool on the same target; `switch` = followed by a different tool on the same target; `fumble %` = (retry+switch)/calls.

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_status | 59 | 0 | 17 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_wait | 44 | 4 | 224 | 0 | 10 | 23 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 29 | 2 | 91 | 0 | 3 | 10 | multipage, gcpform, overlay, flightsearch, mapsdir |
| fast_snapshot | 29 | 0 | 75 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 23 | 0 | 517 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
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

Total: 288 calls across 21 distinct tools; 15 fumbles (5%).
