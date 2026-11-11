# TeamSpeak 3 Music Bot
# The official TS3 Linux client only exists for x86_64, so this image must be
# built/run as linux/amd64 (docker-compose.yml sets the platform).
FROM node:22-bookworm-slim

ARG TS3_CLIENT_VERSION=3.6.2
ENV DEBIAN_FRONTEND=noninteractive

# Xvfb + PulseAudio give the GUI client a virtual screen and a virtual sound card.
# The lib* packages are runtime dependencies of the Qt-based TS3 client.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg procps sqlite3 \
      xvfb pulseaudio pulseaudio-utils \
      libasound2 libatomic1 libdbus-1-3 libdrm2 libegl1 libevent-2.1-7 libfontconfig1 libfreetype6 \
      libgbm1 libgl1 libglib2.0-0 libice6 libnss3 libpci3 libpulse0 libsm6 libxslt1.1 \
      libxcb-glx0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 \
      libxcb-shape0 libxcb-sync1 libxcb-util1 libxcb-xfixes0 libxcb-xinerama0 libxcb-xkb1 \
      libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libxkbcommon0 libxkbcommon-x11-0 \
      libxkbfile1 libxrandr2 libxshmfence1 libxss1 libxtst6 \
 && rm -rf /var/lib/apt/lists/*

# Official TeamSpeak 3 client. --accept accepts the TeamSpeak EULA non-interactively.
RUN curl -fsSL -o /tmp/ts3client.run \
      "https://files.teamspeak-services.com/releases/client/${TS3_CLIENT_VERSION}/TeamSpeak3-Client-linux_amd64-${TS3_CLIENT_VERSION}.run" \
 && sh /tmp/ts3client.run --accept --noexec --target /opt/ts3client \
 && rm /tmp/ts3client.run \
 && chmod -R a+rX /opt/ts3client

# yt-dlp standalone binary; owned by the runtime user so it can self-update (yt-dlp -U).
RUN curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
 && chmod 755 /usr/local/bin/yt-dlp \
 && chown node:node /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh \
 && mkdir -p /home/node/.ts3client && chown -R node:node /home/node

USER node
ENV HOME=/home/node \
    DISPLAY=:99 \
    NODE_ENV=production

# Persist the client's identity + settings (keeps the same TS3 identity across restarts).
VOLUME ["/home/node/.ts3client"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
