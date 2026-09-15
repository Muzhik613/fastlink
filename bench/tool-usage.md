# fast-runner tool usage

Aggregated over 9 cell(s), ALL passes (multipage×2, gcpform×1, staticform×1, overlay×1, flightsearch×1, mapsdir×1, extract×1, cfworkers×1) from `bench/tool-usage.jsonl`. Regenerate: `node bench/drive-runner.js usage`.

fumble columns: `retry` = call immediately followed by the same tool on the same target; `switch` = followed by a different tool on the same target; `fumble %` = (retry+switch)/calls.

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_click | 25 | 2 | 190 | 0 | 3 | 12 | multipage, gcpform, overlay, flightsearch, mapsdir, cfworkers |
| fast_snapshot | 17 | 0 | 139 | 0 | 0 | 0 | gcpform, staticform, overlay, flightsearch, mapsdir, cfworkers |
| fast_wait | 16 | 1 | 634 | 0 | 5 | 31 | multipage, gcpform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_tab | 9 | 0 | 940 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract, cfworkers |
| fast_status | 8 | 0 | 172 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, cfworkers |
| fast_fill | 7 | 0 | 202 | 0 | 0 | 0 | gcpform, flightsearch, mapsdir |
| fast_prewarm | 6 | 0 | 85 | 0 | 0 | 0 | multipage, gcpform, overlay, flightsearch, mapsdir, cfworkers |
| fast_scroll | 6 | 0 | 214 | 0 | 0 | 0 | gcpform, overlay, flightsearch |
| fast_click_xy | 4 | 0 | 208 | 0 | 0 | 0 | overlay |
| fast_key_press | 4 | 0 | 171 | 0 | 0 | 0 | staticform, overlay, flightsearch, mapsdir |
| fast_scout | 4 | 0 | 1727 | 0 | 0 | 0 | gcpform, overlay, flightsearch, cfworkers |
| fast_batch | 3 | 0 | 2976 | 0 | 0 | 0 | gcpform, staticform |
| fast_text | 3 | 0 | 113 | 0 | 0 | 0 | staticform, flightsearch, extract |
| fast_evaluate | 2 | 2 | 154 | 0 | 0 | 0 | staticform, extract |
| fast_select_option | 2 | 1 | 124 | 0 | 0 | 0 | overlay, flightsearch |
| fast_do | 1 | 0 | 3600 | 0 | 0 | 0 | overlay |
| fast_screenshot | 1 | 0 | 440 | 0 | 0 | 0 | staticform |
| fast_type | 1 | 0 | 192 | 0 | 0 | 0 | overlay |

Total: 119 calls across 18 distinct tools; 8 fumbles (7%).
