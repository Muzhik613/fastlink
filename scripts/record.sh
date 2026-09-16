#!/usr/bin/env bash
# record.sh — screen-record a browser run to .mkv. The ONE recorder; fast-runner/recorder.mjs calls it
# for every run (named by run_id), and you can call it by hand:
#   bash scripts/record.sh start NAME [--max SECONDS]   detached start; stdout: path= region= mode= [warning=]
#   bash scripts/record.sh stop NAME                    graceful stop + VERIFY; stdout: path= durationSec= bytes=
#   bash scripts/record.sh status [NAME]
# Exit 1 with "[record] FAIL: …" on stderr whenever there is no playable video. Never silent.
#
# Where it runs (picked automatically):
#   WSL   → Windows ffmpeg.exe gdigrab of the monitor Chrome is on (physical px, per-monitor DPI aware).
#           Chrome missing or straddling monitors → the whole virtual desktop. Warns when Chrome is not
#           the foreground window: Windows throttles occluded windows, so that video would mislead.
#           Videos: C:\Users\yjtur\Videos\fastrun\NAME.mkv
#   Linux → ffmpeg x11grab of $DISPLAY (the hvm rig: Xvfb :98, geometry from xdpyinfo; no window
#           manager, so nothing can occlude Chrome). Videos: ~/.local/state/fastrun/recordings/NAME.mkv
# RECORD_DIR overrides the video dir.
#
# Why it is built this way (2026-09-16, azure-run.mkv came out 0 bytes):
#  - libx264 refuses odd dimensions. A bare `-i desktop` over 3 monitors was 5840x2029, so ffmpeg died
#    in 0.12s after creating the file. Every region is cut to even w/h, and the filter chain crops to
#    even again, whatever the capture source.
#  - .mkv, not .mp4: an mp4 killed mid-write loses its moov atom; mkv stays playable.
#  - Detached (setsid) with stdin on a FIFO held open by a sleeper: survives the launching shell, and
#    `stop` sends 'q', ffmpeg's clean exit. Force only after STOP_TIMEOUT. `-t --max` (default 1800s)
#    ends a recording whose runner died without calling stop.
#  - No PowerShell *capture* (AMSI blocks it); PowerShell only reads window/monitor rects.
# Retention, applied on every start: newest RECORD_KEEP (50) videos, none older than RECORD_MAX_DAYS (14).
# Env: FPS (10), STOP_TIMEOUT (20), RECORD_DIR, RECORD_KEEP, RECORD_MAX_DAYS.
set -euo pipefail

FPS="${FPS:-10}"
STOP_TIMEOUT="${STOP_TIMEOUT:-20}"
RECORD_KEEP="${RECORD_KEEP:-50}"
RECORD_MAX_DAYS="${RECORD_MAX_DAYS:-14}"
STATE_ROOT=/tmp/fastlink-record
FILTER="crop=trunc(iw/2)*2:trunc(ih/2)*2,scale='min(iw,1920)':-2"

die() { echo "[record] FAIL: $*" >&2; exit 1; }
say() { echo "[record] $*" >&2; }

if grep -qi microsoft /proc/version 2>/dev/null; then
  MODE=gdigrab
  FF="$(command -v ffmpeg.exe || echo /mnt/c/Users/yjtur/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe)"
  RECORD_DIR="${RECORD_DIR:-/mnt/c/Users/yjtur/Videos/fastrun}"
else
  MODE=x11grab
  FF="$(command -v ffmpeg || true)"
  RECORD_DIR="${RECORD_DIR:-$HOME/.local/state/fastrun/recordings}"
fi

