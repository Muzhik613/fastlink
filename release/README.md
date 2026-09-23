# FastLink self-hosted auto-update (signed `.crx`)

The update channel for installs that are NOT on this machine and can't load the
repo unpacked. Today that is the owner's father's laptop (Alex; corporate-managed),
which force-installs extension `ockcjadbkdfgfllidpcoamcepahfmlpf` through an HKLM
`ExtensionInstallForcelist` entry pointing at:

```
https://raw.githubusercontent.com/Turetsky/fastlink/main/release/updates.xml
```

Chrome polls that about every 5 hours. When `updates.xml` names a higher `version`,
Chrome downloads the `codebase` `.crx` (a GitHub Release asset), checks that it is
signed with the same key (`../fastlink-extension-signing-key.pem`, gitignored), and
updates without asking. **If this file 404s, that laptop stops updating without any
error.** The 2026-09-16 prune deleted this directory, and the laptop missed every
change until 0.4.5 restored it.

## Cutting a release

1. Bump `"version"` in `fast-ext/manifest.json` and in `updates.xml` (both the
   `version` and the `ext-vX.Y.Z` tag in `codebase`), then commit.
2. `release/build-crx.sh X.Y.Z` packs the committed `fast-ext/` into a signed
   `.crx` plus a load-unpacked zip.
3. `git push origin main` (this updates the raw `updates.xml`).
4. `gh release create ext-vX.Y.Z <build>/fastlink-X.Y.Z.crx <build>/fastlink-extension-X.Y.Z.zip -R Muzhik613/fastlink --title "Extension vX.Y.Z" --notes "..."`
5. Verify: the raw URL above serves the new version, and the `codebase` URL returns 200.

Also re-sync `fast-ext-dad/` (the father's profile on THIS machine) per CLAUDE.md.
