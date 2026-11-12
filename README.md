<div align="center">

# 🧻 Mendil

**Song requests for your TeamSpeak server.**

Write a song in chat and Mendil plays it in your channel.

[![CI](https://github.com/ulaski/mendil/actions/workflows/ci.yml/badge.svg)](https://github.com/ulaski/mendil/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)
[![TeamSpeak 3](https://img.shields.io/badge/TeamSpeak-3-2580c3.svg)](#requirements)

</div>

```
<you>     !play daft punk around the world
Mendil    ▶ Now playing: Daft Punk - Around The World (4:02) — requested by you
```

### Why "Mendil"?

In Turkey, people at a *gazino* or *meyhane* used to write their song request on a *mendil*, a napkin, and pass it up to the musicians on stage. Mendil does the same for your TeamSpeak server. Write your request in chat and the band plays it. *(Pronounced men-DEEL.)*

## Features

- 🎵 **Plays anything on YouTube:** a link, a whole playlist, or just search terms
- 📝 **A real queue:** search & pick, play next, skip, pause, loop, shuffle and volume
- 🔊 **Consistent loudness** between tracks, so nobody has to ride the volume
- 🐳 **One container, two settings:** accept the TeamSpeak license, point it at your server, done
- 🩹 **Recovers on its own** from crashes, kicks and server restarts
- 🌍 **Speaks your language:** English and Turkish built in, and [adding a language](CONTRIBUTING.md#adding-a-language) means translating one file
- 🪶 **No npm dependencies:** the controller uses only the Node.js standard library

## How it works

A bot can only send voice to a TeamSpeak server by connecting as a real client; ServerQuery can't send audio. Mendil runs the **official TeamSpeak 3 Linux client** headless and remote-controls it:

```
TeamSpeak chat ──► TS3 client ◄── ClientQuery (127.0.0.1:25639) ──► Node.js controller
                       ▲                                                 │
                       │ microphone = PulseAudio monitor                 │ yt-dlp | ffmpeg
                       └────────────── virtual sound card ◄──────────────┘
```

- **Xvfb** provides a virtual screen and **PulseAudio** a virtual sound card.
- **yt-dlp** fetches the audio and **ffmpeg** plays it into the virtual card. The TeamSpeak client uses that card as its microphone.
- The controller reads chat through the client's **ClientQuery** plugin, replies, and only transmits while music is playing.
- On first start, the license dialog, intro wizard and audio settings are pre-configured, so nobody needs to click through the GUI.

## Requirements

- Docker with Docker Compose
- An **x86_64 (amd64)** host. The official TS3 client only exists for x86_64. ARM machines (Raspberry Pi, Apple Silicon) can run it under emulation, but it's slow.
- About 300 MB of RAM per bot
- Internet access on first start, to download the TeamSpeak client

## Quick start

```bash
git clone https://github.com/ulaski/mendil.git
cd mendil
cp .env.example .env
```

Edit `.env` and set at least:

```ini
TS3CLIENT_LICENSE=accept      # accepts the TeamSpeak client license, see "Legal" below
TS3_HOST=ts.example.com       # your server
TS3_SERVER_PASSWORD=          # if your server has one
```

Then start it:

```bash
docker compose up -d --build
docker compose logs -f
```

The first start downloads the TeamSpeak client (~110 MB). Once you see `connected to server`, join Mendil's channel and type `!help`.

> **Prebuilt image:** after a release is published you can skip `--build`. Run `docker compose pull`, which fetches `ghcr.io/ulaski/mendil`.

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
| `!join` | `!come` | Move the bot to your channel |
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
| `ALLOWED_UIDS` | | Comma-separated TS3 unique IDs allowed to control the bot. Empty means everyone. |
| `ANNOUNCE_TRACKS` | `true` | Post "Now playing" messages |
| `DEFAULT_VOLUME` | `70` | Start-up volume, 0–100 |
| `NORMALIZE_AUDIO` | `true` | Loudness-normalise tracks (ffmpeg `loudnorm`) |
| `MAX_QUEUE` | `100` | Max queue length |
| `MAX_PLAYLIST_ITEMS` | `50` | Max tracks taken from one playlist |
| `MAX_TRACK_DURATION` | `0` | Max track length in seconds. `0` means unlimited. |
| `YTDLP_AUTO_UPDATE` | `true` | Update yt-dlp on every container start |
| `YTDLP_COOKIES_FILE` | | Cookies file for YouTube (see Troubleshooting) |
| `TS3_CLIENT_VERSION` | `3.6.2` | TeamSpeak client version to download |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

## Updating

```bash
git pull
docker compose up -d --build     # or: docker compose pull && docker compose up -d
```

yt-dlp updates itself on every start, so a `docker compose restart` is often enough when YouTube changes something.

## Troubleshooting

**Mendil doesn't connect / "the server refused the connection"**
TeamSpeak rejects a wrong or missing server password without an error message. Check `TS3_SERVER_PASSWORD` first, then bans and max clients. Run with `LOG_LEVEL=debug` for more detail. The TeamSpeak client's own log is here:
`docker compose exec mendil sh -c 'tail -50 $(ls -t ~/.ts3client/logs/*.log | head -1)'`

**Mendil joins but nobody hears anything**
Check the channel codec (Opus Music), Mendil's talk power, and that it isn't muted by the server. `!np` shows whether something is actually playing.

**"Sign in to confirm you're not a bot"**
YouTube sometimes blocks data-center IPs. Fix it like this:
1. Export a YouTube cookies file from a browser in Netscape format. Use a throwaway account.
2. Put it in `./cookies/cookies.txt`.
3. Uncomment the cookies volume in `docker-compose.yml`.
4. Set `YTDLP_COOKIES_FILE=/cookies/cookies.txt`.

**Music sounds bad**
The channel codec is almost always the cause. Use Opus Music at quality 10.

**Container is "unhealthy"**
The health check passes while Mendil is connected to the server. Check the logs. Mendil retries with backoff, up to every 5 minutes.

## FAQ

**Why a full TeamSpeak client instead of a lightweight protocol library?**
The TS3 voice protocol is proprietary and complex. The open-source re-implementations are mostly unmaintained. The official client always matches what servers expect, and this project hides the GUI parts.

**Can I run several bots?**
Yes. Run one container per bot, each with its own volumes and nickname. Use a separate compose project (`docker compose -p mendil2 …`) or directory for each.

**Does it work with TeamSpeak 5/6 servers?**
It's tested with TeamSpeak 3 servers. Newer servers that still accept TS3 clients should work.

**Spotify / SoundCloud?**
yt-dlp supports SoundCloud and many other sites, and direct links usually work. Spotify doesn't serve audio to third parties.

## Development

```bash
npm test     # unit tests (Node.js 22+, no Docker needed)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the end-to-end setup.

```
docker/entrypoint.sh        downloads the TS3 client, starts Xvfb + PulseAudio, runs the bot
src/index.js                entry point, signal handling
src/bot.js                  connection management, watchdog, chat → commands
src/commands.js             chat commands
src/player.js               queue and playback (yt-dlp | ffmpeg → PulseAudio)
src/ytdlp.js                resolves links, playlists and searches
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
