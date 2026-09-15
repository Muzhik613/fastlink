# Grok runner per-turn latency — 2026-09-15

Why `fast-runner` spends 5–11s per model turn on heavy cells when grok.com's own connector measured ~2.6s/turn (08-06), and what to change. Measured three ways: (1) new per-turn instrumentation in live bench cells (`turns[]` in `~/.local/state/fastrun/runs.jsonl`, commit `801b4c7`), (2) a 33-call synthetic matrix straight against `api.x.ai/v1/messages` with the phase2 toolset and realistic snapshot-shaped tool results (no browser, no proxy), (3) gap analysis of the 16 pre-instrumentation runs.

## TL;DR

- **Dominant driver on grok-4.6: output tokens, not context.** Every turn carries 100–900 output tokens (hidden reasoning + tool JSON; the visible `thinking` block is a fixed 203-char placeholder) decoded at ~70 tok/s. Live fit over 21 instrumented turns: `latency ≈ 1.7s + 1.33s per 100 output tokens`; output tokens explain 46s of 84s model time. `reasoning_effort` low vs medium makes **no** difference on 4.6 (medium even emitted fewer tokens).
- **Context is cheap once cached, expensive when fresh.** Uncached prefill is ~65ms/k tokens on 4.6 (TTFT 1.4s @7k → 5.4s @72k); the same 72k request warm is TTFT 1.0s. The runner's cache does work (`cacheRead` grows monotonically every turn), so only the *new* tool result is paid: a 36k-char click result ≈ 13k tokens ≈ +0.9s.
- **grok-4.3 is 2–3× faster on every cell and flat with context** (2.0–3.9s cold at 6–66k tokens, <1s warm), because it emits 40–80 output tokens per turn instead of 100–450. It is the only lever that closes the gap to grok.com.
- Streaming gives nothing (same total; the loop needs the complete `tool_use`). The 80k result cap never bites (largest live result: 36.7k chars click, 57k fast_text). Context pruning would gain ~0 on a warm cache.

## Synthetic matrix (direct to api.x.ai, streaming, `tool_choice:any`, phase2 tools = 15, system 782 chars)

`ctx` = total input tokens as billed (system + 15 tool schemas ≈ 3.5k, rest = 2 snapshot-shaped tool results). Every row is **cold** (uncached) unless marked warm; the two samples per cell are different random content, values shown as `s1/s2`. Times in seconds; `TTFT` = first content block, `tool` = tool_use block complete, `total` = message_stop. `out` = output tokens incl. hidden reasoning.

| model | effort | ctx tok | TTFT | tool done | total | out tok |
|---|---|---:|---:|---:|---:|---:|
| grok-4.6 | low | 7.4k | 1.4/1.6/1.4 | 2.9/3.3/3.3 | 2.9/4.7/4.3 | 95/236/247 |
| grok-4.6 | low | 31k | 2.2/4.9 | 4.3/7.0 | 5.8/8.0 | 246/367 |
| grok-4.6 | low | 72k | 5.4/5.6/5.7 | 8.4/9.5/10.7 | 10.2/11.3/12.2 | 345/427/433 |
| grok-4.6 | low | 72k **warm** | **1.0** | 4.2 | **5.6** | 323 |
| grok-4.6 | medium | 7.4k | 1.4/1.0 | 2.8/3.4 | 2.8/3.4 | 91/176 |
| grok-4.6 | medium | 31k | 2.8/3.2 | 4.6/4.6 | 4.6/5.9 | 132/314 |
| grok-4.6 | medium | 72k | 8.4/4.5 | 9.1/8.4 | 9.9/8.4 | 218/249 |
| grok-4.3 | low | 6.5k | 2.0/1.6 | 2.3/2.0 | 2.3/2.1 | 48/61 |
| grok-4.3 | low | 28k | 1.8/1.8 | 2.1/2.1 | 2.1/2.1 | 39/45 |
| grok-4.3 | low | 66k | 3.3/2.1/2.6 | 3.6/2.3/3.2 | 3.6/2.3/3.2 | 42/38/78 |
| grok-4.3 | low | 66k **warm** | 0.4 | 0.7 | **~0.7** (WSL clock skewed) | 40 |
| grok-4.3 | medium | 6.5k | 1.9/1.6 | 2.3/2.2 | 2.4/2.2 | 62/63 |
| grok-4.3 | medium | 28k | 1.8/1.9 | 2.1/2.2 | 2.1/2.2 | 40/42 |
| grok-4.3 | medium | 66k | 3.4/3.7 | 3.7/4.0 | 3.7/4.0 | 38/42 |

