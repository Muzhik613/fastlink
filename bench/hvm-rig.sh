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
# The rig profile's broker SLOT LABEL. It must never be primary/secondary, which are the owner's
# Profile 1 / Profile 6. bench/rig.js resets the whole browser (every tab in every window → one
# about:blank) before each cell only when this is set AND the cell is pinned to this connected
# install; everywhere else a cell closes only its own tabs. rig_up puts this label on the rig
# profile itself (see rig_label) and does not return 0 until the broker shows it connected.
export FASTLINK_RIG_INSTALL=rig
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
      --load-extension="$RIG_REPO/fast-ext" --user-data-dir="$RIG_PROFILE" \
      --no-first-run --no-default-browser-check --disable-features=ExtensionsToolbarMenu \
      --no-sandbox --disable-gpu --disable-dev-shm-usage --password-store=basic \
      --window-size=1600,1000 about:blank
    sleep 6
  fi
  # proof, not assumption: the extension must be on the broker AS THE RIG LABEL before a cell starts.
  # A fresh or wiped profile says hello as "primary"; the first miss hands it the label (rig_label),
  # a second try covers a hand-off that landed before the extension had loaded.
  for i in $(seq 1 20); do
    st=$(cd "$RIG_REPO" && timeout 20 node -e 'import("./bench/fastlink.js").then(m=>m.status()).then(s=>{const on=Object.keys(s.installs||{}).filter(k=>s.installs[k]?.connected);console.log(on.includes(process.argv[1])?"rig":"connected:"+(on.join(",")||"none"));process.exit(0)}).catch(()=>{console.log("broker-error");process.exit(0)})' "$FASTLINK_RIG_INSTALL" 2>/dev/null | tail -1)
    [ "$st" = rig ] && { echo "rig up: install \"$FASTLINK_RIG_INSTALL\" connected (display $DISPLAY, proxy $GROKCODE_URL)"; return 0; }
    if [ "$i" = 1 ] || [ "$i" = 10 ]; then rig_label || return 1; fi
    sleep 3
  done
  echo "rig NOT up: install \"$FASTLINK_RIG_INSTALL\" never connected to the broker ($st)"; return 1
}

# Put the slot label on the rig profile with no click and no root: hand the running rig Chrome its
# own options page with ?slot=<label> (fast-ext/options.js applyLaunchSlot stores it and reloads the
# extension, or does nothing if it is already set). A second chrome with the same --user-data-dir
# only forwards the URL to the running browser and exits. The extension id is derived from
# manifest.json "key", so it is fixed and survives a wiped profile.
# Not Chrome managed storage: Chrome for Testing reads policy only from root-owned /etc/opt.
rig_label() {
  local id
  # Only ever a hand-off: with no rig Chrome running this would START one without the rig flags.
  pgrep -u "$USER" -f "user-data-dir=$RIG_PROFILE" > /dev/null && [ -x "$RIG_CHROME" ] \
    || { echo "rig_label: no running rig Chrome to hand the slot label to"; return 1; }
  id=$(node -e 'const k=Buffer.from(require(process.argv[1]).key,"base64");const h=require("crypto").createHash("sha256").update(k).digest("hex").slice(0,32);console.log([...h].map(c=>String.fromCharCode(97+parseInt(c,16))).join(""))' "$RIG_REPO/fast-ext/manifest.json") \
    || { echo "rig_label: cannot derive the extension id from fast-ext/manifest.json"; return 1; }
  RIG_LOG="$RIG_PROFILE/chrome-label.log" daemon "$RIG_CHROME" --user-data-dir="$RIG_PROFILE" \
    "chrome-extension://$id/options.html?slot=$FASTLINK_RIG_INSTALL"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then rig_up; fi
