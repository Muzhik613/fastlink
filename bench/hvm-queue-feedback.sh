#!/usr/bin/env bash
# hvm-queue-feedback.sh — queued after the running feedback pass 1: waits for that hvm-run.sh
# to exit, then runs pass 2 (grok-4.6 / phase2 control) and pass 3 (grok-4.3 / phase2-eval A/B)
# into the same doc/SINCE window, each committing its rows + regenerated doc on hvm.
#   cd /home/dev/code/Fastlink && setsid nohup bash bench/hvm-queue-feedback.sh <pid-of-pass-1> > bench/hvm-queue-feedback.log 2>&1 &
set -u
cd "$(dirname "$0")/.." || exit 1
WAIT_PID=${1:-}
while [ -n "$WAIT_PID" ] && kill -0 "$WAIT_PID" 2>/dev/null; do sleep 15; done
export SINCE=${SINCE:-2026-09-15T07:06:06.000Z}
export DOC=${DOC:-docs/GROK_RUNNER_BENCH_hvm_feedback_2026-09-15.md}
NOTES0='feedback bench; WSL commits: 653f33e dffa7c7 999d58e f37fcf8 c12716f 13bf127; pass 1 = grok-4.3/phase2;'
echo "=== queue: pass 2 (grok-4.6 / phase2 control) $(date -u +%FT%TZ)"
PASS_START=2 PASSES=1 FASTRUN_MODEL=grok-4.6 TOOLSET=phase2 NOTES="$NOTES0" bash bench/hvm-run.sh
echo "=== queue: pass 3 (grok-4.3 / phase2-eval A/B) $(date -u +%FT%TZ)"
PASS_START=3 PASSES=1 FASTRUN_MODEL=grok-4.3 TOOLSET=phase2-eval NOTES="$NOTES0 pass 2 = grok-4.6/phase2 control;" bash bench/hvm-run.sh
echo "=== queue DONE $(date -u +%FT%TZ)"
