# FastLink

FastLink bridges **Claude** (claude.ai web, Claude Code, or Claude Desktop) to a real **Chrome
tab**, so Claude can read page snapshots, click, fill forms, run JS, and batch-automate the
browser the user is actually looking at.

```
claude.ai web  ⇄  hosted relay (relay.ytx.app)  ⇄  Chrome extension  ⇄  page
Claude Code / Desktop  ⇄  local MCP server + broker  ⇄  Chrome extension  ⇄  page
```

---

## Using FastLink (users)

> **Do NOT deploy `fastlink-relay/`.** It is the operator's hosted service, already running at
> `https://relay.ytx.app`. Users need **no** Cloudflare account, D1/KV IDs, Google OAuth secrets,
> or `wrangler` — skip everything under *Operators / self-hosting* below.

1. **Install the Chrome extension** (no Web Store listing): `chrome://extensions` → enable
   **Developer mode** → **Load unpacked** → select this repo's `fast-ext/` folder.
   (ChromeOS: the folder must be visible to Chrome, e.g. under *Linux files*.) The FastLink
   setup page opens automatically on first install; reopen it later from the extension's options.
2. **Pair with the hosted relay**: on that page click **Sign in & connect** and sign in with
   Google. The browser pairs itself and stores a device token — no codes to copy. (Fallback only:
   *Have a pairing code instead?* → `https://relay.ytx.app/pair/new` → paste the code.)
3. **Connect Claude** — pick one:
   - **claude.ai web**: Settings → Connectors → **Add custom connector** → URL
     `https://relay.ytx.app/mcp` → save → **Connect**, signing in with the **same Google
     account** used in step 2 (a different account = "browser offline").
   - **Claude Code / Desktop on the same machine** (no relay, no pairing): follow
     [`docs/INSTALL.md`](docs/INSTALL.md) to run the local MCP server from `fast-dxt/`.
4. **Verify**: ask Claude to run `fast_status`, then e.g. "snapshot my active tab".

---

## Operators / self-hosting

Everything below is for the FastLink operator/developer. End users stop at the section above.

### Hosted relay (`fastlink-relay/`)

Multi-tenant Cloudflare Worker + Durable Objects + D1/KV behind `relay.ytx.app`. Deploy steps,
bindings and secrets: [`fastlink-relay/DEPLOY.md`](fastlink-relay/DEPLOY.md) (contract:
`fastlink-relay/SPEC.md`). Only someone running their **own** relay needs this; a self-hosted
relay is selected per browser under *Advanced — relay URL* on the extension's pairing card.

### Components

#### Active (a local install is the first three; the relay is cloud-only)

| Component | Where it runs | What it is |
|---|---|---|
| **`fast-dxt/`** — MCP server + broker | Node, next to Claude | `server/index.js` exposes the `fast_*` tools over MCP (stdio). It **auto-spawns** `broker/index.js`, the WebSocket hub between MCP client(s) and the extension. Also the source of the Claude Desktop `.mcpb` bundle. |
| **`fast-ext/`** — Chrome extension | The user's Chrome | MV3 extension that actually drives the page. Loaded unpacked (Developer mode). |
| **`fastlink-relay/`** — cloud relay | Cloudflare Worker + Durable Objects | **Operator-hosted** at `relay.ytx.app` for claude.ai **web**. Users never deploy it; not part of a local install. Mirrors `fast-dxt/server/tools.js`. |

#### Legacy — ignore for development, not part of any install

| Directory | Status |
|---|---|
| `fastlink-cloud-mcp/` | Old Claude-Cloud MCP clone + unrelated scripts. *Untracked/gitignored — on disk only.* |
| `fast-ext-dad/` | A DRIFTED copy of the extension that Chrome Profile 5 loads unpacked from this path. Not a mirror of `fast-ext/` (19 files differ; it still carries tools `fast-ext/` has deleted). *Untracked/gitignored — deleting it breaks that profile and git cannot restore it.* |

> `fastlink-proxy/` (the cloud-side auth adapter superseded by `fastlink-relay/`) was deleted on
> 2026-09-16. The two directories above are untracked, so they stay until the owner migrates
> Profile 5 onto `fast-ext/` with the `secondary` slot label.

### Docs

| Doc | Purpose |
|---|---|
| [`docs/INSTALL.md`](docs/INSTALL.md) | Cross-platform, Claude-executable install guide (start here). |
| [`docs/UPDATING.md`](docs/UPDATING.md) | The one path from source to a loaded extension (`scripts/ship-ext.sh`), plus server/relay updates. |
| [`docs/TOKEN-SECURITY.md`](docs/TOKEN-SECURITY.md) | Cloud-relay device-token auth model and recommended hardening. |

`docs/` also holds design/status notes (speed tiers, benchmarks, issue logs).

### Repo layout

- `fast-dxt/` — MCP server (`server/`) + auto-spawned broker (`broker/`); tool schemas in
  `server/tools.js`.
- `fast-ext/` — MV3 Chrome extension; action handlers in `src/actions/`.
- `fastlink-relay/` — multi-tenant Cloudflare relay (deploy with `wrangler deploy`).
- `scripts/ship-ext.sh` — the ONE source-to-Chrome path: ships committed `fast-ext/` to the
  Windows copy, reloads the pinned profile via the broker, verifies the build sha.
- `docs/` — install + design/status docs. `bench/` — benchmark harnesses.

### Notes

- **Ports:** extension slots `9876` (primary) / `9877` (secondary 2nd profile); internal
  MCP↔broker `9870`.
- **Web Store:** not published — users Load-unpacked (Developer mode). The signed `.crx`
  auto-update channel in [`release/`](release/README.md) is only for force-installed managed
  devices (policy `ExtensionInstallForcelist`), not a general install path.
- **Non-DOM targets** (canvas, cross-origin iframes): `fast_screenshot` → `fast_click_xy` / `fast_type`.
  There is no model-backed vision tier and no API key to configure.
