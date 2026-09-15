# fast-runner

Grok (`grok-4.6`) drives the browser end to end through FastLink's MCP tools. A caller (Claude) dispatches a task with `grok_run` and answers Grok's questions with `grok_answer`. Plan: `docs/GROK_RUNNER_PLAN.md`.

```
caller (Claude)  ──grok_run / grok_answer──►  caller-mcp.mjs ──► runner.mjs ──► xai.mjs ──► grokcode proxy :8790 ──► api.x.ai
                                                                     │
                                                                     └──► fastlink-client.mjs ──► local: fast-dxt/server (stdio)
                                                                                                ──► relay: relay-transport.mjs (relay.ytx.app)
```

## Files
- `runner.mjs` — agent loop + run store (`runTask`, `answer`, `status`, `cancel`). Native tools `ask_caller`, `report_done`. Budgets: 60 tool calls / 10 min / 3 consecutive errors. `report_done` is gated (up to 3 refusals, then accepted and flagged `gateOverridden`): (1) a read tool must have run after the last state-changing call; (2) `evidence` must quote verbatim a tool result taken on the **current** URL — the runner keeps `urlTrail` (distinct `url`s seen in results: fast_tab/nav/click/snapshot/wait) and tags every result with the URL it was read on, so a quote from an earlier page is refused; (3) a failed call never followed by a successful one of the same intent (same tool + `text`/`field`/`match` target, or another tool on that target) is refused **once** ("your last attempt to fast_click "x" failed and was never retried; retry it or explain in `result` why it is not needed") — the next `report_done` passes but the row carries `unresolvedFailures:[{name,target,t}]` for the bench. Refusals are logged as `gateRefusals`. **Gate mode**, one per run (`--gate on|record|off` CLI, `gate` arg on `grok_run`, or `FASTRUN_GATE` env; default `on`): `on` is the gate above; `record` runs every check at the first `report_done` exactly as `on` would but never refuses — the report is accepted and, when `on` would have refused, the row gets `gateWouldRefuse:[{t,problems,evidence,result}]` (measures the model alone); `off` runs no checks and writes no gate fields. Every row records `gate`. The system prompt is the same in all three modes. The system prompt carries today's date (America/Chicago). Every finished run appends one JSON line to `~/.local/state/fastrun/runs.jsonl` (tool log, histogram, usage, `urlTrail`, gate refusals, unresolved failures).
- `xai.mjs` — Anthropic-Messages client against the grokcode proxy (`Authorization: Bearer grokcode-local`; the proxy injects the real xAI OAuth token). Starts the proxy if nothing listens on :8790.
- `fastlink-client.mjs` — `connect({transport, browser})` → `{listTools, callTool, close, instructions}`. `local` spawns `fast-dxt/server/index.js` over stdio; `relay` delegates to `relay-transport.mjs`.
- `toolset.json` — `allow` / `rename` / `describe` applied to the tool list Grok sees (names mapped back on call). This is the **default / baseline** (all tools + the server's `instructions` essay in the system prompt). `toolset.phase2.json` (14 tools, tight descriptions, no essay, no `fast_evaluate`), `toolset.phase2-eval.json` (phase2 + `fast_evaluate`, the A/B for accounts where evaluate is enabled) and `toolset.no-cdp.json` (no `chrome.debugger` tools) are the triaged sets from `docs/TOOL_TRIAGE_DRAFT.md`. Selection is explicit per run: `--toolset <name|path>` (CLI), `toolset` arg (`grok_run`), or `FASTRUN_TOOLSET` env; a bare name means `toolset.<name>.json` here. Each `runs.jsonl` row records `toolset`.
- `caller-mcp.mjs` — MCP stdio server `fastrun`: `grok_run`, `grok_answer`, `grok_status`, `grok_cancel`.
- `cli.mjs` — one task from the shell.

## Use
```
npm install                                   # once
node cli.mjs --local "Open example.com and report the h1"
node cli.mjs --browser browser-1 "..."        # relay (default transport)
node cli.mjs --local --toolset phase2 "..."   # A/B: triaged tool list (default: toolset.json = all tools)
node cli.mjs --toolset phase2 --dump-tools    # print exactly what Grok would see; touches no browser
npm test                                      # toolset filter/rename/describe + evidence-gate unit tests (test/gate.test.mjs)
claude mcp add --scope user fastrun -- node /home/yaakov/code/Fastlink/fast-runner/caller-mcp.mjs
```
`ask_caller` in the CLI reads the answer from stdin. `FASTRUN_DEBUG=1` shows the spawned server's stderr.

## Notes
- Reasoning effort is fixed when the proxy starts (`GROKCODE_EFFORT`, runner starts it with `low`). To change it, restart the proxy: `pkill -f grokcode/proxy.mjs`, then run again.
- `grok_run` holds 240s; on `{status:"running"}` poll `grok_status` and (when it turns into a question) `grok_answer`.
- Tool results over 80k chars are truncated before Grok sees them, with a leading `[truncated:true — …]` line.
