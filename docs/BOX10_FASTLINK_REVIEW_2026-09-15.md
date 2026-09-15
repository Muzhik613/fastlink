# FastLink-side review of frontdesk's box10-contract-v0 (2026-09-15)

Read-only review of the per-user container contract. Answers frontdesk's three questions and lists
what FastLink must build/change for phase 4. Paths are repo-relative.

## 1. `POST /tool {name,args}` vs today's dispatch

Broker is WS-only, no HTTP: ext listeners 9876/9877 (`fast-dxt/broker/state.js:6`), MCP WS 9870 on
127.0.0.1 (`fast-dxt/broker/mcpBridge.js:46`). Wire: `{type:'call',id,action,args,install}` →
`{type:'result',id,...}` (`broker/router.js:8-51`). `{name,args}` maps 1:1 ONLY for tools not
composed server-side.

| pure extension (1 broker msg) | composed in `fast-dxt/server/handlers.js` |
|---|---|
| snapshot, click, fill, fill_form, tab, nav, reload, list, switch, wait, evaluate, text, select_option, key, key_press, scroll, close, console, network, hover, drag, network_replay, macro_*, click_xy, wheel, drag_xy, type, vision_capture, annotate_boxes | batch `:1489` (+nav settle `:1460`), scout `:295`, point `:771`, point_som `:1135`, fill_vision `:870`, do `:1022`, locate `:1198`, upload `:227` (wslpath), status `:259`, profile `:148`, prewarm `:102` + nav warms `:439/:485` |

Also server-side: screenshot/marks dataURLs are written to the OS temp dir and returned as a PATH
(`handlers.js:126-135`, `:1526`); a DO across :8080 can't read it → container mode returns base64.

**Recommendation: broker + server in ONE node process** (server already spawns the broker,
`brokerClient.js:162-173`). Put the `/tool /log /stop /clear /health` HTTP shim in the server
layer; broker WS stays 127.0.0.1. Vision tools self-disable without `GEMINI_API_KEY` = free
`no-vision` profile.

## 2. Surviving a clean Chrome close

| thing | on exit | next boot |
|---|---|---|
| ext→broker socket | closed, slot freed (`broker/extBridge.js:107-114`) | re-dials |
| in-flight commands | fail "Extension disconnected before response" (`router.js:61-68`) | — |
| broker | idle watchdog EXITS after 60s with no ext+no client (`broker/lifecycle.js:20-30`) → disable in-container | respawned |
| pinned tab id | `storage.session` (`actions/targetTab.js:14,49`), wiped | null (correct) |
| STOP flag | `storage.session` (`actions/index.js:53-58`) → does NOT survive restart | resets ⚠ |
| prewarm caches | server memory | cold |
| install label | `storage.local.fastlinkInstallId` (`connection.js:10,26`), IN the profile | reused verbatim ⚠ |

Re-registration is automatic (`background.js:487-488` onStartup/onInstalled → wake; alarm 30s +
window-created, `connection.js:110-131,245`; `hello{installId}` `:174`). Caveats: `connect()`
needs a window (`:144`); dial target hardcoded `ws://127.0.0.1:{9876|9877}` (`:7,82,162`) →
`brokerUrl` not honorable today; zero `chrome.storage.managed` reads → stored label beats policy.
Abrupt kill leaves the slot "live" 30s (`state.js:13,88-93`) → next boot `slotBusy`, sits out 60s
(`extBridge.js:58-66`, `connection.js:61,276-287`).

## 3. Outside the profile (lost) / inside but must NOT restore

