# Browser pinning redesign — interface contract (2026-11-06)

Yaakov's decision: browser choice lives on the CLIENT side, never in relay state.
IDs name permanent things (browsers); users talk in browser names only.
Replace, don't layer: when this lands, the local broker, the relay's per-login pins
(`dev:pin:*`), the session pins (`dev:spin:*`, commit 0f8e95a) and the clientKey
selection code are all gone.

```
Claude Code session ──stdio──▶ fastlink helper (fast-dxt/server, one per session)
                                 holds: pinned browser name, session's own tabId
                                 adds {browser, tabId} to every call
                                 ──HTTPS /mcp, Bearer <agent token>──▶ relay (stateless routing)
claude.ai / Grok ──HTTPS /mcp, OAuth──────────────────────────────────▶ relay
relay ──WSS {type:'call'}──▶ extension (per-tab FIFO queue) ──▶ tab
```

## 1. Tool arguments (relay `tools.js` is the ONE schema source)

- Every browser-touching tool gets two optional args:
  - `browser` (string): browser NAME (`[a-z0-9_-]`, ≤32). A named browser that is offline
    or unknown is a hard error. Never silently redirect to another browser.
  - Omitted (Yaakov 11-06, no fixed default): (1) exactly one of the account's browsers
    online → it; (2) else the hidden `lastBrowser` hint the helper sends (the browser
    this session, else this machine, used most recently) if it's online; (3) else an
    error listing the online browsers. claude.ai / Grok send no hint, so with several
    online they name one. Each result reports the browser that served it in
    `_meta['fastlink/browser']`; the helper records it (`~/.fastlink/last-browser.json`).
    Never silently redirect to another browser.
  - `tabId` (number): act on that tab. Omitted → the extension's current target tab
    (today's behavior).
- `fast_profile` is REMOVED from the relay. The helper implements it locally.
- `fast_status` stays on the relay. It takes optional `browser`, lists every browser
  `{name, connected, lastSeen}` and `routedBrowser` for the given name (or the rules above).
- New `fast_feedback` (see §5).
- The helper fetches `tools/list` from the relay and passes it through. It removes `browser`
  and `tabId` from schemas it shows (it fills them itself) and adds its local `fast_profile`.
  `fast-dxt/server/tools.js` is deleted, so there's no mirror to keep in sync.

## 2. Relay ⇄ extension wire protocol (additive, backward compatible)

- relay→ext `{type:'call', id, action, args}`: `args.tabId` is passed through unchanged
  (`browser` is stripped by the relay).
- ext→relay `{type:'queued', id, position}` (NEW, optional): sent when the call has to wait
  behind another call on the same tab.
- ext→relay `{type:'started', id}` (NEW): sent when the call leaves the queue and runs.
- ext→relay `{type:'result', id, origin, tabId, ...}`: `origin` is the origin of the tab
  ACTED ON, and `tabId` that tab's id (NEW).
- Relay timers: on send, 30 s. On `queued`, extend to QUEUE_MAX 120 s. On `started`, reset
  to 30 s from that moment. An old extension that sends neither behaves exactly as today.
- Bug fix 1 (dropped reply): the extension sends each result on the CURRENT live socket,
  not the one the call arrived on. The relay matches results by `id` across all of that
  device's sockets. On socket close it does NOT fail the pending calls immediately; it gives
  them a 10 s grace for the redialed socket to deliver the result, then fails them with
  `Extension disconnected before response`.
- Bug fix 2 (shared origin): the relay caches the last origin PER DEVICE (keyed by device
  token), never one per DO. The consent gate and eval allowlist read the target browser's origin.

## 3. Extension concurrency

- One FIFO queue per resolved tab id: `args.tabId` if given, else the current target tab
  resolved at enqueue. Calls on different tabs run in parallel.
- Browser-level actions that don't touch a page (`fast_list`, opening a new tab) don't queue.
- With `args.tabId`, the action runs on that tab WITHOUT changing the global target tab and
  without focusing the window.
- `fast_tab` / `fast_nav` / `fast_switch` results include `tabId`, so the helper can learn
  "my tab".

## 4. Helper (rebuilt `fast-dxt/server`) and pair-once sign-in

- Pairing: the user opens `https://relay.ytx.app/pair/new` (existing Google sign-in →
  pairing code), then runs `node fast-dxt/server/index.js pair <CODE> [--name <machine>]`.
  - That POSTs `/agent/pair {code, name}` → `{agentToken: 'fla_…'}`.
  - The token is stored in `~/.fastlink/agent.json` (mode 0600). Pairing once per machine
    covers every session on it.
- Relay `/mcp` accepts `Authorization: Bearer fla_…`:
  - It looks up the D1 `agents` table (sha256 of the token stored, never plaintext) → user_id
    → same DO path as OAuth.
  - OAuth stays for claude.ai/Grok. No refresh, no expiry.
- Revoke path (`/agent/machines`, authed by the calling machine's own fla_ token, same user only):
  - `node …/index.js machines` lists the account's machines (`id` = first 12 hex of the token hash).
  - `node …/index.js revoke <id|name>` revokes another machine (a lost laptop).
  - `node …/index.js unpair` revokes this machine on the relay, then deletes `agent.json`.
  - Lost every machine: pair a new one, then revoke the others. Operator last resort:
    `UPDATE agents SET revoked=1 WHERE user_id=?` in D1.
- The helper is an MCP stdio server, one process per Claude Code session (Claude Code
  already spawns one per session). It keeps in memory:
  - `pin`: a browser name, or null (→ the rules in §1, with this session's `lastBrowser` hint).
  - `myTab` (per browser): learned from tabId in `fast_tab` / `fast_nav` / `fast_switch` results.
- Every forwarded `tools/call` gets `browser: pin` (when set) and `tabId: myTab[pin]` (when
  known and the model didn't pass its own).
- Local `fast_profile {install|browser: name|"auto"}`: validates the name against relay
  `fast_status`, then sets/clears the pin. Nothing is stored server-side.
- Unpaired: every tool returns a plain "run: node …/index.js pair <CODE> (get a code at
  https://relay.ytx.app/pair/new)".

## 5. fast_feedback

- Tool `fast_feedback {text (≤4000), kind?: 'bug'|'idea'|'other'}` on the relay. It stores a
  row in D1 `feedback (id INTEGER PK, user_id, email, browser, client, text, kind, ts)`.
  - `client` = the MCP clientInfo name/version (helper: `fastlink-helper@<hostname>`).
  - Returns `{ok:true, id}`.
- Admin read: `GET /admin/feedback?after=<id>` with `Authorization: Bearer
  <RELAY_ADMIN_TOKEN>` (wrangler secret, shared by all `/admin/*`; constant-time compare)
  → `{items:[…], last:<id>}`. No writes.
- hvm's boss-health timer polls it every 5 min and injects new items into the boss inbox.
  That poller is built from the boss-health project's own session, not here.

## 6. Deleted in the same change

`fast-dxt/broker/`, `fast-dxt/server/brokerClient.js`, the broker spawn/HTTP-port code,
`fast-dxt/server/tools.js`, the extension's local transport (`fast-ext/src/connection.js`,
install-slot/broker UI on the options/popup/onboarding pages, `fastlinkMode:'local'`), the
relay's `dev:pin` / `dev:spin` / clientKey selection and `test/session_pins.test.mjs`,
broker-only bench harness code, and broker docs (README, CLAUDE.md, docs/INSTALL.md,
docs/UPDATING.md, docs/BUG-5-multi-install-routing.md).

## 7. Rollout (needs Yaakov's OK; nothing deploys before it)

1. Apply D1 migration 0007 remotely; `wrangler secret put RELAY_ADMIN_TOKEN`.
2. Relay deploy (backward compatible: old extensions and OAuth clients keep working;
   `browser` is optional).
3. One-time cleanup: run the `/admin/drop-legacy-pins` sweep (fastlink-relay/DEPLOY.md) so
   no `dev:pin:*` / `dev:spin:*` / `dev:default` key is left in any user's DO. Then delete the sweep code
   (auth.js `handleDropLegacyPins`, userRelay.js `#dropLegacyPins`) in a follow-up commit and
   redeploy.
4. Pair each machine once and switch Claude Code configs from the `fastlink-relay` URL
   connector / old local `fastlink` to the helper. This comes BEFORE the extension release:
   extension 0.4.8 drops the local broker connection the old local `fastlink` still uses.
5. Extension release (sync the Windows copy + reload; Alex's Mac Chrome).
6. Switch off the old brokers (Alex: unload `com.alexturetsky.FastlinkBroker`).
