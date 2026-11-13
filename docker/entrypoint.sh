#!/bin/bash
# Classic engine: installs the TeamSpeak client if needed and prepares the virtual display
# and audio devices. Native engine: none of that is needed. Then hands over to Node.
set -euo pipefail

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) [entrypoint] $*"; }
die() { log "ERROR: $*"; exit 1; }

TS3_CLIENT_DIR="${TS3_CLIENT_DIR:-/opt/ts3client}"
TS3_CLIENT_VERSION="${TS3_CLIENT_VERSION:-3.6.2}"

# --- TeamSpeak 3 client (proprietary, downloaded on first start) ---------------
install_ts3_client() {
  if [ "${TS3CLIENT_LICENSE:-}" != "accept" ]; then
    die "The TeamSpeak 3 client is proprietary software and is downloaded on first start.
Read its license (https://www.teamspeak.com/en/privacy-and-terms/) and set TS3CLIENT_LICENSE=accept to accept it."
  fi

  local arch
  arch="$(uname -m)"
  [ "$arch" = "x86_64" ] || log "WARNING: the TeamSpeak 3 client only exists for x86_64, this is $arch (expect emulation to be slow)"

  local url="https://files.teamspeak-services.com/releases/client/${TS3_CLIENT_VERSION}/TeamSpeak3-Client-linux_amd64-${TS3_CLIENT_VERSION}.run"
  local tmp
  tmp="$(mktemp -d)"
  log "downloading TeamSpeak client ${TS3_CLIENT_VERSION}…"
  curl -fsSL -o "$tmp/ts3client.run" "$url" || die "download failed: $url"

  # Check the download against the SHA-256 that TeamSpeak lists on its downloads page.
  # Other versions: set TS3_CLIENT_SHA256 yourself, or the download is used unverified.
  local expected="${TS3_CLIENT_SHA256:-}"
  if [ -z "$expected" ]; then
    case "$TS3_CLIENT_VERSION" in
      3.6.2) expected=59f110438971a23f904a700e7dd0a811cf99d4e6b975ba3aa45962d43b006422 ;;
    esac
  fi
  local actual
  actual="$(sha256sum "$tmp/ts3client.run" | cut -d' ' -f1)"
  if [ -n "$expected" ]; then
    [ "$actual" = "$expected" ] || { rm -rf "$tmp"; die "checksum mismatch for the TeamSpeak client download (expected $expected, got $actual)"; }
    log "TeamSpeak client download verified (sha256 $actual)"
  else
    log "WARNING: no known checksum for TeamSpeak client ${TS3_CLIENT_VERSION}; set TS3_CLIENT_SHA256 to verify it (got sha256 $actual)"
  fi
  rm -rf "${TS3_CLIENT_DIR:?}/"* "${TS3_CLIENT_DIR}/".[!.]* 2>/dev/null || true
  # --accept: the license was accepted above via TS3CLIENT_LICENSE=accept
  # (its progress meter goes to stderr without newlines, so keep it out of the logs)
  sh "$tmp/ts3client.run" --accept --noexec --nox11 --target "$TS3_CLIENT_DIR" >"$tmp/extract.log" 2>&1 \
    || { cat "$tmp/extract.log"; die "could not extract the TeamSpeak client"; }
  rm -rf "$tmp"
  echo "$TS3_CLIENT_VERSION" > "$TS3_CLIENT_DIR/.installed-version"
  log "TeamSpeak client installed to $TS3_CLIENT_DIR"
}

# Leftovers from a previous run (/tmp survives container restarts): X lock files, the
# health marker (must not report "healthy" before we reconnect), and yt-dlp's PyInstaller
# extraction dirs (normally removed by yt-dlp itself, but not if it was killed hard).
rm -rf /tmp/.X99-lock /tmp/.X11-unix/X99 /tmp/mendil.healthy /tmp/mendil-health.json /tmp/mendil-cache /tmp/_MEI* 2>/dev/null || true

VOICE_BACKEND="$(echo "${VOICE_BACKEND:-classic}" | tr '[:upper:]' '[:lower:]')"
if [ "$VOICE_BACKEND" = "native" ]; then
  log "native engine: no TeamSpeak client, X server or PulseAudio needed"
  log "yt-dlp $(yt-dlp --version)"
  exec node /app/src/index.js
fi
command -v Xvfb >/dev/null || die "this image only has the native engine; set VOICE_BACKEND=native or use ghcr.io/ulaski/mendil:latest"

if [ "$(cat "$TS3_CLIENT_DIR/.installed-version" 2>/dev/null)" != "$TS3_CLIENT_VERSION" ] \
   || [ ! -x "$TS3_CLIENT_DIR/ts3client_linux_amd64" ]; then
  install_ts3_client
fi

# --- Virtual X display for the Qt client -----------------------------------
Xvfb "${DISPLAY}" -screen 0 1024x768x16 -nolisten tcp >/tmp/xvfb.log 2>&1 &
# The bot checks these PIDs and exits (so Docker restarts the container) if one dies.
export XVFB_PID=$!

# --- PulseAudio ---------------------------------------------------------------
# "tsbot"   : ffmpeg plays music into this sink; its monitor is the client's microphone.
# "devnull" : default output, so the client never feeds what it hears back into the mic.
pulseaudio --kill >/dev/null 2>&1 || true
pulseaudio --start --exit-idle-time=-1 --log-target=stderr 2>/tmp/pulseaudio.log

for _ in $(seq 1 50); do
  pactl info >/dev/null 2>&1 && break
  sleep 0.2
done
pactl info >/dev/null || { cat /tmp/pulseaudio.log; die "PulseAudio did not start"; }
PULSE_PID="$(pgrep -u "$(id -u)" -x pulseaudio | head -n 1)"
export PULSE_PID

pactl unload-module module-suspend-on-idle >/dev/null 2>&1 || true
# 48 kHz end to end (ffmpeg output, Opus in TeamSpeak), so nothing gets resampled.
for sink in tsbot:Mendil-Music devnull:Discard; do
  pactl load-module module-null-sink "sink_name=${sink%%:*}" rate=48000 channels=2 format=s16le \
    "sink_properties=device.description=${sink#*:}" >/dev/null
done
pactl set-default-sink devnull
pactl set-default-source tsbot.monitor
log "Xvfb and PulseAudio ready"

# yt-dlp is updated by the bot in the background (src/ytdlp-update.js), not here, so a slow
# or broken update never delays startup.
log "yt-dlp $(yt-dlp --version)"

exec node /app/src/index.js
