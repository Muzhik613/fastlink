# FastLink

FastLink bridges an AI (Claude Code, Claude Desktop, claude.ai web, Grok) to a real **Chrome
tab**, so it can read page snapshots, click, fill forms, run JS, and batch-automate the browser
the user is actually looking at.

```
Claude Code / Desktop ⇄ stdio ⇄ FastLink helper (fast-dxt/server, one per session)
                                   ⇄ HTTPS, agent token ⇄ relay.ytx.app ⇄ Chrome extension ⇄ tab
claude.ai web / Grok  ⇄ HTTPS, OAuth ⇄ relay.ytx.app ⇄ Chrome extension ⇄ tab
```

Every path goes through the hosted relay. There is no local broker and no local ports.

---

## Using FastLink (users)

> **Do NOT deploy `fastlink-relay/`.** It is the operator's hosted service, already running at
> `https://relay.ytx.app`. Users need **no** Cloudflare account, D1/KV IDs, Google OAuth secrets,
> or `wrangler` — skip everything under *Operators / self-hosting* below.

1. **Install the Chrome extension** (no Web Store listing): `chrome://extensions` → enable
   **Developer mode** → **Load unpacked** → select this repo's `fast-ext/` folder.
   (ChromeOS: the folder must be visible to Chrome, e.g. under *Linux files*.) The FastLink
   setup page opens automatically on first install; reopen it later from the extension's options.
2. **Pair the browser**: on that page click **Sign in with Google** (or **Use a pairing code**
   from `https://relay.ytx.app/pair/new`), then give the browser a name (`laptop`, `work`, …).
   Every browser you pair shows up under that name.
3. **Claude Code / Claude Desktop — pair each machine once**:
   1. Get a code at `https://relay.ytx.app/pair/new` (same Google account as step 2).
   2. Run `node /ABSOLUTE/PATH/TO/Fastlink/fast-dxt/server/index.js pair <CODE>`
      (optional `--name <machine>`; defaults to the hostname). This saves a token in
      `~/.fastlink/agent.json`, which every session on this machine uses.
   3. Add the helper to Claude Code:
      `claude mcp add fastlink -- node /ABSOLUTE/PATH/TO/Fastlink/fast-dxt/server/index.js`
      (Claude Desktop: install `fast-dxt/fastlink.mcpb`.) Node ≥ 18, no `npm install` needed.

   Each session drives your default browser. To use another one, ask Claude to call
   `fast_profile` with the browser's name; that choice lasts for that session only.
   Machines: `node …/index.js machines` lists this account's paired machines,
   `… revoke <id|name>` revokes a lost one, `… unpair` revokes this machine and forgets it.
4. **claude.ai web / Grok**: add a custom connector with URL `https://relay.ytx.app/mcp` and
   sign in with the **same Google account** as step 2 (a different account = "browser offline").
5. **Verify**: ask the AI to run `fast_status`, then e.g. "snapshot my active tab".

---

## Operators / self-hosting

Everything below is for the FastLink operator/developer. End users stop at the section above.

### Hosted relay (`fastlink-relay/`)

Multi-tenant Cloudflare Worker + Durable Objects + D1/KV behind `relay.ytx.app`. Deploy steps,
bindings and secrets: [`fastlink-relay/DEPLOY.md`](fastlink-relay/DEPLOY.md) (contract:
`fastlink-relay/SPEC.md`). Only someone running their **own** relay needs this; a self-hosted
relay is selected per browser under *Advanced — relay URL* on the extension's pairing card.

### Components

#### Active

| Component | Where it runs | What it is |
|---|---|---|
| **`fast-dxt/`** — FastLink helper | Node, next to Claude (one process per session) | `server/index.js`: MCP stdio server that forwards every call to the relay with this machine's agent token, and keeps the session's chosen browser (`fast_profile`) and its own tab in memory. `pair` / `unpair` subcommands. Also the source of the Claude Desktop `.mcpb` bundle. No dependencies. |
| **`fast-ext/`** — Chrome extension | The user's Chrome | MV3 extension that actually drives the page. Loaded unpacked (Developer mode). |
| **`fastlink-relay/`** — cloud relay | Cloudflare Worker + Durable Objects | **Operator-hosted** at `relay.ytx.app`. Every client goes through it. Users never deploy it. `fastlink-relay/tools.js` is the one tool-schema source. |

#### Legacy — ignore for development, not part of any install

| Directory | Status |
|---|---|
| `fastlink-cloud-mcp/` | Old Claude-Cloud MCP clone + unrelated scripts. *Untracked/gitignored — on disk only.* |
| `fast-ext-dad/` | A DRIFTED copy of the extension that Chrome Profile 5 loads unpacked from this path. Not a mirror of `fast-ext/` (19 files differ; it still carries tools `fast-ext/` has deleted). *Untracked/gitignored — deleting it breaks that profile and git cannot restore it.* |

> `fastlink-proxy/` (the cloud-side auth adapter superseded by `fastlink-relay/`) was deleted on
> 2026-09-16. The two directories above are untracked, so they stay until the owner migrates
> Profile 5 onto `fast-ext/`.

### Docs

| Doc | Purpose |
|---|---|
| [`docs/INSTALL.md`](docs/INSTALL.md) | Cross-platform, Claude-executable install guide (start here). |
| [`docs/UPDATING.md`](docs/UPDATING.md) | Updating the extension, the helper and the relay. |
| [`docs/PIN-REDESIGN.md`](docs/PIN-REDESIGN.md) | Helper ⇄ relay ⇄ extension contract: browser names, per-session pin and tab, agent pairing. |
| [`docs/TOKEN-SECURITY.md`](docs/TOKEN-SECURITY.md) | Cloud-relay device-token auth model and recommended hardening. |

`docs/` also holds design/status notes (speed tiers, benchmarks, issue logs).

### Repo layout

- `fast-dxt/` — the per-session helper (`server/`); tool schemas come from the relay.
- `fast-ext/` — MV3 Chrome extension; action handlers in `src/actions/`.
- `fastlink-relay/` — multi-tenant Cloudflare relay (deploy with `wrangler deploy`); tool
  schemas in `tools.js`.
- `scripts/ship-ext.sh` — ships committed `fast-ext/` to the Windows copy Chrome loads.
- `docs/` — install + design/status docs. `bench/` — benchmark suite definitions and results.

### Notes

- **Web Store:** not published — users Load-unpacked (Developer mode). The signed `.crx`
  auto-update channel in [`release/`](release/README.md) is only for force-installed managed
  devices (policy `ExtensionInstallForcelist`), not a general install path.
- **Non-DOM targets** (canvas, cross-origin iframes): `fast_screenshot` → `fast_click_xy` / `fast_type`.
  There is no model-backed vision tier and no API key to configure.
