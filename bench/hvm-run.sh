#!/usr/bin/env bash
# hvm-run.sh — self-driving Grok-runner bench on hvm: PASSES × the auth-free six cells,
# grok_runner over the LOCAL transport, one commit per pass, results doc regenerated each pass.
# Launch detached so it survives the launching session:
#   cd /home/dev/code/Fastlink && setsid nohup bash bench/hvm-run.sh > bench/hvm-run.log 2>&1 &
# gcpform / cfworkers are skipped: they need a logged-in Google / Cloudflare account this profile lacks.
set -u
cd "$(dirname "$0")/.." || exit 1
PASSES=${PASSES:-3}
TESTS=${TESTS:-"multipage staticform overlay extract flightsearch mapsdir"}
DOC=${DOC:-docs/GROK_RUNNER_BENCH_hvm_$(date -u +%F).md}
export GIT_AUTHOR_NAME=Turetsky GIT_AUTHOR_EMAIL=yjturetsky@gmail.com GIT_COMMITTER_NAME=Turetsky GIT_COMMITTER_EMAIL=yjturetsky@gmail.com
. bench/hvm-rig.sh
rig_up || exit 1
SINCE=$(date -u +%FT%T.000Z)
echo "=== run start $SINCE  passes=$PASSES  tests=[$TESTS]  doc=$DOC"
for p in $(seq 1 "$PASSES"); do
  for t in $TESTS; do
    echo "=== pass $p/$PASSES  $t  $(date -u +%FT%TZ)"
    rig_up > /dev/null || { echo "!!! rig down before $t (pass $p); skipping cell"; continue; }
    node bench/run.js --client grok_runner --transport local --test "$t" || echo "!!! cell $t failed (pass $p)"
  done
  node bench/hvm-report.js --since "$SINCE" --passes "$PASSES" --out "$DOC" || echo "!!! report failed"
  node bench/drive-runner.js usage > /dev/null
  git add bench/results.jsonl bench/tool-usage.jsonl bench/tool-usage.md "$DOC"
  git commit -q -m "bench(hvm): grok_runner local-transport pass $p/$PASSES" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && echo "=== committed pass $p: $(git rev-parse --short HEAD)"
done
echo "=== DONE $(date -u +%FT%TZ)"
