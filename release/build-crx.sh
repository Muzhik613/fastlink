#!/usr/bin/env bash
# Pack a signed FastLink .crx (CRX3) from the COMMITTED fast-ext/ (git HEAD).
# Usage: release/build-crx.sh <version>   e.g. release/build-crx.sh 0.4.5
# Output: $BUILD/fastlink-<version>.crx (a Windows-visible path, ready for `gh release`).
#
# Packs with Linux google-chrome when present (hvm), else Windows chrome.exe from WSL
# (staging then lives on a Windows path, since chrome.exe can't read WSL paths).
# The signing key preserves the stable extension ID — never lose it.
set -euo pipefail

VERSION="${1:?usage: build-crx.sh <version>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
KEY="$REPO/fastlink-extension-signing-key.pem"
if command -v google-chrome >/dev/null; then
  BUILD="${BUILD:-$REPO/release/build}"; CHROME="google-chrome"; P() { echo "$1"; }
else
  BUILD="${BUILD:-/mnt/c/Users/yjtur/FastLink/build}"; CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
  P() { wslpath -w "$1"; }
fi

MANV="$(git -C "$REPO" show HEAD:fast-ext/manifest.json | grep -oP '"version":\s*"\K[^"]+')"
[ "$MANV" = "$VERSION" ] || { echo "committed manifest version ($MANV) != requested ($VERSION) — bump and commit fast-ext/manifest.json first"; exit 1; }

rm -rf "$BUILD"; mkdir -p "$BUILD/ext"
git -C "$REPO" archive HEAD fast-ext | tar -x -C "$BUILD/ext" --strip-components=1
rm -rf "$BUILD/ext/dist" "$BUILD/ext/store" "$BUILD/ext/scripts" "$BUILD/ext/secure-only"
printf '{ "sha": "%s", "syncedAt": "%s" }\n' "$(git -C "$REPO" rev-parse --short HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BUILD/ext/build.json"
cp "$KEY" "$BUILD/key.pem"

"$CHROME" --headless=new --pack-extension="$(P "$BUILD/ext")" \
          --pack-extension-key="$(P "$BUILD/key.pem")" \
          --user-data-dir="$(P "$BUILD/pack-profile")" \
          --no-message-box --no-first-run 2>/dev/null || true
for _ in $(seq 1 40); do [ -f "$BUILD/ext.crx" ] && break; sleep 0.5; done
[ -f "$BUILD/ext.crx" ] || { echo "pack failed — no ext.crx produced"; exit 1; }
rm -f "$BUILD/key.pem"
mv "$BUILD/ext.crx" "$BUILD/fastlink-$VERSION.crx"
(cd "$BUILD" && rm -f "fastlink-extension-$VERSION.zip" && cp -r ext fastlink-extension && zip -qr "fastlink-extension-$VERSION.zip" fastlink-extension && rm -rf fastlink-extension)
echo "built: $BUILD/fastlink-$VERSION.crx  $BUILD/fastlink-extension-$VERSION.zip"
sha256sum "$BUILD/fastlink-$VERSION.crx"
