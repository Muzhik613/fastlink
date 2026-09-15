# fast-runner tool usage

Aggregated over 18 cell(s), ALL passes (multipage×3, gcpform×1, staticform×3, overlay×3, flightsearch×2, mapsdir×2, extract×4) from `bench/tool-usage.jsonl`. Regenerate: `node bench/drive-runner.js usage`.

fumble columns: `retry` = call immediately followed by the same tool on the same target; `switch` = followed by a different tool on the same target; `fumble %` = (retry+switch)/calls.

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_status | 55 | 0 | 18 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_wait | 33 | 2 | 126 | 0 | 8 | 24 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 23 | 1 | 103 | 0 | 3 | 13 | multipage, gcpform, overlay, flightsearch, mapsdir |
| fast_snapshot | 20 | 0 | 89 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 18 | 0 | 584 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_evaluate | 13 | 2 | 52 | 0 | 0 | 0 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 13 | 0 | 92 | 0 | 0 | 0 | gcpform, flightsearch, mapsdir |
| fast_prewarm | 12 | 0 | 21 | 0 | 0 | 0 | multipage, gcpform, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click_xy | 10 | 0 | 111 | 0 | 0 | 0 | overlay, mapsdir |
| fast_batch | 5 | 0 | 2600 | 0 | 0 | 0 | gcpform, staticform |
| fast_scroll | 5 | 0 | 206 | 0 | 0 | 0 | gcpform, overlay |
| fast_select_option | 5 | 2 | 270 | 0 | 0 | 0 | overlay, flightsearch |
| fast_text | 5 | 0 | 76 | 0 | 0 | 0 | staticform, mapsdir, extract |
| fast_scout | 4 | 0 | 2808 | 0 | 0 | 0 | gcpform, overlay, flightsearch |
| fast_key_press | 3 | 0 | 155 | 0 | 0 | 0 | staticform, overlay, mapsdir |
| fast_list | 2 | 1 | 10 | 0 | 0 | 0 | multipage, flightsearch |
| fast_type | 2 | 0 | 137 | 0 | 1 | 50 | overlay |
| fast_do | 1 | 0 | 3600 | 0 | 0 | 0 | overlay |
| fast_fill_form | 1 | 0 | 66 | 0 | 0 | 0 | mapsdir |
| fast_nav | 1 | 1 | 3 | 0 | 0 | 0 | multipage |
| fast_screenshot | 1 | 0 | 440 | 0 | 0 | 0 | staticform |

Total: 232 calls across 21 distinct tools; 12 fumbles (5%).