name_ok() { [[ "${1:-}" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "NAME must be [A-Za-z0-9_-]{1,64}, got '${1:-}'"; }
running() { [ -f "$1/ffmpeg.pid" ] && kill -0 "$(cat "$1/ffmpeg.pid")" 2>/dev/null; }

# Windows: prints "fgProcess|chromeFg(0/1)|region-label|x|y|w|h" in physical pixels.
probe_windows() {
  local ps1=/mnt/c/Users/yjtur/AppData/Local/Temp/fastlink-record-probe-$$.ps1
  cat > "$ps1" <<'EOF'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class FLR {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int cb; public RECT M; public RECT W; public uint F; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MI mi);
}
'@
if (-not [FLR]::SetProcessDpiAwarenessContext([IntPtr]-4)) { [FLR]::SetProcessDPIAware() | Out-Null }
$fg = [FLR]::GetForegroundWindow(); $procId = 0
[FLR]::GetWindowThreadProcessId($fg, [ref]$procId) | Out-Null
$fgName = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
$chromeFg = [int]($fgName -eq 'chrome')
$target = [IntPtr]::Zero
if ($chromeFg) { $target = $fg } else {
  $c = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and -not [FLR]::IsIconic($_.MainWindowHandle) } | Select-Object -First 1
  if ($c) { $target = $c.MainWindowHandle }
}
$out = $null
if ($target -ne [IntPtr]::Zero) {
  $r = New-Object FLR+RECT; [FLR]::GetWindowRect($target, [ref]$r) | Out-Null
  $mi = New-Object FLR+MI; $mi.cb = [Runtime.InteropServices.Marshal]::SizeOf($mi)
  [FLR]::GetMonitorInfo([FLR]::MonitorFromWindow($target, 2), [ref]$mi) | Out-Null
  $m = $mi.M
  $iw = [Math]::Max(0, [Math]::Min($r.R, $m.R) - [Math]::Max($r.L, $m.L))
  $ih = [Math]::Max(0, [Math]::Min($r.B, $m.B) - [Math]::Max($r.T, $m.T))
  $area = [Math]::Max(1, ($r.R - $r.L) * ($r.B - $r.T))
  if (($iw * $ih) / $area -ge 0.9) { $out = "monitor|$($m.L)|$($m.T)|$($m.R - $m.L)|$($m.B - $m.T)" }
}
if (-not $out) { $out = "desktop|$([FLR]::GetSystemMetrics(76))|$([FLR]::GetSystemMetrics(77))|$([FLR]::GetSystemMetrics(78))|$([FLR]::GetSystemMetrics(79))" }
"$fgName|$chromeFg|$out"
EOF
  local res rc=0
  res="$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$ps1")" 2>&1 | tr -d '\r')" || rc=$?
  rm -f "$ps1"
  [ "$rc" = 0 ] || die "window probe failed: $res"
  echo "$res" | tail -1
}

