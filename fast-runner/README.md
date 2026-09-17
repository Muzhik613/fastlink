# fast-runner

Grok (`grok-4.6`) drives the browser end to end through FastLink's MCP tools. A caller (Claude) dispatches a task with `grok_run` and answers Grok's questions with `grok_answer`. Plan: `docs/GROK_RUNNER_PLAN.md`.

```
caller (Claude)  ──grok_run / grok_answer──►  caller-mcp.mjs ─┐
caller (HTTP, e.g. a Durable Object) ──POST /run…──► http.mjs ─┴► runner.mjs dispatch ──► xai.mjs ──► grokcode proxy :8790 ──► api.x.ai
                                                                     │
                                                                     └──► fastlink-client.mjs ──► local: fast-dxt/server (stdio)
                                                                                                ──► relay: relay-transport.mjs (relay.ytx.app)
```

## Files
- `runner.mjs` — agent loop + run store (`runTask`, `answer`, `status`, `cancel`). Native tools `ask_caller`, `report_done`. Budgets: 60 tool calls / 10 min; a run stops as stuck when the same call fails 3 times in a row or 6 calls fail with no success between. `report_done` is gated (up to 3 refusals, then accepted and flagged `gateOverridden`): (1) a read tool must have run after the last state-changing call; (2) `evidence` must quote verbatim a tool result taken on the **current** URL — the runner keeps `urlTrail` (distinct `url`s seen in results: fast_tab/nav/click/snapshot/wait) and tags every result with the URL it was read on, so a quote from an earlier page is refused; (3) a failed call never followed by a successful one of the same intent (same tool + `text`/`field`/`match` target, or another tool on that target) is refused **once** ("your last attempt to fast_click "x" failed and was never retried; retry it or explain in `result` why it is not needed") — the next `report_done` passes but the row carries `unresolvedFailures:[{name,target,t}]` for the bench. Refusals are logged as `gateRefusals`. **Gate mode**, one per run (`--gate on|record|off` CLI, `gate` arg on `grok_run`, or `FASTRUN_GATE` env; default `on`): `on` is the gate above; `record` runs every check at the first `report_done` exactly as `on` would but never refuses — the report is accepted and, when `on` would have refused, the row gets `gateWouldRefuse:[{t,problems,evidence,result}]` (measures the model alone); `off` runs no checks and writes no gate fields. Every row records `gate`. The system prompt is the same in all three modes. The system prompt carries today's date (America/Chicago). Every finished run appends one JSON line to `~/.local/state/fastrun/runs.jsonl` (tool log, histogram, usage, `urlTrail`, gate refusals, unresolved failures).
- **Visual check at the write** (`fast-runner/visual-check.mjs`, wired into `loop()` in `runner.mjs`) — a write nothing could read back (a result saying `verified:false` anywhere in it, or a forced `fast_type` whose bypassed guard IS the missing read-back; found by **walking** the result, not by matching a shape per tool) starts a check **the moment that call returns**: one screenshot (taken before the next call may touch the page — `settleShots`) and one **fresh `grok-4.20-0309-non-reasoning` conversation** (`FASTRUN_CHECK_MODEL`) given the image and **what the write was aimed at** (its label, or the typed text) — never the task text, the plan, the history or any tool name. It runs **in parallel with the model's next turn** and its observations ride along with the **next** tool result (`deliverChecks`, waiting at most `CHECK_WAIT_MS` 8s; a later check still running goes out on a later turn). A check still owed at `report_done` goes out **in the same round as the gate's problems**, never a round ahead of them. Delivered observations are a read of the page: they join the evidence corpus and mark that write `seen`, so the gate neither asks for a read-back the model already holds nor calls an unread write a failure. Max 5 checks per run. The note stays **dumb**: it states what is visible and never classifies widgets, names a tool, diagnoses or issues a verdict (`plainObservations` drops lines that do); the model decides. Every check lands on the run row in `visualChecks:[{idx, t, checker, unverified, shotMs, checkerMs, observations, readyAt, deliveredAt, waitedMs, actedAfter, model_response}]` or with `skipped:"no screenshot"|"nothing observed"|"checker failed: …"|"check cap (5) reached"`. Gate mode `off` takes no screenshot. Why this model and prompt, and why not at the end: see CHANGELOG 2026-09-16 "visual check at the write".
- `xai.mjs` — Anthropic-Messages client against the grokcode proxy (`Authorization: Bearer grokcode-local`; the proxy injects the real xAI OAuth token from the grok CLI login, `$HOME/.grok/auth.json`). Starts the proxy if nothing answers (see envs below).
- `fastlink-client.mjs` — `connect({transport, browser})` → `{listTools, callTool, close}`. `local` spawns `fast-dxt/server/index.js` over stdio; `relay` delegates to `relay-transport.mjs`.
- Grok sees SHORT tool names (`read`, `click`, `fill`, `select`, `done`, … — `SHORT_NAMES` in `runner.mjs`), translated at the runner boundary both ways; the MCP server, `runs.jsonl` and the gate keep the canonical `fast_*` names.
- `toolset.json` — `allow` only: which server tools Grok sees. Descriptions come from `fast-dxt/server/tools.js` alone (one short set); the server's `instructions` essay is never in Grok's system prompt. This is the **default / baseline** (all tools). `toolset.phase2.json` (11 tools + ask/done, no `fast_evaluate`), `toolset.phase2-eval.json` (phase2 + `fast_evaluate`, the A/B for accounts where evaluate is enabled) and `toolset.no-cdp.json` (no `chrome.debugger` tools) are the triaged sets from `docs/TOOL_TRIAGE_DRAFT.md`. Selection is explicit per run: `--toolset <name|path>` (CLI), `toolset` arg (`grok_run`), or `FASTRUN_TOOLSET` env; a bare name means `toolset.<name>.json` here. Each `runs.jsonl` row records `toolset`.
- `caller-mcp.mjs` — MCP stdio server `fastrun`: `grok_run`, `grok_answer`, `grok_status`, `grok_cancel`, each one call to `runner.mjs` `dispatch`.
- `http.mjs` — the same four operations over HTTP for non-MCP callers (a Durable Object calling into a browser container): `POST /run`, `POST /answer`, `POST /cancel`, `GET /status/:run_id`, `GET /health`. Also only `dispatch`. See **HTTP entry** and **Running in a container** below.
- `cli.mjs` — one task from the shell.

