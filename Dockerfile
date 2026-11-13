# 🧻 Mendil: a music bot for TeamSpeak 3 and 6
#
# Two images from one Dockerfile:
#   classic (default, last stage): the official TeamSpeak 3 client runs headless under Xvfb
#     with PulseAudio as its microphone. The client is proprietary, so it is NOT part of this
#     image: docker/entrypoint.sh downloads it on first start once you accept its license
#     (TS3CLIENT_LICENSE=accept). It only exists for x86_64, hence linux/amd64 only.
#   native (--target native): Mendil speaks the TeamSpeak protocol itself (teamspeak-js), so
#     none of the above is needed. Much smaller, and also runs on arm64 (Raspberry Pi).
# The classic image contains the native engine too (VOICE_BACKEND=native).

# Pinned; Dependabot (.github/dependabot.yml) proposes updates.
FROM node:26.13.0-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg procps tini python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp in a Python venv (one process per call, no self-extraction to /tmp), pinned in
# docker/requirements.txt. Owned by the runtime user so the bot can update it at runtime.
COPY docker/requirements.txt /opt/yt-dlp-requirements.txt
RUN python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir --disable-pip-version-check -r /opt/yt-dlp-requirements.txt \
 && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
 && chown -R node:node /opt/yt-dlp \
 && yt-dlp --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh \
 && mkdir -p /home/node/.ts3client \
 && chown -R node:node /home/node

ENV HOME=/home/node \
    NODE_ENV=production

# Web panel (PANEL_PORT); publish it to use it.
EXPOSE 8080

# The bot's identity, settings and saved queue. Persist it to keep the same identity
# (and with it the server groups you gave the bot).
VOLUME ["/home/node/.ts3client"]

# Healthy while the bot is connected: it touches this file every 10 s (details in
# /tmp/mendil-health.json).
HEALTHCHECK --interval=30s --timeout=5s --start-period=3m --retries=3 \
  CMD ["sh", "-c", "test $(( $(date +%s) - $(stat -c %Y /tmp/mendil.healthy 2>/dev/null || echo 0) )) -lt 60"]

# tini as PID 1 reaps orphaned processes and forwards signals, also for plain `docker run`.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]

# --- native: no TeamSpeak client ------------------------------------------------------------
FROM base AS native
USER node
ENV VOICE_BACKEND=native

# --- classic (default): the official TeamSpeak 3 client -------------------------------------
FROM base AS classic

# Xvfb + PulseAudio give the GUI client a virtual screen and a virtual sound card.
# The lib* packages are runtime dependencies of the Qt-based TS3 client.
RUN apt-get update && apt-get install -y --no-install-recommends \
      sqlite3 xvfb pulseaudio pulseaudio-utils \
      libasound2 libatomic1 libdbus-1-3 libdrm2 libegl1 libevent-2.1-7 libfontconfig1 libfreetype6 \
      libgbm1 libgl1 libglib2.0-0 libice6 libnss3 libpci3 libpulse0 libsm6 libxslt1.1 \
      libxcb-glx0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 \
      libxcb-shape0 libxcb-sync1 libxcb-util1 libxcb-xfixes0 libxcb-xinerama0 libxcb-xkb1 \
      libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libxkbcommon0 libxkbcommon-x11-0 \
      libxkbfile1 libxrandr2 libxshmfence1 libxss1 libxtst6 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/ts3client && chown node:node /opt/ts3client

USER node
ENV DISPLAY=:99 \
    TS3_CLIENT_VERSION=3.6.2
