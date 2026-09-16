# fast-runner tool usage

347 cell(s), ALL passes, one table per toolset × model, from `bench/tool-usage.jsonl`. Regenerate: `node bench/drive-runner.js usage`.

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

## toolset `default / grok-4.6` — 31 cell(s): multipage×6, staticform×5, overlay×5, flightsearch×5, mapsdir×5, extract×5

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_status | 66 | 0 | 5 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_wait | 61 | 5 | 374 | 0 | 16 | 26 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 39 | 3 | 648 | 0 | 10 | 26 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_snapshot | 38 | 0 | 41 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 31 | 0 | 302 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 24 | 0 | 218 | 0 | 0 | 0 | staticform, flightsearch, mapsdir |
| fast_evaluate | 19 | 1 | 35 | 0 | 0 | 0 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_prewarm | 17 | 0 | 2 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir |
| fast_select_option | 10 | 3 | 433 | 2 | 0 | 20 | overlay, flightsearch |
| fast_click_xy | 9 | 0 | 53 | 0 | 0 | 0 | overlay, mapsdir |
| fast_text | 8 | 0 | 30 | 0 | 0 | 0 | staticform, overlay, mapsdir, extract |
| fast_batch | 7 | 0 | 1717 | 0 | 0 | 0 | staticform, flightsearch, extract |
| fast_list | 5 | 1 | 27 | 0 | 0 | 0 | multipage, flightsearch, mapsdir, extract |
| fast_scout | 5 | 0 | 2827 | 0 | 0 | 0 | staticform, flightsearch |
| fast_switch | 5 | 0 | 69 | 0 | 0 | 0 | multipage, mapsdir, extract |
| fast_scroll | 3 | 0 | 96 | 0 | 0 | 0 | overlay, flightsearch |
| fast_type | 3 | 0 | 59 | 0 | 2 | 67 | overlay, mapsdir |
| fast_fill_form | 1 | 0 | 66 | 0 | 0 | 0 | mapsdir |
| fast_key_press | 1 | 0 | 17 | 0 | 0 | 0 | mapsdir |
| fast_nav | 1 | 1 | 3 | 0 | 0 | 0 | multipage |

Total: 353 calls across 20 distinct tools; 30 fumbles (8%).

## toolset `phase2 / grok-4.3` — 279 cell(s): multipage×36, staticform×35, overlay×35, flightsearch×35, mapsdir×38, extract×35, h_conditional×7, h_datepicker×7, h_combobox×7, h_table×7, h_repeat×7, h_spa×7, h2_wizard×4, h2_slider×3, h2_tree×4, h2_autocomplete×4, h2_modal×4, h2_infinite×4

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_key_press | 1029 | 0 | 43 | 986 | 0 | 96 | overlay, flightsearch, mapsdir, h_spa, h2_slider |
| fast_snapshot | 394 | 42 | 89 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract, h_conditional, h_datepicker, h_combobox, h_table, h_repeat, h_spa, h2_wizard, h2_slider, h2_tree, h2_autocomplete, h2_modal, h2_infinite |
| fast_tab | 242 | 0 | 310 | 0 | 4 | 2 | multipage, staticform, overlay, flightsearch, mapsdir, extract, h_conditional, h_datepicker, h_combobox, h_table, h_repeat, h_spa, h2_wizard, h2_slider, h2_tree, h2_autocomplete, h2_modal, h2_infinite |
| fast_click | 239 | 65 | 458 | 28 | 16 | 18 | multipage, staticform, overlay, mapsdir, h_conditional, h_datepicker, h_combobox, h_table, h_repeat, h_spa, h2_wizard, h2_slider, h2_tree, h2_autocomplete, h2_modal |
| fast_text | 106 | 15 | 30 | 4 | 1 | 5 | multipage, staticform, overlay, flightsearch, mapsdir, extract, h_conditional, h_datepicker, h_table, h2_wizard, h2_slider, h2_tree, h2_autocomplete, h2_infinite |
| fast_fill | 102 | 14 | 512 | 9 | 1 | 10 | staticform, overlay, flightsearch, mapsdir, h_conditional, h_repeat, h_spa, h2_wizard, h2_tree, h2_autocomplete |
| fast_wait | 65 | 41 | 7402 | 0 | 5 | 8 | multipage, flightsearch, mapsdir, extract, h_repeat, h_spa, h2_wizard, h2_tree, h2_infinite |
| fast_batch | 56 | 0 | 3332 | 0 | 0 | 0 | staticform, flightsearch, h_repeat, h2_wizard, h2_modal |
| fast_select_option | 53 | 12 | 571 | 8 | 0 | 15 | staticform, overlay, flightsearch, mapsdir, h_combobox, h_repeat, h2_wizard |
| fast_nav | 48 | 0 | 420 | 11 | 8 | 40 | multipage, staticform, overlay, flightsearch, extract, h2_modal, h2_infinite |
| fast_scroll | 12 | 0 | 177 | 0 | 0 | 0 | h_repeat, h2_slider, h2_tree, h2_infinite |
| fast_click_xy | 2 | 0 | 67 | 0 | 0 | 0 | overlay |