## Use
```
npm install                                   # once
node cli.mjs --local "Open example.com and report the h1"
node cli.mjs --browser browser-1 "..."        # relay (default transport)
node cli.mjs --local --toolset phase2 "..."   # A/B: triaged tool list (default: toolset.json = all tools)
node cli.mjs --toolset phase2 --dump-tools    # print exactly what Grok would see; touches no browser
npm test                                      # toolset selection, description set + evidence-gate unit tests (test/gate.test.mjs)
claude mcp add --scope user fastrun -- node /home/yaakov/code/Fastlink/fast-runner/caller-mcp.mjs
```
`ask_caller` in the CLI reads the answer from stdin. `FASTRUN_DEBUG=1` shows the spawned server's stderr.

## Notes
- Reasoning effort is fixed when the proxy starts (`GROKCODE_EFFORT`, runner starts it with `low`). To change it, restart the proxy: `pkill -f grokcode/proxy.mjs`, then run again.
- `grok_run` holds 240s; on `{status:"running"}` poll `grok_status` and (when it turns into a question) `grok_answer`.
- Tool results over 80k chars are truncated before Grok sees them, with a leading `[truncated:true — …]` line.

## HTTP entry (`http.mjs`)
```
FASTRUN_HTTP_TOKEN=<secret> FASTRUN_TRANSPORT=local node http.mjs     # listens on FASTRUN_HTTP_HOST:FASTRUN_HTTP_PORT (127.0.0.1:8799)
```
- Auth: every route but `/health` needs `Authorization: Bearer $FASTRUN_HTTP_TOKEN`. No token set → the server refuses to start.
- `POST /run` `{task, toolset?, gate?, transport?, browser?, hold_ms?}` · `POST /answer` `{run_id, answer, hold_ms?}` · `POST /cancel` `{run_id}` · `GET /status/:run_id` · `GET /health` → `{ok:true}`.
- A run result is always HTTP 200 with the same JSON `grok_run` returns: `{status:"running", run_id}` · `{status:"question", run_id, question, so_far}` · `{status:"done"|"error"|"budget"|"cancelled", run_id, result, evidence, error, so_far, histogram, model, toolset, urlTrail, gate…, visualChecks?, video}` · `{status:"error", error}` for bad input. HTTP errors are only 401 / 400 (body not a JSON object) / 404 / 405 / 413 (body > 1 MB).
- Hold: `run` and `answer` wait up to 240 s (or `hold_ms`, 0–3,600,000) for the run's next state, then return `running`; poll `GET /status/:run_id`.
- Runs live in this process's memory: a restart loses runs in flight (their rows are still written on SIGTERM). Finished runs append to `$HOME/.local/state/fastrun/runs.jsonl`.

