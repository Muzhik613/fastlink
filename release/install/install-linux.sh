#!/bin/sh
# FastLink one-time installer for Linux (Google Chrome and Chromium, deb or snap).
# Writes a Chrome "managed policy" that force-installs FastLink from its self-hosted
# update feed. Chrome then installs it and keeps it up to date by itself (~every 5 h).
#
#   sudo sh install-linux.sh            install (then restart the browser)
#   sudo sh install-linux.sh --remove   uninstall (deletes the policy; the browser removes FastLink)
#
# Replace, don't layer: if FastLink was loaded unpacked (--load-extension or
# "Load unpacked"), stop loading it that way. Both copies share one extension id;
# the policy copy takes over and keeps its pairing (chrome.storage is per id).
set -eu

ID=ockcjadbkdfgfllidpcoamcepahfmlpf
FEED=https://raw.githubusercontent.com/Turetsky/fastlink/main/release/updates.xml
FILE=fastlink.json
# Google Chrome, Chromium (deb), Chromium (snap reads the host's /etc/chromium-browser).
DIRS="/etc/opt/chrome/policies/managed /etc/chromium/policies/managed /etc/chromium-browser/policies/managed"

[ "$(id -u)" = 0 ] || { echo "run with sudo: sudo sh $0 $*"; exit 1; }

if [ "${1:-}" = "--remove" ]; then
  for d in $DIRS; do rm -f "$d/$FILE"; done
  echo "FastLink policy removed. Restart the browser; it removes FastLink."
  exit 0
fi

for d in $DIRS; do
  mkdir -p "$d"
  printf '{ "ExtensionInstallForcelist": ["%s;%s"] }\n' "$ID" "$FEED" > "$d/$FILE"
  chmod 644 "$d/$FILE"
done
echo "FastLink policy installed. Restart the browser (fully quit it), then check:"
echo "  chrome://policy        ExtensionInstallForcelist lists $ID"
echo "  chrome://extensions    FastLink, 'Installed by your administrator'"
echo "New browser: open FastLink's welcome page and pair it with a code from https://relay.ytx.app/pair/new"