Total: 2348 calls across 12 distinct tools; 1081 fumbles (46%).

## toolset `phase2 / grok-4.6` — 18 cell(s): multipage×3, staticform×3, overlay×3, flightsearch×3, mapsdir×3, extract×3

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_snapshot | 33 | 0 | 59 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 27 | 2 | 304 | 0 | 6 | 22 | multipage, flightsearch, mapsdir |
| fast_tab | 18 | 0 | 303 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_wait | 16 | 0 | 197 | 0 | 0 | 0 | multipage, flightsearch, mapsdir, extract |
| fast_text | 11 | 0 | 27 | 0 | 0 | 0 | staticform, overlay, flightsearch, mapsdir, extract |
| fast_fill | 10 | 0 | 258 | 0 | 0 | 0 | flightsearch, mapsdir |
| fast_batch | 7 | 0 | 2243 | 0 | 0 | 0 | staticform, flightsearch, mapsdir |
| fast_select_option | 4 | 1 | 731 | 1 | 0 | 25 | overlay |
| fast_scroll | 3 | 0 | 97 | 0 | 0 | 0 | flightsearch, mapsdir |
| fast_key_press | 2 | 0 | 37 | 0 | 0 | 0 | mapsdir |
| fast_click_xy | 1 | 0 | 117 | 0 | 0 | 0 | mapsdir |

Total: 132 calls across 11 distinct tools; 7 fumbles (5%).

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

## toolset `phase2 / ?` — 1 cell(s): h2_slider×1

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|

Total: 0 calls across 0 distinct tools; 0 fumbles (0%).

## toolset `default / grok-4.3` — 6 cell(s): multipage×1, staticform×1, overlay×1, flightsearch×1, mapsdir×1, extract×1

| tool | calls | errors | avg ms | retry | switch | fumble % | tests used in |
|---|---:|---:|---:|---:|---:|---:|---|
| fast_snapshot | 7 | 0 | 119 | 0 | 0 | 0 | multipage, staticform, flightsearch, mapsdir, extract |
| fast_tab | 6 | 0 | 283 | 0 | 0 | 0 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_click | 4 | 0 | 65 | 0 | 0 | 0 | multipage, staticform |
| fast_select_option | 4 | 1 | 297 | 1 | 0 | 25 | overlay, flightsearch |
| fast_fill | 3 | 0 | 786 | 0 | 0 | 0 | staticform, flightsearch, mapsdir |
| fast_batch | 2 | 0 | 2629 | 0 | 0 | 0 | flightsearch, mapsdir |
| fast_scout | 2 | 0 | 2732 | 0 | 0 | 0 | flightsearch, mapsdir |
| fast_key_press | 1 | 0 | 44 | 0 | 0 | 0 | mapsdir |
| fast_text | 1 | 0 | 165 | 0 | 0 | 0 | extract |

Total: 30 calls across 9 distinct tools; 1 fumbles (3%).
