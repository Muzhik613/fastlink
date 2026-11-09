#!/usr/bin/env bash
# build-secure.sh — the secure FastLink build (one locked browser; fast-ext/secure-only/README.md).
# Copies the WORKING TREE of fast-ext/ (so local edits are included) to dist/fastlink-secure/,
# copies fast-ext/secure-only/src/ over its src/ (the secure callHooks.js replaces the normal one;
# adds the lock, the sealed format, fast_evaluate and the options card), and removes update_url
# so that browser never auto-updates.
# The extension id is unchanged (same manifest key), so loading it in place keeps storage.
# Usage: scripts/build-secure.sh            → dist/fastlink-secure/  (load unpacked / push to the VM)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/fastlink-secure"

(cd "$ROOT/fast-ext" && node --test test/*.test.js >/dev/null) || { echo "fast-ext tests failed; not building"; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT"
(cd "$ROOT/fast-ext" && tar cf - --exclude=./test --exclude=./store --exclude=./scripts --exclude=./dist --exclude=./secure-only --exclude=./node_modules --exclude='*.md' .) | tar xf - -C "$OUT"

# The secure-only code over the normal tree, and the lock card's script on the options page.
cp -R "$ROOT/fast-ext/secure-only/src/." "$OUT/src/"
grep -q 'handleSealed' "$OUT/src/callHooks.js" || { echo "secure callHooks.js not installed"; exit 1; }
sed -i 's#^</body>$#  <script type="module" src="src/secure/optionsLock.js"></script>\n</body>#' "$OUT/options.html"
grep -q 'src/secure/optionsLock.js' "$OUT/options.html" || { echo "could not add the lock card to options.html"; exit 1; }

node -e '
const f = process.argv[1], fs = require("fs"), m = JSON.parse(fs.readFileSync(f, "utf8"));
delete m.update_url;
// Page JavaScript (fast_evaluate) exists only in the secure build: chrome.userScripts.execute (Chrome 135+).
if (!m.permissions.includes("userScripts")) m.permissions.push("userScripts");
m.minimum_chrome_version = "135";
m.version_name = m.version + "-secure";
m.name = "FastLink (secure)";
fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n");
' "$OUT/manifest.json"

SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
[ -n "$(git -C "$ROOT" status --porcelain -- fast-ext)" ] && SHA="$SHA+local"   # if-form: no set -e exit on a clean tree
printf '{ "sha": "%s", "builtAt": "%s", "secure": true }\n' "$SHA" "$(date -u +%FT%TZ)" > "$OUT/build.json"
echo "built $OUT ($(node -p "require('$OUT/manifest.json').version_name"), $SHA)"
