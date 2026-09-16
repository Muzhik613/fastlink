# Keeping FastLink up to date

FastLink is built from this repo. There is exactly ONE path from source to a
loadable extension, and it is `scripts/ship-ext.sh`.

## The owner's machine (Chrome loads the Windows copy)

```bash
git commit ...                 # ship-ext ships HEAD, never the working tree
bash scripts/ship-ext.sh       # rsync HEAD:fast-ext -> the Windows copy,
                               # stamp build.json, reload the pinned profile
                               # through the broker, verify the build matches
```

`SLOT=<label>` picks the profile (default `primary`); `DEST=<path>` overrides the
Windows copy. The script FAILS loudly if the reloaded profile does not come back
reporting the HEAD short sha, so a silent half-update is not possible.

## A profile that loads `fast-ext/` straight from a clone

`git pull`, then click the reload arrow on the FastLink card at
`chrome://extensions`. Chrome has no API for an extension to reinstall itself
from disk on demand, so that click is required — it is a Chrome security
boundary, not a FastLink limitation.

## The other two components

- **MCP server** (`fast-dxt/`): restart Claude Code (WSL MCP), or rebuild the
  `.mcpb` for Claude Desktop. Run `npm --prefix fast-dxt install` if deps moved.
- **Cloud relay** (`fastlink-relay/`): `wrangler deploy` from that directory.

## What does NOT exist

There is no Chrome Web Store listing, no signed `.crx` auto-update channel, and
no background version check inside the extension. Those were removed in the
2026-09-16 prune: nothing installed from them, and a dead distribution channel
that Chrome and the extension both still polled was a second source of truth.

If a public release is ever cut, `fast-ext/scripts/package.sh` builds the
uploadable zip from source — a build, not a resurrection.
