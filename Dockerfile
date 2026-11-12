# 🧻 Mendil — a music bot for TeamSpeak 3
#
# The official TeamSpeak 3 client is proprietary, so it is NOT part of this image:
# docker/entrypoint.sh downloads it on first start once you accept its license
# (TS3CLIENT_LICENSE=accept). It only exists for x86_64, hence linux/amd64 only.
# Pinned; Dependabot (.github/dependabot.yml) proposes updates.
FROM node:22.23.5-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Xvfb + PulseAudio give the GUI client a virtual screen and a virtual sound card.
# The lib* packages are runtime dependencies of the Qt-based TS3 client.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg procps sqlite3 tini \
      xvfb pulseaudio pulseaudio-utils \
      libasound2 libatomic1 libdbus-1-3 libdrm2 libegl1 libevent-2.1-7 libfontconfig1 libfreetype6 \
      libgbm1 libgl1 libglib2.0-0 libice6 libnss3 libpci3 libpulse0 libsm6 libxslt1.1 \
      libxcb-glx0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 \
      libxcb-shape0 libxcb-sync1 libxcb-util1 libxcb-xfixes0 libxcb-xinerama0 libxcb-xkb1 \
      libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libxkbcommon0 libxkbcommon-x11-0 \
      libxkbfile1 libxrandr2 libxshmfence1 libxss1 libxtst6 \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone binary; owned by the runtime user so it can self-update (yt-dlp -U).
RUN curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
 && chmod 755 /usr/local/bin/yt-dlp \
 && chown node:node /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh \
 && mkdir -p /opt/ts3client /home/node/.ts3client \
 && chown -R node:node /opt/ts3client /home/node

USER node
ENV HOME=/home/node \
    DISPLAY=:99 \
    NODE_ENV=production \
    TS3_CLIENT_VERSION=3.6.2

# The client's identity + settings. Persist it to keep the same TS3 identity (and server groups).
VOLUME ["/home/node/.ts3client"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=3m --retries=3 \
  CMD ["node", "/app/src/healthcheck.js"]

# tini as PID 1 reaps orphaned processes and forwards signals, also for plain `docker run`.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
