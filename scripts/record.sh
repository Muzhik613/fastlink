#!/usr/bin/env bash
# record.sh — screen-record a live browser run from WSL with Windows ffmpeg (gdigrab) → .mkv.
#   bash scripts/record.sh start [OUT.mkv]   start a detached recorder of Chrome's monitor
#   bash scripts/record.sh stop              stop gracefully, then VERIFY the file (exit 1 if bad)
#   bash scripts/record.sh status            is a recording running?
#
# Why it is built this way (2026-09-16, azure-run.mkv came out 0 bytes):
#  - Capture ONE monitor, never `-i desktop` bare. The desktop spans 3 monitors (5840x2029, odd
#    height); libx264 refuses odd dimensions, so ffmpeg exited after 0.12s having only created
#    the file. Output is scaled to even dims as a second guard.
#  - .mkv, not .mp4: an mp4 killed mid-write loses its moov atom; mkv stays playable.
#  - Detached with setsid; ffmpeg's stdin is a FIFO held open by a sleeper, so it outlives the
#    launching shell (e.g. a Claude Code background job) and `stop` can send 'q' — ffmpeg's clean
#    exit. Force-kill only after the graceful stop times out.
#  - Warns when Chrome is not the foreground window: Windows throttles occluded windows, and a
#    recording of a hidden browser is misleading.
#  - No PowerShell *capture* (AMSI blocks it); PowerShell is used only to read window/monitor rects.
# Env: FPS (default 10), STOP_TIMEOUT seconds (default 20).
set -euo pipefail

FF=/mnt/c/Users/yjtur/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe
WINTMP=/mnt/c/Users/yjtur/AppData/Local/Temp
STATE=/tmp/fastlink-record
FPS="${FPS:-10}"
STOP_TIMEOUT="${STOP_TIMEOUT:-20}"

die() { echo "[record] FAIL: $*" >&2; exit 1; }
say() { echo "[record] $*" >&2; }
running() { [ -f "$STATE/ffmpeg.pid" ] && kill -0 "$(cat "$STATE/ffmpeg.pid")" 2>/dev/null; }

# Prints "<fgProcess>|<chromeFg 0/1>|<x>|<y>|<w>|<h>" — the monitor (physical px, ffmpeg's
# coordinate space) holding the foreground Chrome window, else Chrome's main window, else primary.
probe_windows() {
  local ps1="$WINTMP/fastlink-record-probe.ps1"
  cat > "$ps1" <<'EOF'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class FLR {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int cb; public RECT M; public RECT W; public uint F; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MI mi);
}
'@
[FLR]::SetProcessDPIAware() | Out-Null
$fg = [FLR]::GetForegroundWindow(); $procId = 0
[FLR]::GetWindowThreadProcessId($fg, [ref]$procId) | Out-Null
$fgName = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
$chromeFg = [int]($fgName -eq 'chrome')
$target = $fg
if (-not $chromeFg) {
  $c = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and -not [FLR]::IsIconic($_.MainWindowHandle) } | Select-Object -First 1
  $target = if ($c) { $c.MainWindowHandle } else { [IntPtr]::Zero }
}
$mi = New-Object FLR+MI; $mi.cb = [Runtime.InteropServices.Marshal]::SizeOf($mi)
[FLR]::GetMonitorInfo([FLR]::MonitorFromWindow($target, 1), [ref]$mi) | Out-Null
"$fgName|$chromeFg|$($mi.M.L)|$($mi.M.T)|$($mi.M.R - $mi.M.L)|$($mi.M.B - $mi.M.T)"
EOF
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$ps1")" | tr -d '\r' | tail -1
  rm -f "$ps1"
}

