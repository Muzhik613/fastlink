#!/usr/bin/env bash
# hvm-rig.sh — env + idempotent bring-up of the self-driving bench rig on hvm (user dev).
# Source it for the env (hvm-run.sh does), or run it to (re)start whatever is down:
#   Xvfb :98 → Chrome for Testing + unpacked fast-ext → FastLink broker :9876 → grokcode proxy :8791.
# Chrome for Testing, not /usr/bin/google-chrome: branded Chrome ≥137 silently ignores
# --load-extension. --no-sandbox because Ubuntu 24.04's AppArmor blocks unprivileged user
# namespaces (Chrome aborts with "No usable sandbox"). --password-store=basic: without it every
# SW network path (fetch/WS/broker) is frozen ~24.8s after launch by the os_crypt keyring D-Bus
# timeout; with it the extension attaches in ~19ms. Proxy is on 8791 because 8790 on hvm
# belongs to an unrelated service.
# Everything starts via setsid+nohup so it outlives the ssh session that launched it.
export GROKCODE_DIR=/home/dev/code/grokcode
export GROKCODE_PORT=8791
export GROKCODE_URL=http://127.0.0.1:8791
export GROKCODE_EFFORT=low
export DISPLAY=:98
RIG_PROFILE=/home/dev/.local/share/fastlink-bench-profile
# DevTools port of the RIG Chrome ONLY. bench/rig.js resets the whole browser (every tab, every
# window → one about:blank) before each cell through it, and treats these two exports plus a
# listener on this port whose cmdline carries BOTH --user-data-dir=$RIG_PROFILE and this port as
# the proof that it is on the dedicated rig. The owner's Chrome never has them, so a bench run
# on his profile only closes that test's own tabs. Bound to 127.0.0.1 (Chrome's default); the
# profile is signed out of everything, so a local client reaching it finds a blank browser.
RIG_CDP_PORT=9335
export FASTLINK_RIG_PROFILE="$RIG_PROFILE" FASTLINK_RIG_CDP_PORT="$RIG_CDP_PORT"
RIG_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RIG_CHROME=$(ls -d /home/dev/.local/share/fastlink-bench-chrome/chrome/linux-*/chrome-linux64/chrome 2>/dev/null | tail -1)
# secrets live outside the repo, never committed
[ -f /home/dev/.config/fastrun/env ] && set -a && . /home/dev/.config/fastrun/env && set +a

listening() { ss -ltn 2>/dev/null | grep -q ":$1 "; }
daemon() { (setsid nohup "$@" < /dev/null > "$RIG_LOG" 2>&1 &); }

rig_up() {
  if ! pgrep -u "$USER" -f "^/usr/bin/Xvfb :98 " > /dev/null; then
    RIG_LOG=/tmp/fastlink-xvfb98.log daemon /usr/bin/Xvfb :98 -screen 0 1600x1000x24 -nolisten tcp; sleep 1
  fi
  if ! listening 9876; then
    RIG_LOG=/tmp/fastlink-broker.log daemon node "$RIG_REPO/fast-dxt/broker/index.js"; sleep 1
  fi
  if ! listening "$GROKCODE_PORT"; then
    (cd "$GROKCODE_DIR" && RIG_LOG="$GROKCODE_DIR/proxy.log" daemon node proxy.mjs); sleep 2
  fi
  # A rig Chrome started before the DevTools port existed can't be reset between cells, and
  # run.js refuses to run on it. Restart it once with the port.
  if pgrep -u "$USER" -f "user-data-dir=$RIG_PROFILE" > /dev/null && ! listening "$RIG_CDP_PORT"; then
    echo "rig Chrome has no DevTools port :$RIG_CDP_PORT — restarting it"
    pkill -u "$USER" -f "user-data-dir=$RIG_PROFILE"; sleep 2
  fi
  if ! pgrep -u "$USER" -f "user-data-dir=$RIG_PROFILE" > /dev/null; then
    [ -x "$RIG_CHROME" ] || { echo "no Chrome for Testing under /home/dev/.local/share/fastlink-bench-chrome (npx @puppeteer/browsers install chrome@stable --path …)"; return 1; }
    mkdir -p "$RIG_PROFILE"
    # Chrome keeps the extension's service-worker script (background.js + its imports)
    # in the profile's ScriptCache across restarts: a "restart" after rsyncing
    # index.js/text.js ran the OLD worker while content scripts (page.js) were fresh.
    # Whole dir, not just ScriptCache: the registration DB still points at the cached
    # script, and Chrome then fails the worker (DidStartWorkerFail :5) — 2026-09-15 overnight.
    rm -rf "$RIG_PROFILE/Default/Service Worker"
    RIG_LOG="$RIG_PROFILE/chrome.log" daemon "$RIG_CHROME" \
      --load-extension="$RIG_REPO/fast-ext" --user-data-dir="$RIG_PROFILE" --remote-debugging-port="$RIG_CDP_PORT" \
      --no-first-run --no-default-browser-check --disable-features=ExtensionsToolbarMenu \
      --no-sandbox --disable-gpu --disable-dev-shm-usage --password-store=basic \
      --window-size=1600,1000 about:blank
    sleep 6
  fi
  # proof, not assumption: the extension must be on the broker before a cell starts
  for i in $(seq 1 20); do
    st=$(cd "$RIG_REPO" && timeout 20 node -e 'import("./bench/fastlink.js").then(m=>m.status()).then(s=>{console.log(s.connected?"connected":"not-connected");process.exit(0)}).catch(()=>{console.log("broker-error");process.exit(0)})' 2>/dev/null | tail -1)
    [ "$st" = connected ] && { echo "rig up: extension connected (display $DISPLAY, proxy $GROKCODE_URL)"; return 0; }
    sleep 3
  done
  echo "rig NOT up: extension never connected to the broker ($st)"; return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then rig_up; fi
