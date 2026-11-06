# FastLink — Install Guide

> **This guide is written to be executed by Claude (an AI agent) installing FastLink for a user.**
> Follow it top-to-bottom. Where a step branches by OS, do **only** the matching branch.

```
Claude Code / Desktop ⇄ stdio ⇄ FastLink helper (fast-dxt/server) ⇄ HTTPS ⇄ relay.ytx.app ⇄ Chrome extension ⇄ tab
```

Three things get set up: **(A)** the **Chrome extension**, paired to the user's relay account;
**(B)** the machine's **pairing** (one token per machine, shared by every session); **(C)** the
**helper** registered with Claude. claude.ai web / Grok need only (A) plus a connector — see the
README.

---

## Step 0 — Detect the environment

```bash
uname -s                                                          # Darwin = macOS, Linux = Linux/WSL
grep -qi microsoft /proc/version 2>/dev/null && echo WSL || echo not-WSL
```

On **native Windows** (PowerShell, no WSL): `node -v` and `where.exe node`.

| Environment | Where node runs | How config invokes it |
|---|---|---|
| **macOS / Linux** | native `node` | `node /abs/path/.../index.js` |
| **Windows native** | native `node` | `node C:\...\index.js` |
| **Windows + WSL** | `node` inside WSL | `node /home/...` if Claude runs in WSL; `wsl.exe -e node /home/...` only when the Claude process is Windows-side |

## Step 1 — Node ≥ 18

```bash
command -v node && node -v
```

Install Node in the environment that will run the helper if it is missing or older. The helper
has **no npm dependencies**; there is no `npm install` step.

## Step 2 — Clone the repo

```bash
git clone https://github.com/Turetsky/fastlink.git
cd fastlink
```

Record the absolute path of `fast-dxt/server/index.js`.

## Step 3 — Chrome extension (A)

1. `chrome://extensions` → **Developer mode** ON → **Load unpacked** → the repo's `fast-ext/`
   folder. (Windows + WSL: Chrome can't reliably load from `\\wsl$\…`; copy `fast-ext/` to a
   Windows folder and load that copy.)
2. On the FastLink setup page that opens, pair the browser (**Sign in with Google**, or a code
   from `https://relay.ytx.app/pair/new`) and give it a name.

Managed / corporate machines may block unpacked extensions by policy; there is no Web Store
listing.

## Step 4 — Pair this machine (B), once

The user opens `https://relay.ytx.app/pair/new` (same Google account as the browser) and reads
you the code. Then:

```bash
node /ABS/PATH/fast-dxt/server/index.js pair <CODE> --name <machine-name>
```

This writes `~/.fastlink/agent.json` (dir 0700, file 0600) holding the relay URL and this
machine's agent token. Run it in the same environment that will run the helper (WSL vs Windows
have different home dirs). `unpair` deletes the file. A self-hosted relay: `--relay <url>`.

## Step 5 — Register the helper with Claude (C)

### Claude Code

```bash
claude mcp add fastlink -- node /ABS/PATH/fast-dxt/server/index.js
```

Equivalent `~/.claude.json` entry:

```json
"fastlink": {
  "type": "stdio",
  "command": "node",
  "args": ["/ABS/PATH/fast-dxt/server/index.js"]
}
```

Windows-side Claude with node in WSL: `"command": "wsl.exe", "args": ["-e", "node", "/home/<user>/.../fast-dxt/server/index.js"]`.

Remove any older FastLink entries (a `fastlink-relay` URL connector, or a `fastlink` entry with
broker env vars) so each session has exactly one FastLink. Restart Claude Code or run `/mcp`.

### Claude Desktop (.mcpb)

The bundle is `fast-dxt/` (manifest + `server/`). Build it from `fast-dxt/` with
`zip -r fastlink.mcpb manifest.json package.json server icons` (no build script exists), then
install by dragging it into Claude Desktop's Extensions settings. The shipped manifest runs
`node ${__dirname}/server/index.js`. Windows + WSL only: edit the **installed** copy's
`manifest.json` to `"command": "wsl.exe", "args": ["-e", "node", "/home/<user>/.../fast-dxt/server/index.js"]`.

## Step 6 — Verify

1. Chrome is open with a normal `http(s)://` tab and the extension shows as connected.
2. In Claude, call **`fast_status`**: it lists the paired browsers by name, which are online,
   and the default.
3. `fast_snapshot` returns page content.
4. With several browsers: `fast_profile {install: "<name>"}` pins this session to one;
   `"auto"` goes back to the default.

## Troubleshooting

- **Every tool says "FastLink isn't paired on this machine yet"** — Step 4 wasn't run in this
  environment, or `~/.fastlink/agent.json` was removed. Pair, then `/mcp` to reconnect.
- **"the relay rejected this machine's pairing (HTTP 401)"** — the agent token was revoked.
  Pair again.
- **A browser is "offline"** — its Chrome isn't running, the extension isn't paired, or it's
  paired to a different Google account than the code you used in Step 4.
- **`wsl.exe` in the config on macOS / native Windows** — use `node` with the absolute path.
