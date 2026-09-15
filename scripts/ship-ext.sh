#!/usr/bin/env bash
# ship-ext.sh — ship the COMMITTED fast-ext/ (git HEAD) into the owner's running Chrome, no click:
#   1. git archive HEAD:fast-ext → staging dir, stamp build.json {sha, syncedAt} (sha = HEAD short sha)
#   2. rsync staging → the Windows unpacked copy Chrome loads; also stamp the repo tree's build.json (gitignored)
#   3. fast_ext_reload through the local MCP server, pinned to $SLOT (default primary)
#   4. poll fast_status until installs.$SLOT.build == sha (≤30s) → PASS / FAIL (exit 1)
# HEAD, not the working tree: other sessions keep WIP in fast-ext/ — commit to ship it.
# Idempotent. Env: SLOT (profile label), DEST (Windows copy), FASTRUN_DEBUG=1 (server stderr).
# Needs the broker on the ext-reload build — an old broker forwards the call to the
# extension and gets "Unknown action": restart it (kill `pgrep -f broker/index.js`
# when no session is mid-call; every MCP server respawns it on its next call).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DEST:-/mnt/c/Users/yjtur/FastLink/extension/}"
SLOT="${SLOT:-primary}"

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

ROOT="$ROOT" SLOT="$SLOT" SHA="$SHA" node --input-type=module -e '
const { ROOT, SLOT, SHA } = process.env;
const { connect } = await import(`${ROOT}/fast-runner/fastlink-client.mjs`);
const c = await connect({ transport: "local" });
const parse = (r) => { const t = r?.content?.[0]?.text ?? ""; try { return JSON.parse(t); } catch { return { raw: t }; } };
const call = async (name, args = {}) => parse(await c.callTool(name, args));
const build = async () => (await call("fast_status")).installs?.[SLOT]?.build ?? null;
try {
  const pin = await call("fast_profile", { install: SLOT });
  if (pin.error) throw new Error(`fast_profile ${SLOT}: ${pin.error}`);
  console.log(`[ship-ext] ${SLOT} build before: ${await build()}`);
  const r = await call("fast_ext_reload");
  console.log(`[ship-ext] fast_ext_reload -> ${JSON.stringify(r)}`);
  if (r.error && /Unknown action/i.test(r.error)) console.log("[ship-ext] hint: the running broker predates ext-reload — restart it (see header) and re-run");
  const t0 = Date.now();
  let seen = null;
  while (Date.now() - t0 < 30_000) {
    seen = await build();
    if (seen === SHA) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  const ok = seen === SHA;
  console.log(`[ship-ext] ${ok ? "PASS" : "FAIL"}: installs.${SLOT}.build=${seen} expected=${SHA} (${Date.now() - t0}ms)`);
  process.exitCode = ok ? 0 : 1;
} finally { await c.close(); }
'
