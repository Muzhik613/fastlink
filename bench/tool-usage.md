# fast-runner tool usage

Aggregated over 12 cell(s), ALL passes (multipage×2, gcpform×1, staticform×2, overlay×2, flightsearch×1, mapsdir×1, extract×3) from `bench/tool-usage.jsonl`. Regenerate: `node bench/drive-runner.js usage`.

fumble columns: `retry` = call immediately followed by the same tool on the same target; `switch` = followed by a different tool on the same target; `fumble %` = (retry+switch)/calls.

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_wait | 23 | 1 | 165 | 0 | 4 | 17 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 18 | 0 | 116 | 0 | 2 | 11 | multipage, gcpform, overlay, flightsearch, mapsdir |
| fast_snapshot | 15 | 0 | 108 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 12 | 0 | 754 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_status | 10 | 0 | 78 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click_xy | 9 | 0 | 119 | 0 | 0 | 0 | overlay |
| fast_evaluate | 7 | 2 | 66 | 0 | 0 | 0 | staticform, flightsearch, mapsdir, extract |
| fast_fill | 7 | 0 | 118 | 0 | 0 | 0 | gcpform, flightsearch |
| fast_prewarm | 7 | 0 | 34 | 0 | 0 | 0 | multipage, gcpform, overlay, flightsearch, mapsdir, extract |
| fast_scroll | 5 | 0 | 206 | 0 | 0 | 0 | gcpform, overlay |
| fast_batch | 4 | 0 | 2748 | 0 | 0 | 0 | gcpform, staticform |
| fast_scout | 3 | 0 | 1624 | 0 | 0 | 0 | gcpform, overlay, flightsearch |
| fast_select_option | 3 | 2 | 85 | 0 | 0 | 0 | overlay, flightsearch |
| fast_text | 3 | 0 | 118 | 0 | 0 | 0 | staticform, extract |
| fast_key_press | 2 | 0 | 224 | 0 | 0 | 0 | staticform, overlay |
| fast_type | 2 | 0 | 137 | 0 | 1 | 50 | overlay |
| fast_do | 1 | 0 | 3600 | 0 | 0 | 0 | overlay |
| fast_fill_form | 1 | 0 | 66 | 0 | 0 | 0 | mapsdir |
| fast_list | 1 | 0 | 17 | 0 | 0 | 0 | flightsearch |
| fast_screenshot | 1 | 0 | 440 | 0 | 0 | 0 | staticform |

Total: 134 calls across 20 distinct tools; 7 fumbles (5%).
