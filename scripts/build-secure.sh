#!/usr/bin/env bash
# build-secure.sh — the secure FastLink build (one locked browser; src/secure/README.md).
# Copies the WORKING TREE of fast-ext/ (so local edits are included) to dist/fastlink-secure/,
# turns secure mode on, and removes update_url so that browser never auto-updates.
# The extension id is unchanged (same manifest key), so loading it in place keeps storage.
# Usage: scripts/build-secure.sh            → dist/fastlink-secure/  (load unpacked / push to the VM)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/fastlink-secure"

(cd "$ROOT/fast-ext" && node --test test/*.test.js >/dev/null) || { echo "fast-ext tests failed; not building"; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT"
(cd "$ROOT/fast-ext" && tar cf - --exclude=./test --exclude=./store --exclude=./scripts --exclude=./dist --exclude=./node_modules --exclude='*.md' .) | tar xf - -C "$OUT"

sed -i.bak 's/^export const SECURE_BUILD = false;$/export const SECURE_BUILD = true;/' "$OUT/src/secure/build.js" && rm -f "$OUT/src/secure/build.js.bak"
grep -q '^export const SECURE_BUILD = true;$' "$OUT/src/secure/build.js" || { echo "could not turn secure mode on"; exit 1; }

node -e '
const f = process.argv[1], fs = require("fs"), m = JSON.parse(fs.readFileSync(f, "utf8"));
delete m.update_url;
m.version_name = m.version + "-secure";
m.name = "FastLink (secure)";
fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n");
' "$OUT/manifest.json"

SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
[ -n "$(git -C "$ROOT" status --porcelain -- fast-ext)" ] && SHA="$SHA+local"   # if-form: no set -e exit on a clean tree
printf '{ "sha": "%s", "builtAt": "%s", "secure": true }\n' "$SHA" "$(date -u +%FT%TZ)" > "$OUT/build.json"
echo "built $OUT ($(node -p "require('$OUT/manifest.json').version_name"), $SHA)"