Outside: screenshots `os.tmpdir()/fastlink-screenshot-*` (`handlers.js:1526-1552`); timing jsonl
`os.tmpdir()/fastlink-timing.jsonl` (`:57-68`); broker pid file (`lifecycle.js:7,14`);
`~/fastlink-secrets.txt` (`config.js:12-23`, ship via env); `~/.cloudflared/config.yml` — its
presence makes the broker SPAWN A PUBLIC TUNNEL (`broker/tunnel.js:12-23`), must be absent; broker
log = stderr only (no action log exists); WSL/Windows-only bits: `/mnt/c/...` live copy,
`restart-wsl.bat`, `fast_upload` wslpath (`handlers.js:197-224`) fails every call in-container.

Inside, strip before restore: `deviceToken`/`relayBase`/`relayEnabled`/`fastlinkMode`
(`relayClient.js:525-530`, else boot auto-dials relay.ytx.app `background.js:536-570`);
`fastlinkSlotBusy`; `fastlinkInstallId` if label comes from policy; `fastlinkUpdate`/
`fastlinkAutoUpdate`/`fastlinkSelfReloadLog` (`updateCheck.js:26-54`, auto-update fetches GitHub
and self-reloads); macros `fb_macro_*`; `Singleton*`; `Local State`/`Preferences` `exit_type`.

## 4. Draft vs code

| item | status |
|---|---|
| :8080 | new listener needed; `brokerUrl` must be a `ws://` dial; ports are a fixed map (`connection.js:7`) |
| managed keys | NONE implemented; `browserName`/`toolProfile` have no consumer |
| usr_id → label | sanitized `[a-z0-9_-]` ≤32, alnum-first (`extBridge.js:15-19`); `.`/uppercase silently → `primary`. Add explicit `browserName` |
| action log | doesn't exist; hook `dispatchCall` (`handlers.js:100`) + `origin` stamp (`actions/index.js:113-125`) |
| /stop + /clear | ext pause gate exists (`actions/index.js:77`) but session-scoped; hold the latch in the server, mirror down |
| snapshot per job | nothing flushes on demand; Chrome writes lazily → SIGTERM + wait-for-exit, never copy-while-paused |
| BROKER_SECRET | no auth on ANY listener today |
| TOOL_PROFILE | no allowlist mechanism; needs filter in `handleCall` (`handlers.js:88`) AND ext dispatcher (`actions/index.js:129-148`) |
| sleepAfter 3m | compatible: ext drops socket when last window closes (`connection.js:235-243`) |

## 5. Security rules the current code violates

1. No auth + ext bridge binds `0.0.0.0` (`extBridge.js:38`) → bind 127.0.0.1, enforce secret.
2. `startTunnel()` on broker start (`broker/index.js:11`) = accidental public ingress → remove in container mode.
3. `fast_evaluate` runs caller JS via CDP `Runtime.evaluate` / MAIN-world eval (`evaluate.js:16-36,46-53`) → reads cookies/localStorage/tokens. Off in EVERY container profile.
4. `fast_network_replay` fetches with `credentials:'include'` + arbitrary headers, returns headers+body (`page.js:2209-2231`) → exclude.
5. Host paths leak in results (screenshot/marks `{path}`, upload `resolvedPaths`) → base64/blob.
6. `debugger` + `<all_urls>` in manifest (`manifest.json:8-9`) is the root capability; `no-cdp` must strip input.js's shared CDP session AND evaluate's CDP path.
7. No big-action consent gate on the local path (consent store is relay/popup-only, `popup.js:239-272`); rule 6.1 needs an enforcement point at `handlers.js:100` or `actions/index.js:72`.

## FastLink phase-4 build list (derived)

container mode flag → (a) `chrome.storage.managed` reader: brokerUrl (ws), browserName, toolProfile;
(b) server HTTP shim :8080 `/tool /log /stop /clear /health` with BROKER_SECRET; (c) action log
ring buffer streamed via `/log`; (d) server-held stop latch mirrored to ext; (e) tool-profile
allowlist enforced server AND ext side; (f) no tunnel, no relay dial, no auto-update, no idle-exit;
(g) base64 results for screenshot/marks, plain-path upload; (h) evaluate + network_replay off.
