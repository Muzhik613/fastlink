# Grok runner bench — hvm, local transport (2026-09-15)

Client `grok_runner`, 2 pass(es) over 6 tests, driven by `bench/hvm-run.sh` on the hvm rig (Xvfb + Chrome for Testing + unpacked fast-ext + local broker; grokcode proxy :8791). Rows since 2026-09-15T23:30:53.000Z.

Baseline = the same cells over the RELAY transport from WSL (2026-09-15). Local vs relay changes hop latency only; the tool-choice data is what phase 1 needs.

Skipped as environment-invalid (fresh profile, no login): `gcpform` (needs a logged-in Google account), `cfworkers` (needs a logged-in Cloudflare account).

Runtime per pass: regression after holdout fixes on d6df710, 4.3/phase2 n=2; pass 1 on d6df710 (grok-4.3, toolset phase2, gate on); pass 2 on 0b2d4ce (grok-4.3, toolset phase2, gate on);

Run store per pass (model/toolset/gate): pass 1 = grok-4.3/phase2/gate on; pass 2 = grok-4.3/phase2/gate on.

## Per test

Cell = `score/total wall calls [m=model time, sum of turn latencies]` · flags: X invalid, S stuck, ! overclaim, ~ underclaim.

| test | pass 1 | pass 2 | best wall | median wall | median calls | score | baseline wall | best vs baseline |
|---|---|---|---:|---:|---:|---|---:|---:|
| multipage | 0/6 0.0s 0c X~ | 6/6 5.1s 5c m=8.4s | 5.1s | 5.1s | 5 | 6–6/6 | 16.9s | −11.8s (-70%) |
| staticform | 0/12 0.0s 0c X~ | 2/12 13.4s 10c m=22.9s ! | 13.4s | 13.4s | 10 | 2–2/12 | 30.4s | −17.0s (-56%) |
| overlay | 0/3 0.0s 0c X~ | 1/3 17.2s 13c m=25.9s ! | 17.2s | 17.2s | 13 | 1–1/3 | 66.0s | −48.8s (-74%) |
| flightsearch | 1/10 10.7s 7c m=19.8s ! | 1/10 10.3s 6c m=22.4s ! | 10.3s | 10.5s | 6.5 | 1–1/10 | 23.3s | −13.0s (-56%) |
| mapsdir | 6/6 10.6s 7c m=16.0s | 5/6 17.2s 6c m=7.3s ~ | 10.6s | 13.9s | 6.5 | 5–6/6 | 41.9s | −31.3s (-75%) |
| extract | 0/2 0.0s 0c X~ | 1/2 22.0s 14c m=32.5s ! | 22.0s | 22.0s | 14 | 1–1/2 | 5.7s | +16.3s (287%) |

Totals over valid cells: 8 cells, 23/55 checkpoints, 68 tool calls, 106.6s wall.

Outcomes: multipage#1=NO_ACTIVITY (runner exited (code 1) without a single FastLink call), staticform#1=NO_ACTIVITY (runner exited (code 1) without a single FastLink call), overlay#1=NO_ACTIVITY (runner exited (code 1) without a single FastLink call), extract#1=NO_ACTIVITY (runner exited (code 1) without a single FastLink call), flightsearch#1=FINISHED, mapsdir#1=FINISHED, multipage#2=FINISHED, staticform#2=FINISHED, overlay#2=FINISHED, extract#2=FINISHED, flightsearch#2=FINISHED, mapsdir#2=FINISHED.

## Tool histogram (all passes)

| tool | calls | errors | avg ms | fumbles | tests used in |
|---|---:|---:|---:|---:|---|
| fast_snapshot | 20 | 15 | 37 | 14 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_tab | 18 | 0 | 182 | 2 | multipage, staticform, overlay, flightsearch, mapsdir, extract |
| fast_nav | 16 | 0 | 415 | 7 | staticform, overlay, flightsearch, extract |
| fast_click | 4 | 0 | 285 | 0 | multipage, mapsdir |
| fast_fill | 3 | 0 | 898 | 0 | mapsdir |
| fast_key_press | 2 | 0 | 136 | 0 | mapsdir |
| fast_text | 2 | 2 | 23 | 2 | extract |
| fast_wait | 2 | 2 | 5070 | 1 | mapsdir, extract |
| fast_select_option | 1 | 1 | 19 | 0 | overlay |

