# Keeping FastLink up to date

FastLink is built from this repo. There is exactly ONE path from source to a
loadable extension, and it is `scripts/ship-ext.sh`.

## The owner's machine (Chrome loads the Windows copy)

```bash
git commit ...                 # ship-ext ships HEAD, never the working tree
bash scripts/ship-ext.sh       # rsync HEAD:fast-ext -> the Windows copy, stamp build.json
```

`DEST=<path>` overrides the Windows copy. Then click the reload arrow on the
FastLink card at `chrome://extensions`. (The script's old reload-and-verify step
went through the local broker, which was removed on 2026-11-06.)

## A profile that loads `fast-ext/` straight from a clone

`git pull`, then click the reload arrow on the FastLink card at
`chrome://extensions`. Chrome has no API for an extension to reinstall itself
from disk on demand, so that click is required — it is a Chrome security
boundary, not a FastLink limitation.

## The other two components

- **Helper** (`fast-dxt/`): `git pull`, then `/mcp` reconnect (or restart) in Claude
  Code; rebuild and reinstall the `.mcpb` for Claude Desktop (see `docs/INSTALL.md`).
  No dependencies to install. The machine's pairing (`~/.fastlink/agent.json`) survives
  updates.
- **Cloud relay** (`fastlink-relay/`): `wrangler deploy` from that directory.

## Distribution channels (2026-11-16)

Two channels, one source tree (`fast-ext/`). Each release ships to both.

| | Chrome Web Store | Self-hosted feed |
|---|---|---|
| Extension id | `eiifomohibgelcdhadklpmdnoblpalde` (store-assigned) | `ockcjadbkdfgfllidpcoamcepahfmlpf` (manifest `key`) |
| Build | `fast-ext/scripts/package.sh` → `dist/fastlink-X.Y.Z.zip`: no `key`, no `update_url`, `fast_fetch` stubbed | `release/build-crx.sh` → signed CRX + `release/updates.xml` (`release/README.md`) |
| Ships | a person uploads it (`fast-ext/store/STORE-UPLOAD.md`), then Google reviews it (days) | push + GitHub release; Chrome polls the feed about every 5 h |
| For | everyone new; any unmanaged Windows/Mac (Chrome there won't force-install from a feed) | secure build, operator build (`fast_evaluate`), service-token browsers (`fast_fetch`), Linux policy installs, the owner's unpacked copy |

**The feed stays.** The store can't carry the secure/operator builds, `fast_fetch` or same-day fixes. Never empty or 404 `release/updates.xml`: policy installs stop updating silently.

**Moving a feed browser to the store** (optional; only for browsers that need none of the feed-only features):
1. Different ids mean separate storage, so the pairing does not carry over.
2. Remove (or policy-remove) the feed copy first. **Never run both copies in one profile.** Both would inject into every page and both would connect.
3. Install from the store, then use "Sign in & connect" (or a pairing code). Enter the **same browser name**. The relay sees the old one offline and offers to take the name over (`name_taken_offline`), so assistants keep using the same name.
4. Policy-managed machines: change the forcelist entry to `eiifomohibgelcdhadklpmdnoblpalde;https://clients2.google.com/service/update2/crx`.

The store's version can trail the feed's while a review runs. The relay gates tools by extension version (for example, `fast_upload` needs 0.4.31 or later), so an older store copy gets a clear "update FastLink" error, not a silent failure.