## Running in a container
What a per-user browser container needs to serve `http.mjs` with the local transport:
- **Node 22** (developed on 22.23), and `npm install` in `fast-runner/` and `fast-dxt/`.
- **Chromium that loads unpacked extensions**: Chrome for Testing (branded Chrome ≥137 ignores `--load-extension`), started with `--load-extension=<repo>/fast-ext --user-data-dir=<profile> --no-first-run --no-default-browser-check --password-store=basic` (without the last one the extension's network is frozen ~25 s by the keyring). Add `--no-sandbox` where user namespaces are blocked, and give it a display (Xvfb) or run headless=new. Use the **committed** `fast-ext` (a checkout at the deployed commit); `bench/hvm-rig.sh` is a working reference launcher.
- **Broker**: nothing to start. The first `fast-dxt/server` the runner spawns starts `fast-dxt/broker/index.js` on 127.0.0.1:9876 if none is listening; the extension dials 127.0.0.1:9876. Keep 9876 internal.
- **Browser label**: a container with one browser needs none. The extension says hello as `primary` and the local broker routes to it; leave `FASTRUN_BROWSER` unset. For a named slot (e.g. `container`), set it the way `bench/hvm-rig.sh rig_label` does: open `chrome-extension://ockcjadbkdfgfllidpcoamcepahfmlpf/options.html?slot=container` in the running Chrome (a second `chrome --no-sandbox --user-data-dir=<profile> <url>` forwards it), wait for the reload, relaunch Chrome, then set `FASTRUN_BROWSER=container`.
- **Model login**: run the grokcode proxy (a separate project, `proxy.mjs`) inside the container against the container user's own grok CLI login (`grok login` → `$HOME/.grok/auth.json`, refreshed by the proxy). No token is copied into the image or the env. Either start the proxy yourself and set `FASTRUN_PROXY_AUTOSTART=off`, or let `xai.mjs` start it from `GROKCODE_DIR` (with `GROKCODE_HOME` if the login lives under another home).
- **Envs**:
  | env | value in a container | meaning |
  |---|---|---|
  | `FASTRUN_HTTP_TOKEN` | secret shared with the caller | bearer token (required) |
  | `FASTRUN_HTTP_PORT` / `FASTRUN_HTTP_HOST` | e.g. `8799` / `0.0.0.0` | where `http.mjs` listens (default 127.0.0.1:8799) |
  | `FASTRUN_TRANSPORT` | `local` | drive the container's own browser (default `relay`) |
  | `FASTRUN_BROWSER` | unset, or the slot label | pin a browser label |
  | `FASTRUN_TOOLSET` | `phase2` | tools Grok sees (default `default`) |
  | `FASTRUN_MODEL` | `grok-4.6` | driving model |
  | `FASTRUN_GATE` | `on` | report_done gate |
  | `FASTRUN_RECORD` | `off` | no screen recording |
  | `GROKCODE_URL` | `http://127.0.0.1:8790` | the proxy |
  | `GROKCODE_DIR` / `GROKCODE_HOME` / `FASTRUN_PROXY_AUTOSTART` | per setup | start the proxy / whose login / never start it |
  | `GROKCODE_EFFORT` (proxy's) | `medium` | reasoning effort, fixed per proxy process |
- **Ports**: 8799 (http.mjs, the only one exposed), 8790 (proxy, internal), 9876 (broker, internal).