Total: 68 calls across 9 distinct tools, 26 fumbles.

## Fumbles

- pass 1 flightsearch #2: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242225 (Frame with ID 0 is showing error
- pass 1 flightsearch #4: `fast_snapshot` — failed → followed by fast_tab — {"error":"fast_snapshot: could not inject into target tab 81242225 (Frame with ID 0 is showing error
- pass 1 flightsearch #6: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242226 (Frame with ID 0 is showing error
- pass 2 staticform #2: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242229 (Frame with ID 0 is showing error
- pass 2 staticform #3: `fast_nav` (url=https://www.selenium.dev/selenium/web/web-form.html) — retry (same tool, same target)
- pass 2 staticform #5: `fast_snapshot` — failed → followed by fast_tab — {"error":"fast_snapshot: could not inject into target tab 81242229 (Frame with ID 0 is showing error
- pass 2 staticform #7: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242230 (Frame with ID 0 is showing error
- pass 2 staticform #8: `fast_nav` (url=https://www.selenium.dev/selenium/web/web-form.html) — switched to fast_tab on the same target
- pass 2 staticform #9: `fast_tab` (url=https://www.selenium.dev/selenium/web/web-form.html) — switched to fast_nav on the same target
- pass 2 overlay #2: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242232 (Frame with ID 0 is showing error
- pass 2 overlay #4: `fast_snapshot` — failed → followed by fast_tab — {"error":"fast_snapshot: could not inject into target tab 81242232 (Frame with ID 0 is showing error
- pass 2 overlay #6: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242233 (Frame with ID 0 is showing error
- pass 2 overlay #7: `fast_nav` (url=https://react-select.com/home) — switched to fast_tab on the same target
- pass 2 overlay #9: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242234 (Frame with ID 0 is showing error
- pass 2 overlay #10: `fast_nav` (url=https://react-select.com/home) — switched to fast_tab on the same target
- pass 2 overlay #11: `fast_tab` (url=https://react-select.com/home) — switched to fast_nav on the same target
- pass 2 extract #2: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242236 (Frame with ID 0 is showing error
- pass 2 extract #3: `fast_nav` (url=https://en.wikipedia.org/wiki/List_of_countries_and_dependen) — retry (same tool, same target)
- pass 2 extract #5: `fast_wait` (text=List of countries and dependencies by population) — failed → followed by fast_tab — {"error":"fast_wait: could not inject into target tab 81242236 (Frame with ID 0 is showing error pag
- pass 2 extract #7: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242237 (Frame with ID 0 is showing error
- pass 2 extract #9: `fast_text` — failed → followed by fast_nav — {"error":"Frame with ID 0 is showing error page","origin":"https://en.wikipedia.org"}
- pass 2 extract #10: `fast_nav` (url=https://en.wikipedia.org/wiki/List_of_countries_and_dependen) — retry (same tool, same target)
- pass 2 extract #11: `fast_nav` (url=https://en.wikipedia.org/wiki/List_of_countries_and_dependen) — switched to fast_tab on the same target
- pass 2 extract #13: `fast_text` — failed → followed by fast_tab — {"error":"Frame with ID 0 is showing error page","origin":"https://en.wikipedia.org"}
- pass 2 flightsearch #2: `fast_snapshot` — failed → followed by fast_nav — {"error":"fast_snapshot: could not inject into target tab 81242244 (Frame with ID 0 is showing error
- pass 2 flightsearch #4: `fast_snapshot` — failed → followed by fast_tab — {"error":"fast_snapshot: could not inject into target tab 81242244 (Frame with ID 0 is showing error