cmd_start() {
  running && die "already recording → $(cat "$STATE/out.win") (run: record.sh stop)"
  rm -rf "$STATE"; mkdir -p "$STATE"
  local out="${1:-/mnt/c/Users/yjtur/Videos/fastlink-$(date +%Y%m%d-%H%M%S).mkv}"
  [[ "$out" == *.mkv ]] || die "output must be .mkv (mp4 is unplayable after a hard stop): $out"
  [[ "$out" == /mnt/* ]] || die "output must be on a Windows drive (/mnt/c/...): $out"
  mkdir -p "$(dirname "$out")"; rm -f "$out"

  local info fg chromefg x y w h
  info="$(probe_windows)" || die "window probe failed"
  IFS='|' read -r fg chromefg x y w h <<<"$info"
  [[ "$w" =~ ^[0-9]+$ && "$w" -gt 0 && "$h" -gt 0 ]] || die "bad monitor rect from probe: $info"
  if [ "$chromefg" != 1 ]; then
    say "WARNING: Chrome is NOT the foreground window (foreground: ${fg:-none}). Windows throttles"
    say "WARNING: occluded windows — bring Chrome to front or this recording is misleading."
  fi

  echo "$out" > "$STATE/out"; wslpath -w "$out" > "$STATE/out.win"
  mkfifo "$STATE/stdin"
  setsid nohup sleep infinity > "$STATE/stdin" 2>/dev/null < /dev/null &
  echo $! > "$STATE/holder.pid"
  setsid nohup "$FF" -hide_banner -nostats -y -f gdigrab -framerate "$FPS" \
    -offset_x "$x" -offset_y "$y" -video_size "${w}x${h}" -i desktop \
    -vf "scale=trunc(min(iw\,1920)/2)*2:-2" -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
    "$(cat "$STATE/out.win")" < "$STATE/stdin" > "$STATE/ffmpeg.log" 2>&1 &
  echo $! > "$STATE/ffmpeg.pid"

  # Fail fast if ffmpeg dies on startup (the 0-byte bug): it must still be alive and writing.
  for _ in $(seq 1 30); do
    running || { cat "$STATE/ffmpeg.log" >&2; die "ffmpeg exited during startup"; }
    [ "$(stat -c %s "$out" 2>/dev/null || echo 0)" -gt 0 ] && break
    sleep 0.5
  done
  [ "$(stat -c %s "$out" 2>/dev/null || echo 0)" -gt 0 ] || { cat "$STATE/ffmpeg.log" >&2; die "no bytes written after 15s"; }
  say "recording monitor ${w}x${h}@${x},${y} → $(cat "$STATE/out.win")"
}

cmd_stop() {
  [ -f "$STATE/out" ] || die "no recording state in $STATE (never started?)"
  local out; out="$(cat "$STATE/out")"
  if running; then
    printf q > "$STATE/stdin"
    local i=0
    while running && [ "$i" -lt $((STOP_TIMEOUT * 2)) ]; do sleep 0.5; i=$((i + 1)); done
    if running; then
      say "graceful stop timed out after ${STOP_TIMEOUT}s — force-killing ffmpeg"
      local base; base="$(basename "$out")"
      powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | Where-Object { \$_.CommandLine -like '*$base*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" > /dev/null 2>&1 || true
      kill "$(cat "$STATE/ffmpeg.pid")" 2>/dev/null || true
    fi
  else
    say "WARNING: ffmpeg was not running at stop — it died on its own; log follows"
    cat "$STATE/ffmpeg.log" >&2
  fi
  kill "$(cat "$STATE/holder.pid")" 2>/dev/null || true

  local size dur
  size="$(stat -c %s "$out" 2>/dev/null || echo 0)"
  [ "$size" -gt 0 ] || die "$out is ZERO BYTES — nothing was recorded (log: $STATE/ffmpeg.log)"
  dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$out" 2>/dev/null || true)"
  awk -v d="$dur" 'BEGIN { exit !(d + 0 > 0) }' \
    || die "$out does not probe as video (duration='$dur', ${size} bytes; log: $STATE/ffmpeg.log)"
  echo "[record] OK $(cat "$STATE/out.win") — ${dur}s, ${size} bytes"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  stop) cmd_stop ;;
  status) if running; then echo "recording → $(cat "$STATE/out.win")"; else echo "not recording"; fi ;;
  *) echo "usage: $0 start [OUT.mkv] | stop | status" >&2; exit 2 ;;
esac
