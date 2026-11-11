#!/usr/bin/env bash
# build-operator.sh — the OPERATOR FastLink build: the normal fast-ext/ tree + fast_evaluate
# (secure-only/src/secure/evaluate.js, chrome.userScripts) + secure-only/operator/callHooks.js.
# For browsers of an account with users.allow_evaluate (mac1/mac2 on Alex's Mac). Unsealed
# calls like the normal build; NOT the secure build (no lock), never in the CRX/feed/Web Store
# (release/build-crx.sh drops secure-only/). Same extension id, so loading it in place keeps
# pairing and storage. Needs Chrome's "Allow User Scripts" on FastLink's Details page.
# Usage: scripts/build-operator.sh [OUT]   (default dist/fastlink-operator/)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/dist/fastlink-operator}"

(cd "$ROOT/fast-ext" && node --test test/*.test.js >/dev/null) || { echo "fast-ext tests failed; not building"; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT/src/secure"
(cd "$ROOT/fast-ext" && tar cf - --exclude=./test --exclude=./store --exclude=./scripts --exclude=./dist --exclude=./secure-only --exclude=./node_modules --exclude='*.md' .) | tar xf - -C "$OUT"
cp "$ROOT/fast-ext/secure-only/src/secure/evaluate.js" "$OUT/src/secure/evaluate.js"
cp "$ROOT/fast-ext/secure-only/operator/callHooks.js" "$OUT/src/callHooks.js"

node -e '
const f = process.argv[1], fs = require("fs"), m = JSON.parse(fs.readFileSync(f, "utf8"));
delete m.update_url;   // an operator browser never takes the feed (it would drop fast_evaluate)
if (!m.permissions.includes("userScripts")) m.permissions.push("userScripts");
m.minimum_chrome_version = "135";
m.version_name = m.version + "-operator";
fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n");
' "$OUT/manifest.json"

SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
[ -n "$(git -C "$ROOT" status --porcelain -- fast-ext)" ] && SHA="$SHA+local"
printf '{ "sha": "%s", "builtAt": "%s", "operator": true }\n' "$SHA" "$(date -u +%FT%TZ)" > "$OUT/build.json"
echo "built $OUT ($(node -p "require('$OUT/manifest.json').version_name"), $SHA)"