Non-streaming control (grok-4.6 low, same bodies as the runner sends): 31k → 5.2/3.6s (356/104 out); 72k → 9.7/**17.3**s (304/483 out). Same distribution as streaming; the 17.3s is server variance, not transport.

Tool choice in the matrix (quality hint, n small): grok-4.3 picked `fast_fill` (the correct next step after landing on the search page) in 14/14 calls; grok-4.6 picked `fast_text` in 15/19, plus a stray `text` block before the tool at ≥31k ctx.

## Live runs, instrumented (through the proxy, effort low, default toolset, warm cache)

`52bd8916` — cfworkers-style cell, 13 turns, model 65.3s of 68.7s wall:

| turn | latency | fresh in | cache read | out | result chars | tool |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 1.9 | 14.9k | 0.5k | 116 | 0 | fast_status |
| 3 | 2.2 | 0.5k | 15.4k | 66 | 108 | fast_wait |
| 5 | 6.3 | 14.7k | 18.2k | 301 | 36,748 | fast_click |
| 7 | 5.0 | 13.9k | 34.8k | 69 | 34,656 | fast_click |
| 9 | **11.5** | 12.8k | 50.6k | **655** | 32,254 | fast_click |
| 10 | 4.0 | 1.9k | 63.4k | 199 | 5,015 | fast_click |
| 12 | 7.5 | 2.1k | 67.2k | **401** | 5,009 | fast_snapshot |
| 13 | **12.7** | 5.2k | 69.2k | **877** | 12,961 | report_done |

`68eac033` — light cell, 8 turns, 18.7s model / 19.7s wall: out ≤ 70 on every turn except report_done (179 → 4.0s); the others took 1.4–2.7s each. **That is grok.com's 2.6s/turn** — the gap is entirely the turns where 4.6 reasons or writes at length.

Least-squares over the 21 turns: `latency_s = 1.69 + 0.02·fresh_kTok + 1.33·(out/100)` (fresh-input coefficient is under-determined here because large results co-occur with long reasoning; the matrix puts it at ~0.065s/kTok). Attribution: base 36s, output 46s, fresh input 3s of 84s.

Pre-instrumentation gap analysis (16 runs, 177 gaps): gap after a snapshot-carrying result 5.8s avg (n=62) vs 2.8s after a small result (n=115); `fast_snapshot`-preceded gaps median 6.0s. The one "11.5s/turn" run (`81a99ef8`, 170s wall) is a single 124s stall on turn 6 — a server-side outlier, now visible per turn via `latencyMs`/`attempts`. Result sizes were **not** stored before today (1200-char previews only); `turns[].toolResultChars` records them from now on.

## Per-turn cost model (grok-4.6, warm cache)

`≈ 1.0–1.7s floor + 0.065s × fresh input kTok + 0.014s × output tokens`

- floor: network + proxy + reasoning start (~1s TTFT warm)
- fresh input: the tool result just appended (5–37k chars → 2–14k tok → 0.1–0.9s)
- output: hidden reasoning + tool JSON at ~70 tok/s; 100 tok = 1.4s, 400 = 5.5s, 877 = 12s

## Levers, ranked by expected gain on the pass-1 numbers (428s wall, 110 calls, ~360s model)

| # | lever | expected gain | risk | status |
|---|---|---|---|---|
| 1 | **grok-4.3** (`FASTRUN_MODEL=grok-4.3`, no code) | per-turn 4–12s → 2–4s cold / <1s warm; model time −50–70% → ~200–250s total, i.e. grok.com parity | tool-choice quality unbenchmarked (matrix hint is favourable); 1M ctx, half price | env var exists; needs an A/B pass |
| 2 | **terse `report_done`** behind phase2 (`describe.report_done`) | the report turn is 179–877 out tok = 4–13s; target ≤ 200 tok → −5–8s per run on 4.6 | scoring reads page state, not the report | **implemented** (this commit) |
| 3 | phase2 toolset (drops the ~11k-token instructions essay + 30 tool schemas) | −1s on turn 1 only (cached after), plus fewer/cheaper choices | already planned | in repo |
| 4 | smaller action-result snapshots (extension: byte-cap the auto preview; the 30-item cap does not bound chars — click results hit 37k) | −0.5–0.9s per heavy turn on 4.6, ~−5s per heavy run; ×0.4 on 4.3 | extension change + reload; not runner scope | not done |
| 5 | `fast_snapshot` `limit`/`viewport` guidance in descriptions | same order as 4, model-dependent | may hide needed items | phase2 description already mentions both |
| 6 | reasoning effort | **none** — low ≈ medium on both models | — | keep `low` |
| 7 | result cap (80k → lower) | **none** — largest live result 36.7k (click) / 57k (fast_text body that the task needed) | truncated JSON | unchanged |
| 8 | context pruning of old tool results | ~0 warm (72k cached = 1.0s TTFT); only helps on a cache miss | breaks cache-prefix stability | not done |
| 9 | streaming | **none** on total; only TTFT visibility | — | not done (no code added) |
| 10 | prompt-caching placement | already optimal: cacheRead == whole prefix every turn (0.5–4k uncached floor) | keep the prefix byte-stable | nothing to do |

## Recommendation for pass 3

1. Run the planned phase2 pass on grok-4.6 (isolates the toolset effect, includes the terse report).
2. Then one pass `FASTRUN_MODEL=grok-4.3 --toolset phase2` — the model swap is the only lever that reaches 2.6s/turn; judge it on score first, wall second. If quality holds, make 4.3 the runner default.

Anything else (snapshot byte cap, pruning, streaming) is worth < 5% and not before those two.

## Method / files

- Instrumentation: `fast-runner/xai.mjs` (`_timing` on the response), `fast-runner/runner.mjs` (`recordTurn` → `turns[]`, `usage.modelMs/cacheCreate`).
- Matrix script: session scratchpad `matrix.mjs` (bearer read from `~/.grok/auth.json`, never written; `buildTools(TOOLS, loadToolset('phase2'))`, `required:[]` patch as the proxy does; generator = wikipedia-like `content`/`elements` records). 33 calls total, spaced 1.5s.
- Live rows: `~/.local/state/fastrun/runs.jsonl` (`turns` present on rows started after `801b4c7`).
