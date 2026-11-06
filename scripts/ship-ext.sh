#!/usr/bin/env bash
# ship-ext.sh — ship the COMMITTED fast-ext/ (git HEAD) into the Windows unpacked copy Chrome loads:
#   1. git archive HEAD:fast-ext → staging dir, stamp build.json {sha, syncedAt} (sha = HEAD short sha)
#   2. rsync staging → the Windows copy; also stamp the repo tree's build.json (gitignored)
#   3. tell the human to reload the extension at chrome://extensions (no remote reload exists)
# HEAD, not the working tree: other sessions keep WIP in fast-ext/ — commit to ship it.
# Idempotent. Env: DEST (Windows copy).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DEST:-/mnt/c/Users/yjtur/FastLink/extension/}"

SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
NOW="$(date -u +%FT%TZ)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$ROOT" archive HEAD fast-ext | tar -x -C "$STAGE"
STAMP="$(printf '{ "sha": "%s", "syncedAt": "%s" }' "$SHA" "$NOW")"
echo "$STAMP" > "$STAGE/fast-ext/build.json"
echo "$STAMP" > "$ROOT/fast-ext/build.json"
mkdir -p "$DEST"
# -rltD (no -pog): DrvFs can't hold Unix perms/owner, syncing them re-copies everything.
rsync -rltD --delete --no-perms --no-owner --no-group --exclude='.git' "$STAGE/fast-ext/" "$DEST"
[ -n "$(git -C "$ROOT" status --porcelain -- fast-ext ':!fast-ext/build.json')" ] && echo "[ship-ext] note: uncommitted fast-ext/ changes are NOT shipped"
echo "[ship-ext] synced HEAD:fast-ext -> $DEST build=$SHA at $NOW"

echo "[ship-ext] now reload FastLink at chrome://extensions (the reload icon on its card) to load build $SHA"
