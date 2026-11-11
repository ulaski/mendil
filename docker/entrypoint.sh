#!/bin/bash
# Prepares the virtual display + audio devices, then hands over to the Node controller.
set -euo pipefail

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) [entrypoint] $*"; }

# --- Virtual X display for the Qt client -----------------------------------
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
Xvfb "${DISPLAY}" -screen 0 1024x768x16 -nolisten tcp >/tmp/xvfb.log 2>&1 &

# --- PulseAudio ---------------------------------------------------------------
# "tsbot"   : ffmpeg plays music into this sink; its monitor is the client's microphone.
# "devnull" : default output, so the client never feeds what it hears back into the mic.
pulseaudio --kill >/dev/null 2>&1 || true
pulseaudio --start --exit-idle-time=-1 --log-target=stderr 2>/tmp/pulseaudio.log

for _ in $(seq 1 50); do
  pactl info >/dev/null 2>&1 && break
  sleep 0.2
done
pactl info >/dev/null || { log "PulseAudio did not start"; cat /tmp/pulseaudio.log; exit 1; }

pactl unload-module module-suspend-on-idle >/dev/null 2>&1 || true
pactl load-module module-null-sink sink_name=tsbot sink_properties=device.description=TS3Bot-Music >/dev/null
pactl load-module module-null-sink sink_name=devnull sink_properties=device.description=Discard >/dev/null
pactl set-default-sink devnull
pactl set-default-source tsbot.monitor
log "Xvfb and PulseAudio ready"

# --- yt-dlp self-update (YouTube changes often) -----------------------------
if [ "${YTDLP_AUTO_UPDATE:-true}" = "true" ]; then
  log "updating yt-dlp..."
  timeout 60 yt-dlp -U 2>&1 | tail -n 1 || log "yt-dlp update failed, continuing with $(yt-dlp --version)"
fi

exec node /app/src/index.js