prune() {
  mkdir -p "$RECORD_DIR"
  local active=" " d f
  for d in "$STATE_ROOT"/*/; do [ -f "$d/out" ] && running "$d" && active+="$(basename "$(cat "$d/out")") "; done
  find "$RECORD_DIR" -maxdepth 1 -name '*.mkv' -mtime +"$RECORD_MAX_DAYS" -print0 2>/dev/null |
    while IFS= read -r -d '' f; do [[ "$active" == *" $(basename "$f") "* ]] || rm -f "$f"; done || true
  ls -1t "$RECORD_DIR"/*.mkv 2>/dev/null | tail -n +"$((RECORD_KEEP + 1))" |
    while IFS= read -r f; do [[ "$active" == *" $(basename "$f") "* ]] || rm -f "$f"; done || true
}

cmd_start() {
  local name="${1:-}"; name_ok "$name"; shift
  local max=1800
  while [ $# -gt 0 ]; do case "$1" in --max) max="$2"; shift 2 ;; *) die "unknown arg $1" ;; esac; done
  [[ "$max" =~ ^[0-9]+$ ]] || die "--max must be whole seconds"
  [ -n "$FF" ] && [ -e "$FF" ] || die "ffmpeg not found for $MODE"
  local st="$STATE_ROOT/$name"
  running "$st" && die "already recording '$name' → $(cat "$st/out")"
  rm -rf "$st"; mkdir -p "$st"
  prune
  local out="$RECORD_DIR/$name.mkv"; rm -f "$out"

  local input region warning=""
  if [ "$MODE" = gdigrab ]; then
    local fg chromefg label x y w h
    IFS='|' read -r fg chromefg label x y w h <<<"$(probe_windows)"
    [[ "$w" =~ ^[0-9]+$ && "$h" =~ ^[0-9]+$ && "$w" -ge 2 && "$h" -ge 2 ]] || die "bad capture rect from probe: $fg|$chromefg|$label|$x|$y|$w|$h"
    w=$((w / 2 * 2)); h=$((h / 2 * 2))
    [ "$chromefg" = 1 ] || warning="Chrome is not the foreground window (foreground: ${fg:-none}); Windows throttles occluded windows, so this video may not show the real run"
    input=(-f gdigrab -framerate "$FPS" -offset_x "$x" -offset_y "$y" -video_size "${w}x${h}" -i desktop)
    region="$label:${w}x${h}@$x,$y"
    wslpath -w "$out" > "$st/ffout"
  else
    [ -n "${DISPLAY:-}" ] || die "no DISPLAY to record (x11grab)"
    local dims; dims="$(xdpyinfo -display "$DISPLAY" 2>/dev/null | awk '/dimensions:/ {print $2; exit}')"
    [[ "$dims" =~ ^([0-9]+)x([0-9]+)$ ]] || die "cannot read geometry of display $DISPLAY (xdpyinfo: '$dims')"
    local w=$((BASH_REMATCH[1] / 2 * 2)) h=$((BASH_REMATCH[2] / 2 * 2))
    input=(-f x11grab -framerate "$FPS" -video_size "${w}x${h}" -i "$DISPLAY+0,0")
    region="display$DISPLAY:${w}x${h}"
    echo "$out" > "$st/ffout"
  fi

  echo "$out" > "$st/out"
  mkfifo "$st/stdin"
  setsid nohup sleep infinity > "$st/stdin" 2>/dev/null < /dev/null &
  echo $! > "$st/holder.pid"
  setsid nohup "$FF" -hide_banner -nostats -y "${input[@]}" -t "$max" \
    -vf "$FILTER" -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
    "$(cat "$st/ffout")" < "$st/stdin" > "$st/ffmpeg.log" 2>&1 &
  echo $! > "$st/ffmpeg.pid"

  # Started = the encoder opened ("Output #0" is logged only after it does — the 0-byte bug died at
  # "Error while opening encoder", before that line). Waiting for bytes instead costs ~7s: mkv
  # flushes its first cluster late. Bytes and a real duration are checked by `stop`.
  local i
  for i in $(seq 1 60); do
    if ! running "$st"; then
      kill "$(cat "$st/holder.pid")" 2>/dev/null || true
      tail -5 "$st/ffmpeg.log" >&2; die "ffmpeg exited during startup (log: $st/ffmpeg.log)"
    fi
    grep -q '^Output #0' "$st/ffmpeg.log" 2>/dev/null && break
    sleep 0.25
  done
  if ! grep -q '^Output #0' "$st/ffmpeg.log" 2>/dev/null; then
    tail -5 "$st/ffmpeg.log" >&2
    STOP_TIMEOUT=5 cmd_stop "$name" > /dev/null 2>&1 || true
    die "ffmpeg did not open its output within 15s — stopped it (log was $st/ffmpeg.log)"
  fi
  [ -n "$warning" ] && say "WARNING: $warning"
  echo "path=$out"; echo "mode=$MODE"; echo "region=$region"
  [ -n "$warning" ] && echo "warning=$warning"
  return 0
}

cmd_stop() {
  local name="${1:-}"; name_ok "$name"
  local st="$STATE_ROOT/$name"
  [ -f "$st/out" ] || die "no recording named '$name' (never started?)"
  local out; out="$(cat "$st/out")"
  if running "$st"; then
    printf q > "$st/stdin"
    local i=0
    while running "$st" && [ "$i" -lt $((STOP_TIMEOUT * 2)) ]; do sleep 0.5; i=$((i + 1)); done
    if running "$st"; then
      say "graceful stop timed out after ${STOP_TIMEOUT}s — force-killing ffmpeg"
      if [ "$MODE" = gdigrab ]; then
        powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'ffmpeg.exe' -and \$_.CommandLine -like '*\\$name.mkv*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" > /dev/null 2>&1 || true
      fi
      kill -INT "$(cat "$st/ffmpeg.pid")" 2>/dev/null || true; sleep 2
      kill -KILL "$(cat "$st/ffmpeg.pid")" 2>/dev/null || true
    fi
  else
    say "note: ffmpeg had already exited before stop (--max reached, or it died — log: $st/ffmpeg.log)"
  fi
  kill "$(cat "$st/holder.pid")" 2>/dev/null || true

  local size dur
  size="$(stat -c %s "$out" 2>/dev/null || echo 0)"
  [ "$size" -gt 0 ] || { tail -5 "$st/ffmpeg.log" >&2; die "$out is ZERO BYTES — nothing was recorded (log: $st/ffmpeg.log)"; }
  dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$out" 2>/dev/null || true)"
  awk -v d="$dur" 'BEGIN { exit !(d + 0 > 0) }' \
    || die "$out does not probe as video (duration='$dur', $size bytes; log: $st/ffmpeg.log)"
  rm -rf "$st"
  echo "path=$out"; echo "durationSec=$dur"; echo "bytes=$size"
}

cmd_status() {
  local d any=0
  for d in "$STATE_ROOT"/${1:-*}/; do
    [ -f "$d/out" ] || continue; any=1
    if running "$d"; then echo "recording $(basename "$d") → $(cat "$d/out")"; else echo "stopped (not verified) $(basename "$d") → $(cat "$d/out")"; fi
  done
  [ "$any" = 1 ] || echo "not recording"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  status) shift; cmd_status "$@" ;;
  *) echo "usage: $0 start NAME [--max SECONDS] | stop NAME | status [NAME]" >&2; exit 2 ;;
esac
