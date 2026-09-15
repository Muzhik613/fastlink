# Grok runner — plan (2026-09-15)

Grok drives FastLink end to end; Claude only dispatches tasks and answers questions.
Basis: bench 2026-08-06, grok.com via relay = 70/70 in 259s vs claude.ai 545s.

## Shape

```
Claude (any session / frontdesk agent)
   │  grok_run(task)  ──────────────►  ┌─────────────────────────┐
   │  grok_answer(run_id, answer) ───► │ fast-runner (Node)      │
   │  ◄── {done|question|running}      │  agent loop, grok-4.6   │
   │                                   │  tools = FastLink MCP   │
   │                                   │        + ask_caller     │
   │                                   │        + report_done    │
   │                                   └──────┬──────────┬───────┘
   │                                   xAI    │          │ MCP stdio
   │                              api.x.ai    │          ▼
   │                      (via grokcode proxy │   fast-dxt/server ──► broker ──► Chrome ext
   │                        :8790, owns the   │
   │                        OAuth token)      ▼
```

## Components (all new code lives in `fast-runner/`)

| piece | does | notes |
|---|---|---|
| `runner.mjs` | agent loop: task → Grok → tool calls → results → repeat until `report_done` / `ask_caller` / budget | Anthropic-Messages format against grokcode's proxy (auth refresh + quirks already solved there; single token owner). `reasoning_effort` low/medium: 2.8× faster per grokcode notes |
| `fastlink-client.mjs` | MCP client with two transports, **`relay` is the default / real one**: Streamable-HTTP to `relay.ytx.app/mcp` as an OAuth client (dynamic registration at `/oauth/register`, one-time authorization_code login in the browser, tokens cached at `~/.config/fastrun/relay-token.json`, refreshed silently). `local` = spawn `fast-dxt/server/index.js` over stdio, testing only. Lists tools dynamically either way | same path grok.com used in the bench, so results compare 1:1. Runner keeps ONE MCP session per run (grok.com opened one per call). Browser selection = `fast_profile` on the runner's own OAuth client id, per the 2026-08-06 multi-browser routing |
| `toolset.json` | allow-list + renames + description overrides Grok sees | starts as "all 40+"; shrinks from bench data (phase 2) |
| `caller-mcp.mjs` | MCP server Claude registers (`fastrun`): `grok_run`, `grok_answer`, `grok_status`, `grok_cancel` | user-scope, like the `grok` MCP |
| run store | `run_id → {messages, status, tool log}`; jsonl to scratch | feeds tool-usage stats + post-mortems |

## Talk-back (v1)

- `grok_run` HOLDS the call until one of: `report_done` → `{status:done, result}`; `ask_caller` → `{status:question, run_id, question, so_far}`; hold timeout (default 240s) → `{status:running, run_id}`.
- Claude resolves a question with `grok_answer(run_id, answer)` → same hold semantics; the answer lands as the `ask_caller` tool result and Grok continues from its own context.
- `grok_status(run_id)` for the running case (last N tool calls + Grok's last note).
- Budget guards: max tool calls (default 60), max wall (10 min), consecutive-error stop (3). Any stop returns `so_far` so nothing is lost.
- v2 idea (not now): push progress to the caller session via SendMessage-style events.

## Phases

| # | deliverable | proof |
|---|---|---|
| 0 | runner + caller MCP, full toolset, one manual task from a Claude session, `local` transport | Wikipedia search task completes via `grok_run` |
| 0b | `relay` transport: OAuth client flow + token cache; same task through relay.ytx.app | same task passes over relay; `fast_status` shows the runner's client pinned to `browser-1` |
| 1 | `bench/drive-runner.js`: bench suite submits via `grok_run` **over relay**, scoring unchanged (local-broker readback); per-run tool histogram + fumble log | 8/8 tests valid; `bench/tool-usage.md` produced |
| 2 | tool triage from data → categories **core / fold / internal / drop**; `toolset.json` + Grok-tuned descriptions; re-bench | score ≥ 70/70, wall ≤ 259s, fewer tools + fewer calls |
| 3 | fold decisions land in `tools.js` itself (relay mirror too), toolset.json shrinks to overrides only | no dormant tool paths left |
| 4 | hosted: runner beside the relay per user (container lane, frontdesk owns the box) | out of scope this pass |

## Phase 4 contract — FastLink inside frontdesk's per-user container (decided 2026-09-15)

Owner decision: box 10 goes **local first**. Frontdesk DO ↔ container directly; identity = `usr_id`
(container name); no relay pairing, no device tokens. Later door: people drive their own container
from their OWN Claude via a connector (relay keyed by usr_id, or frondesk.ai/mcp; undecided).

| item | spec |
|---|---|
| broker | new local-broker mode bound on **:8080** (Container defaultPort). Only the frontdesk DO reaches it. Commands + results only; cookies/profile never cross it |
| extension config | Chromium managed policy `3rdparty.extensions.<id>` → `chrome.storage.managed`: `{ brokerUrl:"http://127.0.0.1:8080", browserName:"<usr_id>", toolProfile:"<name>" }` |
| boot | extension re-registers itself on every boot (profile restored from snapshot; `Singleton*` locks deleted by their start script) |
| action log | every command `{t, tool, url, outcome}` streamed to the caller; memory-only inside the container |
| stop | a STOP command halts the current run and refuses new commands until cleared (per-person kill switch) |
| tool profile | `toolProfile` selects a toolset (e.g. `no-cdp`); "no debugger" is a hypothesis, deciding test = 8 pages container-vs-container with the input.js CDP tier on vs off |
| runner placement | undecided (Grok vs Claude brain); whatever calls the broker must never hold the container awake waiting on a human: checkpoint + return |

Frontdesk owns: image, Container DO, Workflow caller, profile snapshot/restore, live view for first sign-in.

## Not in this pass

- Gemini/scout code: untouched. Separate lever; revisit after phase 2 shows what Grok still needs.
- New xAI account: not needed; runs on the SuperGrok sub via `~/.grok/auth.json`.
- Frontdesk container/DO: frontdesk session owns it.

## Open decisions

1. Runner ↔ xAI: through grokcode proxy (:8790, recommended, one token owner) vs own client (duplicate refresh, race on auth.json).
2. Effort: `low` vs `medium` for the loop; measure in phase 1.
3. Hold timeout default (240s?) and whether `grok_run` can also run fire-and-forget.
