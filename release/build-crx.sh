#!/usr/bin/env bash
# Pack a signed FastLink .crx (CRX3) from the COMMITTED fast-ext/ (git HEAD).
# Usage: release/build-crx.sh <version>   e.g. release/build-crx.sh 0.4.5
# Output: $BUILD/fastlink-<version>.crx (a Windows-visible path, ready for `gh release`).
#
# Staging lives on a Windows path because chrome.exe (the packer) can't read WSL
# paths. The signing key preserves the stable extension ID — never lose it.
set -euo pipefail

VERSION="${1:?usage: build-crx.sh <version>}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
KEY="$REPO/fastlink-extension-signing-key.pem"
BUILD="/mnt/c/Users/yjtur/FastLink/build"
CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"

MANV="$(git -C "$REPO" show HEAD:fast-ext/manifest.json | grep -oP '"version":\s*"\K[^"]+')"
[ "$MANV" = "$VERSION" ] || { echo "committed manifest version ($MANV) != requested ($VERSION) — bump and commit fast-ext/manifest.json first"; exit 1; }

rm -rf "$BUILD"; mkdir -p "$BUILD/ext"
git -C "$REPO" archive HEAD fast-ext | tar -x -C "$BUILD/ext" --strip-components=1
rm -rf "$BUILD/ext/dist" "$BUILD/ext/store" "$BUILD/ext/scripts"
printf '{ "sha": "%s", "syncedAt": "%s" }\n' "$(git -C "$REPO" rev-parse --short HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BUILD/ext/build.json"
cp "$KEY" "$BUILD/key.pem"

"$CHROME" --pack-extension='C:\Users\yjtur\FastLink\build\ext' \
          --pack-extension-key='C:\Users\yjtur\FastLink\build\key.pem' \
          --user-data-dir='C:\Users\yjtur\FastLink\build\pack-profile' \
          --no-message-box --no-first-run 2>/dev/null || true
for _ in $(seq 1 40); do [ -f "$BUILD/ext.crx" ] && break; sleep 0.5; done
[ -f "$BUILD/ext.crx" ] || { echo "pack failed — no ext.crx produced"; exit 1; }
rm -f "$BUILD/key.pem"
mv "$BUILD/ext.crx" "$BUILD/fastlink-$VERSION.crx"
(cd "$BUILD" && rm -f "fastlink-extension-$VERSION.zip" && cp -r ext fastlink-extension && zip -qr "fastlink-extension-$VERSION.zip" fastlink-extension && rm -rf fastlink-extension)
echo "built: $BUILD/fastlink-$VERSION.crx  $BUILD/fastlink-extension-$VERSION.zip"
sha256sum "$BUILD/fastlink-$VERSION.crx"
