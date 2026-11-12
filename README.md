<div align="center">

# 🧻 Mendil

**Song requests for your TeamSpeak server.**

Write a song in chat and Mendil plays it in your channel.

[![CI](https://github.com/ulaski/mendil/actions/workflows/ci.yml/badge.svg)](https://github.com/ulaski/mendil/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)
[![TeamSpeak 3 & 6](https://img.shields.io/badge/TeamSpeak-3%20%26%206-2580c3.svg)](#requirements)

</div>

```
<you>     !play daft punk around the world
Mendil    ▶ Now playing: Daft Punk - Around The World (4:02) — requested by you
```

### Why "Mendil"?

In Türkiye, people at a *gazino* or *meyhane* used to write their song request on a *mendil*, a napkin, and pass it up to the musicians on stage. Mendil does the same for your TeamSpeak server. Write your request in chat and the band plays it. *(Pronounced men-DEEL.)*

## Features

- 🎵 **Plays anything on YouTube:** a link, a whole playlist, or just search terms
- 📝 **A real queue:** search & pick, play next, skip, pause, loop, shuffle and volume
- 🔊 **Consistent loudness** between tracks, so nobody has to ride the volume
- 🐳 **One container, two settings:** accept the TeamSpeak license, point it at your server, done
- ⏭️ **No gaps between songs:** the next track is downloaded while the current one plays
- 🩹 **Recovers on its own** from crashes, kicks, bans and server restarts, and **picks up where it left off** after a restart
- 🌍 **Speaks your language:** English and Turkish built in, and [adding a language](CONTRIBUTING.md#adding-a-language) means translating one file
- 🩺 **Tells you what's wrong:** points out channel settings that make music sound bad or inaudible, and explains YouTube blocks
- 🔐 **Access control** by TeamSpeak unique ID or server group

## How it works

A bot can only send voice to a TeamSpeak server by connecting as a real client; ServerQuery can't send audio. Mendil runs the **official TeamSpeak 3 Linux client** headless and remote-controls it:

```
TeamSpeak chat ──► TS3 client ◄── ClientQuery (127.0.0.1:25639) ──► Node.js controller
                       ▲                                                 │
                       │ microphone = PulseAudio monitor                 │ yt-dlp | ffmpeg
                       └────────────── virtual sound card ◄──────────────┘
```

- **Xvfb** provides a virtual screen and **PulseAudio** a virtual sound card.
- **yt-dlp** downloads the audio (the next track while the current one plays) and **ffmpeg** plays it into the virtual card, at a loudness measured once per track. The TeamSpeak client uses that card as its microphone. Live streams and very long tracks are streamed instead.
- The queue, the current position, loop mode and volume are saved, so a restart or update resumes where it stopped.
- The controller reads chat through the client's **ClientQuery** plugin, replies, and only transmits while music is playing.
- On first start, the license dialog, intro wizard and audio settings are pre-configured, so nobody needs to click through the GUI.

## Requirements

- A **TeamSpeak 3 or TeamSpeak 6** server. Tested with TS3 server 3.13.9 and TS6 server 6.0.0-beta13.1.
- Docker with Docker Compose
- An **x86_64 (amd64)** host. The official TS3 client only exists for x86_64. ARM machines (Raspberry Pi, Apple Silicon) can run it under emulation, but it's slow.
- About 300 MB of RAM per bot
- Internet access on first start, to download the TeamSpeak client

## Quick start

No need to clone the repo. Download the compose file and the example settings:

```bash
mkdir mendil && cd mendil
curl -fsSLO https://raw.githubusercontent.com/ulaski/mendil/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/ulaski/mendil/main/.env.example
```

Edit `.env` and set at least:

```ini
TS3CLIENT_LICENSE=accept      # accepts the TeamSpeak client license, see "Legal" below
TS3_HOST=ts.example.com       # your server
TS3_SERVER_PASSWORD=          # if your server has one
```

Then start it:

```bash
docker compose up -d
docker compose logs -f
```

The first start downloads the TeamSpeak client (~110 MB). Once you see `connected to server`, join Mendil's channel and type `!help`.

<details>
<summary>Without Compose: a single <code>docker run</code></summary>

```bash
docker run -d --name mendil --restart unless-stopped --shm-size 256m \
  -e TS3CLIENT_LICENSE=accept \
  -e TS3_HOST=ts.example.com \
  -e TS3_SERVER_PASSWORD= \
  -v mendil-data:/home/node/.ts3client \
  -v mendil-client:/opt/ts3client \
  ghcr.io/ulaski/mendil:latest
```

Add `--platform linux/amd64` on an ARM machine.
</details>

<details>
<summary>From source</summary>

```bash
git clone https://github.com/ulaski/mendil.git
cd mendil
cp .env.example .env   # then edit it
docker compose up -d --build
```
</details>

> **Note:** the prebuilt image `ghcr.io/ulaski/mendil` is published with the first release. Until then, use "From source".

### Where is your TeamSpeak server?

| Setup | What to do |
|---|---|
| Another machine, or hosted by a provider | Set `TS3_HOST` to its address. Done. |
| Same host, **in Docker** | Copy [`examples/existing-docker-server/docker-compose.override.yml`](examples/existing-docker-server/docker-compose.override.yml) next to `docker-compose.yml`, adjust the network name, and set `TS3_HOST` to the server's service name (e.g. `teamspeak`). |
| Same host, **not in Docker** | Set `TS3_HOST=host.docker.internal` and add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service. |
| No server yet | [`examples/with-ts3-server`](examples/with-ts3-server/docker-compose.yml) starts a TeamSpeak server and Mendil together. |

### Recommended server settings

- **Channel codec:** set Mendil's channel to **Opus Music** with quality **10** (*Edit Channel → Audio*). The default *Opus Voice* codec makes music sound bad.
- **Talk power:** if the channel requires talk power, give Mendil's server group enough.

Mendil checks both when it joins a channel and posts a short hint if something is off (once per channel; `CHANNEL_HINTS=false` turns that off).
- **Anti-flood:** long queue listings send a few messages in a row. If Mendil gets flood-blocked, add it to a group with `b_client_ignore_antiflood`.
- **Permanent server group:** Mendil keeps its identity across restarts (stored in the `ts3client-data` volume), so any server group you give it sticks.

## Commands

Mendil reads its own channel's chat and private messages sent to it. In private chat the `!` prefix is optional.

| Command | Aliases | Description |
|---|---|---|
| `!play <link \| search>` | `!p` | Play now, or add to the end of the queue. Accepts a YouTube link, a playlist or search terms. |
| `!playnext <link \| search>` | `!pn` | Add to the front of the queue |
| `!search <search>` | `!find` | Show the top 5 YouTube results |
| `!pick <number>` | | Queue a result from `!search` |
| `!skip` | `!s`, `!next` | Skip the current track |
| `!pause` / `!resume` | `!unpause` | Pause / resume |
| `!stop` | | Stop and clear the queue |
| `!np` | `!now`, `!nowplaying` | Show the current track and its progress |
| `!queue` | `!q`, `!list` | Show the queue |
| `!remove <number>` | `!rm` | Remove a track from the queue |
| `!clear` | | Clear the queue (the current track keeps playing) |
| `!shuffle` | | Shuffle the queue |
| `!loop [off\|one\|all]` | `!repeat` | Loop nothing, the current track, or the whole queue |
| `!vol [0-100]` | `!volume`, `!v` | Show or set the volume |
| `!join` | `!come` | Move the bot to your channel. From another channel, send it as a private message. |
| `!whoami` | `!me`, `!id` | Show your unique ID and server groups, for `ALLOWED_UIDS` / `ALLOWED_GROUPS` |
| `!help` | `!h`, `!commands` | List commands |

With `BOT_LANGUAGE=tr`, Turkish aliases also work, e.g. `!çal`, `!geç`, `!ses`, `!gel`.

## Configuration

All settings are environment variables, usually set in `.env`.

| Variable | Default | Description |
|---|---|---|
| `TS3CLIENT_LICENSE` | *(required)* | Set to `accept` to accept the [TeamSpeak client license](https://www.teamspeak.com/en/privacy-and-terms/). The client is downloaded on first start. |
| `TS3_HOST` | *(required)* | Server address: host name, IP or `host:port` |
| `TS3_PORT` | `9987` | Voice port |
| `TS3_SERVER_PASSWORD` | | Server password |
| `TS3_CHANNEL` | | Channel to join, by name or path (`Games/Music`). Empty means the default channel. |
| `TS3_CHANNEL_PASSWORD` | | Channel password |
| `BOT_NICKNAME` | `Mendil` | Nickname |
| `BOT_LANGUAGE` | `en` | Chat language: `en`, `tr` |
| `COMMAND_PREFIX` | `!` | Command prefix |
| `ALLOWED_UIDS` | | Comma-separated TS3 unique IDs allowed to control the bot. `!whoami` shows yours. |
| `ALLOWED_GROUPS` | | Comma-separated server group IDs allowed to control the bot. If both lists are empty, everyone can; `!help` and `!whoami` always work. |
| `CHANNEL_HINTS` | `true` | Post a hint when the channel's codec or talk power is wrong for music |
| `ANNOUNCE_TRACKS` | `true` | Post "Now playing" messages |
| `DEFAULT_VOLUME` | `70` | Start-up volume, 0–100 |
| `NORMALIZE_AUDIO` | `true` | Loudness-normalise tracks to -16 LUFS |
| `MAX_QUEUE` | `100` | Max queue length |
| `MAX_PLAYLIST_ITEMS` | `50` | Max tracks taken from one playlist |
| `MAX_TRACK_DURATION` | `0` | Max track length in seconds. `0` means unlimited. |
| `PREFETCH` | `true` | Download tracks before playing them (no gaps, robust against network hiccups). `false` streams everything. |
| `PREFETCH_MAX_DURATION` | `1800` | Longer tracks (in seconds) and live streams are streamed instead of downloaded |
| `YTDLP_AUTO_UPDATE` | `true` | Keep yt-dlp up to date in the background (daily, and when YouTube extraction breaks). A new version that fails a self-test is rolled back. |
| `YTDLP_COOKIES_FILE` | | Cookies file for YouTube, see [docs/youtube.md](docs/youtube.md) |
| `YTDLP_PROXY` | | Proxy for YouTube traffic only, e.g. `socks5://user:pass@host:1080` |
| `TS3_CLIENT_VERSION` | `3.6.2` | TeamSpeak client version to download |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

## Updating

```bash
docker compose pull && docker compose up -d
# from source: git pull && docker compose up -d --build
```

yt-dlp also updates itself in the background, daily and whenever YouTube extraction starts failing, so most YouTube changes need no action.

The queue survives updates and restarts. It is stored with the bot's identity in the `ts3client-data` volume.

## Troubleshooting

**Mendil doesn't connect / "the server refused the connection"**
The TeamSpeak 3 client reports every refusal the same way, without a reason. The usual causes, most likely first:
1. a wrong or missing `TS3_SERVER_PASSWORD`;
2. a ban on the bot's identity, IP or nickname;
3. the server is full;
4. the server requires an identity security level above 8.

If Mendil gets kicked or banned while connected, the log says so, with who did it. Run with `LOG_LEVEL=debug` for more detail. The TeamSpeak client's own log is here:
`docker compose exec mendil sh -c 'tail -50 $(ls -t ~/.ts3client/logs/*.log | head -1)'`

**Mendil joins but nobody hears anything**
Check for a hint from Mendil in the channel chat (talk power, codec), and that it isn't muted by the server. `!np` shows whether something is actually playing.

**"Sign in to confirm you're not a bot"**
YouTube sometimes blocks data-center IPs. Fix it with cookies from a throwaway YouTube account or with a proxy (`YTDLP_PROXY`). Step-by-step instructions are in **[docs/youtube.md](docs/youtube.md)**. Mendil links to that page in chat when it detects the block.

**Music sounds bad**
The channel codec is almost always the cause. Use Opus Music at quality 10.

**Container is "unhealthy"**
The health check passes while Mendil is connected to the server. `docker compose exec mendil cat /tmp/mendil-health.json` shows the details, and the logs say why it isn't connected. Mendil retries on its own: within seconds after a disconnect, 45 s after a kick, and after a ban has expired. If it can't connect for 20 minutes, it restarts itself.

**Playback stopped with "tracks keep failing"**
After 3 failed tracks in a row, or right away when YouTube blocks the bot, Mendil stops instead of skipping through the whole queue. Fix the cause (see the YouTube note above), then type `!resume`.

**Resource usage**
Every 10 minutes the log has a `stats:` line with CPU and memory per process and the gap/load times of recent tracks.

## FAQ

**Why a full TeamSpeak client instead of a lightweight protocol library?**
The official client is guaranteed to speak exactly what servers expect, and it's the most reliable way to get going. It costs some memory and only runs on x86_64. A lighter engine based on an open-source protocol implementation is on the roadmap. It would also bring ARM support and a desktop app.

**Can I run several bots?**
Yes. Run one container per bot, each with its own volumes and nickname. Use a separate compose project (`docker compose -p mendil2 …`) or directory for each.

**Does it work with TeamSpeak 6 servers?**
Yes. Mendil connects to TS6 servers the way any TeamSpeak 3 client does. Tested with TS6 server 6.0.0-beta13.1: commands, announcements and audio all work.

**TeamSpeak 3 reaches end-of-life at the end of 2027. What happens then?**
TeamSpeak has announced that TS3 reaches end-of-life at the end of 2027, but hasn't said what that means for TS3 clients on TS6 servers. Native TS6 support is on Mendil's roadmap so that it keeps working either way.

**Spotify / SoundCloud?**
yt-dlp supports SoundCloud and many other sites, and direct links usually work. Spotify doesn't serve audio to third parties.

## Development

```bash
npm test     # unit tests (Node.js 22+, no Docker needed)
```

The controller has no npm dependencies; it uses only the Node.js standard library.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the end-to-end setup.

```
docker/entrypoint.sh        downloads the TS3 client, starts Xvfb + PulseAudio, runs the bot
src/index.js                entry point, signal handling
src/bot.js                  connection management, watchdog, health, chat → commands
src/reconnect.js            reconnect policy (backoff, kicks, bans), unit-tested with a fake clock
src/commands.js             chat commands
src/player.js               queue and playback (file or yt-dlp stream → ffmpeg → PulseAudio)
src/prefetch.js             downloads upcoming tracks and measures their loudness
src/state.js                saves/restores the queue across restarts
src/stats.js                periodic CPU/memory/timing log line
src/ytdlp.js                resolves links, playlists and searches
src/ytdlp-update.js         background yt-dlp updates with self-test and rollback
src/i18n/                   chat messages per language
src/ts3/client-process.js   runs the TS3 client and pre-configures settings.db
src/ts3/clientquery.js      ClientQuery (telnet) client
src/ts3/protocol.js         TS3 query escaping/parsing
```

## Legal

This project is not affiliated with or endorsed by TeamSpeak Systems GmbH. *TeamSpeak* is their trademark.

The TeamSpeak client is proprietary and is **not** included in this repository or its Docker image. It is downloaded from TeamSpeak's servers when the container first starts, and only after you set `TS3CLIENT_LICENSE=accept`. Doing so means you accept [TeamSpeak's license terms](https://www.teamspeak.com/en/privacy-and-terms/).

You are responsible for having the right to play the content you stream, and for complying with the terms of the sites you stream from.

## License

Copyright (C) 2026 ulaski

This program is free software: you can redistribute it and/or modify it under the terms of the
[GNU General Public License](LICENSE) as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version. It comes with ABSOLUTELY NO WARRANTY.
