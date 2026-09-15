#!/usr/bin/env bash
# hvm-run.sh — self-driving Grok-runner bench on hvm: PASSES × the auth-free six cells,
# grok_runner over the LOCAL transport, one commit per pass, results doc regenerated each pass.
# Launch detached so it survives the launching session:
#   cd /home/dev/code/Fastlink && setsid nohup bash bench/hvm-run.sh > bench/hvm-run.log 2>&1 &
# gcpform / cfworkers are skipped: they need a logged-in Google / Cloudflare account this profile lacks.
# Fixer handoff: a fixer rsyncs its change and writes bench/FIXER_READY (commit + summary); at the
# next pass boundary we restart Chrome (extension reload), delete the marker and record the commit.
# The runner spawns a fresh fast-dxt/server per cell, so only Chrome needs the restart.
set -u
cd "$(dirname "$0")/.." || exit 1
PASSES=${PASSES:-3}
PASS_START=${PASS_START:-1}       # continue an earlier run: PASS_START=4 PASSES=1 SINCE=<its start ts>
SINCE=${SINCE:-}
TOOLSET=${TOOLSET:-}              # fast-runner toolset name (default = all tools); FASTRUN_MODEL is inherited by cli.mjs
TESTS=${TESTS:-"multipage staticform overlay extract flightsearch mapsdir"}
DOC=${DOC:-docs/GROK_RUNNER_BENCH_hvm_$(date -u +%F).md}
export GIT_AUTHOR_NAME=Turetsky GIT_AUTHOR_EMAIL=yjturetsky@gmail.com GIT_COMMITTER_NAME=Turetsky GIT_COMMITTER_EMAIL=yjturetsky@gmail.com
. bench/hvm-rig.sh
NOTES=""
fixer_check() {
  [ -f bench/FIXER_READY ] || return 0
  local msg; msg=$(tr '\n' ' ' < bench/FIXER_READY)
  echo "=== FIXER_READY: $msg — restarting Chrome"
  pkill -u "$USER" -f "user-data-dir=$RIG_PROFILE"; sleep 2
  rm -f bench/FIXER_READY
  NOTES="$NOTES fixer applied: $msg;"
}
fixer_check
rig_up || exit 1
[ -n "$SINCE" ] || SINCE=$(date -u +%FT%T.000Z)
LAST=$((PASS_START + PASSES - 1))
echo "=== run start $SINCE  passes=$PASS_START..$LAST  tests=[$TESTS]  doc=$DOC  model=${FASTRUN_MODEL:-grok-4.6} toolset=${TOOLSET:-default}"
for p in $(seq "$PASS_START" "$LAST"); do
  NOTES="$NOTES pass $p on $(git rev-parse --short HEAD) (${FASTRUN_MODEL:-grok-4.6}, toolset ${TOOLSET:-default});"
  echo "=== pass $p/$LAST starts on $(git rev-parse --short HEAD)"
  for t in $TESTS; do
    echo "=== pass $p/$LAST  $t  $(date -u +%FT%TZ)"
    rig_up > /dev/null || { echo "!!! rig down before $t (pass $p); skipping cell"; continue; }
    node bench/run.js --client grok_runner --transport local --test "$t" ${TOOLSET:+--toolset "$TOOLSET"} || echo "!!! cell $t failed (pass $p)"
  done
  node bench/hvm-report.js --since "$SINCE" --passes "$LAST" --notes "$NOTES" --out "$DOC" || echo "!!! report failed"
  node bench/drive-runner.js usage > /dev/null
  git add bench/tool-usage.md "$DOC"   # results*.jsonl / tool-usage.jsonl are gitignored run artefacts
  git commit -q -m "bench(hvm): grok_runner local-transport pass $p/$LAST" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && echo "=== committed pass $p: $(git rev-parse --short HEAD)"
  fixer_check
done
echo "=== DONE $(date -u +%FT%TZ)"
