<div align="center">

<img src="docs/assets/logo.png" alt="Mendil logo: a napkin wearing headphones" width="160">

# Mendil

**Song requests for your TeamSpeak server.**

Write a song in chat and Mendil plays it in your channel.

[![CI](https://github.com/ulaski/mendil/actions/workflows/ci.yml/badge.svg)](https://github.com/ulaski/mendil/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)
[![TeamSpeak 3 & 6](https://img.shields.io/badge/TeamSpeak-3%20%26%206-2580c3.svg)](#requirements)

</div>

```
<you>     !play fontaines dc mimesis
Mendil    ▶ Now playing: Fontaines D.C. - Mimesis (3:52) — requested by you
```

### Why "Mendil"?

In Türkiye, people at a *gazino* or *meyhane* used to write their song request on a *mendil*, a napkin, and pass it up to the musicians on stage. Mendil does the same for your TeamSpeak server. Write your request in chat and the band plays it. *(Pronounced men-DEEL.)*

## Features

- 🎵 Plays YouTube links, whole playlists, or the first result for a search
- 📝 Has a proper queue: search and pick, play next, skip, pause, loop, shuffle and volume
- 🔊 Keeps every track at the same loudness, so nobody has to ride the volume
- 🐳 Runs as one container. You accept the TeamSpeak license and give it your server's address.
- ⏭️ Downloads the next track while the current one plays, so songs follow each other without a gap
- 🩹 Gets back on its feet after crashes, kicks, bans and server restarts, and after a restart it continues the song where it stopped
- 🌍 Speaks English and Turkish. [Adding a language](CONTRIBUTING.md#adding-a-language) means translating one file.
- 🩺 Tells you when a channel setting makes music sound bad or keeps it from being heard, and explains YouTube blocks
- 🔐 Can be limited to certain people, by TeamSpeak unique ID or server group
- 🖥️ Has a web panel: see what's playing, manage the queue and add songs from your browser or phone
- 🧪 Comes with two voice engines: the official TeamSpeak client, or an experimental native engine that also runs on ARM and plays music in any channel

## How it works

ServerQuery can't send audio, so a bot has to connect to TeamSpeak as a real client. Mendil can do that in two ways:

| | Classic (default) | Native (experimental) |
|---|---|---|
| How | Runs the official TeamSpeak 3 client without a screen and controls it | Speaks the TeamSpeak protocol itself, through the open-source [teamspeak-js](https://github.com/HoneyBBQ/teamspeak-js) library |
| Image | `ghcr.io/ulaski/mendil:latest` | `ghcr.io/ulaski/mendil:native` |
| CPU | x86_64 only (ARM via slow emulation) | x86_64 and ARM64 (e.g. Raspberry Pi) |
| Memory | about 300 MB | about 80 MB |
| Download size | about 310 MB, plus the TeamSpeak client (~110 MB) on first start | about 185 MB |
| Channel codec | needs Opus Music for good sound | plays in stereo in any channel |
| Why a connection was refused | not reported by the client | logged (wrong password, ban, security level…) |
| TeamSpeak 6 servers | works (TS3 client on a TS6 server) | works |

Classic is the safe choice: it is TeamSpeak's own client. Native is newer and lighter. It is not made or endorsed by TeamSpeak, and the library behind it is young, so treat it as experimental. You switch with one setting, `VOICE_BACKEND`, and can switch back any time.

### Classic

Mendil runs the official TeamSpeak 3 Linux client without a screen and controls it remotely:

```
TeamSpeak chat ──► TS3 client ◄── ClientQuery (127.0.0.1:25639) ──► Node.js controller
                       ▲                                                 │
                       │ microphone = PulseAudio monitor                 │ yt-dlp | ffmpeg
                       └────────────── virtual sound card ◄──────────────┘
```

- Xvfb provides a virtual screen and PulseAudio a virtual sound card.
- yt-dlp downloads the audio, fetching the next track while the current one plays. ffmpeg plays it into the virtual card at a loudness measured once per track, and the TeamSpeak client uses that card as its microphone. Live streams and very long tracks are streamed instead of downloaded.
- The queue, the current position, the loop mode and the volume are saved, so a restart or an update continues where it stopped.
- The controller reads chat through the client's ClientQuery plugin, answers there, and only transmits while music is playing.
- Mendil fills in the license dialog, the intro wizard and the audio settings before the client first starts, so nobody has to click through the client's windows.

### Native

Mendil connects to the server itself. ffmpeg encodes the music as Opus (the codec TeamSpeak uses), and Mendil sends it as voice packets, 50 per second. There is no TeamSpeak client, X server or sound card involved, which is why it is lighter and runs on any CPU. It keeps its own identity in the data volume, separate from Classic's, so a server group you gave the Classic bot has to be given again after switching.

## Requirements

- A TeamSpeak 3 or TeamSpeak 6 server. Tested with TS3 server 3.13.9 and TS6 server 6.0.0-beta13.1.
- Docker with Docker Compose
- For Classic: an x86_64 (amd64) host, because the official TS3 client only exists for x86_64. ARM machines such as a Raspberry Pi or a Mac with Apple Silicon can run it under emulation, but slowly. About 300 MB of RAM per bot, and internet access on first start to download the TeamSpeak client.
- For Native: any x86_64 or ARM64 host and about 100 MB of RAM per bot.

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

<details>
<summary>With the native engine</summary>

In `docker-compose.yml`, use the native image and drop what only Classic needs:

```yaml
services:
  mendil:
    image: ghcr.io/ulaski/mendil:native
    container_name: mendil
    restart: unless-stopped
    env_file: .env
    volumes:
      - ts3client-data:/home/node/.ts3client

volumes:
  ts3client-data:
```

`TS3CLIENT_LICENSE` isn't needed, because no TeamSpeak client is downloaded. Everything else in `.env` stays the same; if your `.env` sets `VOICE_BACKEND=classic`, remove that line.

From source, add a `build` section to the same service, so Compose builds the native image instead of downloading it:

```yaml
    build:
      context: .
      target: native
```

and start it with `docker compose up -d --build`.
</details>

### Web panel

Mendil also has a web panel on port 8080: what's playing, the queue, volume and loop, a box to request songs and search YouTube, and the live log. It works on phones too.

To open it, publish the port in `docker-compose.yml`:

```yaml
    ports:
      - "127.0.0.1:8080:8080"
```

Then open http://localhost:8080 on the machine that runs Mendil. The password is in the log on first start (`docker compose logs mendil | grep password`), or choose one with `PANEL_PASSWORD`.

On a server, keep the `127.0.0.1:` part and reach the panel through an SSH tunnel (`ssh -L 8080:localhost:8080 you@server`, then open http://localhost:8080), or put it behind a reverse proxy with HTTPS. Don't publish it to the internet over plain HTTP: the password would travel unencrypted. `PANEL_PORT=0` turns the panel off.

### Where is your TeamSpeak server?

| Setup | What to do |
|---|---|
| Another machine, or hosted by a provider | Set `TS3_HOST` to its address. Done. |
| Same host, **in Docker** | Copy [`examples/existing-docker-server/docker-compose.override.yml`](examples/existing-docker-server/docker-compose.override.yml) next to `docker-compose.yml`, adjust the network name, and set `TS3_HOST` to the server's service name (e.g. `teamspeak`). |
| Same host, **not in Docker** | Set `TS3_HOST=host.docker.internal` and add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service. |
| No server yet | [`examples/with-ts3-server`](examples/with-ts3-server/docker-compose.yml) starts a TeamSpeak server and Mendil together. |

### Recommended server settings

- Set Mendil's channel to the **Opus Music** codec with quality 10 (*Edit Channel → Audio*). The default *Opus Voice* codec makes music sound bad.
- If the channel requires talk power, give Mendil's server group enough of it.
- Long queue listings send a few messages in a row. If the server's anti-flood blocks Mendil, add it to a group with `b_client_ignore_antiflood`.
- Mendil keeps its identity across restarts in the `ts3client-data` volume, so a server group you give it stays.

Mendil checks the codec and talk power when it joins a channel and posts a short hint if something is off, once per channel. `CHANNEL_HINTS=false` turns this off.

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
| `DEFAULT_VOLUME` | `70` | Start-up volume, 0 to 100 |
| `NORMALIZE_AUDIO` | `true` | Loudness-normalise tracks to -16 LUFS |
| `MAX_QUEUE` | `100` | Max queue length |
| `MAX_PLAYLIST_ITEMS` | `50` | Max tracks taken from one playlist |
| `MAX_TRACK_DURATION` | `0` | Max track length in seconds, live streams included. `0` means unlimited. |
| `PREFETCH` | `true` | Download tracks before playing them, so there are no gaps and network hiccups don't matter. `false` streams everything. |
| `PREFETCH_MAX_DURATION` | `1800` | Longer tracks (in seconds) and live streams are streamed instead of downloaded |
| `YTDLP_AUTO_UPDATE` | `true` | Keep yt-dlp up to date in the background (daily, and when YouTube extraction breaks). A new version that fails a self-test is rolled back. |
| `YTDLP_COOKIES_FILE` | | Cookies file for YouTube, see [docs/youtube.md](docs/youtube.md) |
| `YTDLP_PROXY` | | Proxy for YouTube traffic only, e.g. `socks5://user:pass@host:1080` |
| `ALLOW_PRIVATE_URLS` | `false` | Let `!play` open addresses on private networks (LAN, localhost), e.g. a media server at home. Off by default, see [SECURITY.md](SECURITY.md). |
| `VOICE_BACKEND` | per image | `classic` (official TeamSpeak client) or `native`, see [How it works](#how-it-works). Each image sets its own; only set this to run the native engine inside the classic image. |
| `NATIVE_BITRATE` | `128` | Native engine only: Opus bitrate in kbit/s, 48 to 192 |
| `PANEL_PORT` | `8080` | Port of the web panel inside the container. `0` turns it off. |
| `PANEL_TRUST_PROXY` | `false` | Set to `true` when the panel is behind a reverse proxy, so the login limit applies per client instead of to the proxy |
| `PANEL_PASSWORD` | | Password for the web panel. If empty, one is generated on first start and printed in the log. |
| `TS3_CLIENT_VERSION` | `3.6.2` | TeamSpeak client version to download |
| `TS3_CLIENT_SHA256` | | Expected SHA-256 of that download. Known for 3.6.2; set it if you change the version. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

## Updating

```bash
docker compose pull && docker compose up -d
# from source: git pull && docker compose up -d --build
```

`latest` always points to the newest release. To stay on a version you've tested, use its tag instead, e.g. `image: ghcr.io/ulaski/mendil:0.2.0`.

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
YouTube sometimes blocks data-center IPs. Cookies from a throwaway YouTube account or a proxy (`YTDLP_PROXY`) fix it, and [docs/youtube.md](docs/youtube.md) explains both step by step. Mendil links to that page in chat when it detects the block.

**Music sounds bad**
The channel codec is almost always the cause. Use Opus Music at quality 10.

**Container is "unhealthy"**
The health check passes while Mendil is connected to the server. `docker compose exec mendil cat /tmp/mendil-health.json` shows the details, and the logs say why it isn't connected. Mendil retries on its own: within seconds after a disconnect, 45 s after a kick, and after a ban has expired. If it can't connect for 20 minutes, it restarts itself.

**Playback stopped with "tracks keep failing"**
After 3 failed tracks in a row, or right away when YouTube blocks the bot, Mendil stops instead of skipping through the whole queue. Fix the cause (see the YouTube note above), then type `!resume`.

**Resource usage**
Every 10 minutes the log has a `stats:` line with CPU and memory per process and the gap/load times of recent tracks.

## FAQ

**Classic or Native?**
Classic runs TeamSpeak's own client, which has spoken exactly what servers expect for years. Native is lighter, runs on ARM and doesn't care about the channel codec, but it uses an independent implementation of the TeamSpeak protocol that is younger and not endorsed by TeamSpeak. If Classic works for you, keep it. If you're on a Raspberry Pi, short on memory, or can't change the channel codec, try Native.

**Can I run several bots?**
Yes. Run one container per bot, each with its own volumes and nickname. Use a separate compose project (`docker compose -p mendil2 …`) or directory for each.

**Does it work with TeamSpeak 6 servers?**
Yes, with both engines. Tested with TS6 server 6.0.0-beta13.1: commands, announcements and audio all work, and CI tests the native engine against TS3 and TS6 servers on every change.

**TeamSpeak 3 reaches end-of-life at the end of 2027. What happens then?**
TeamSpeak has announced that TS3 reaches end-of-life at the end of 2027, but hasn't said what that means for TS3 clients on TS6 servers. If the TS3 client stops working with TS6 servers, the native engine doesn't depend on it.

**Spotify / SoundCloud?**
yt-dlp supports SoundCloud and many other sites, and direct links usually work. Spotify doesn't serve audio to third parties.

**Who can use the bot?**
By default everyone who can write to it, and `!play` takes links to any site yt-dlp supports. On a public server, limit it with `ALLOWED_UIDS` or `ALLOWED_GROUPS`. Each user can start a few searches at once and then one every few seconds, so one person can't keep the bot busy for everyone.

## Development

```bash
npm ci       # the native engine's one dependency
npm test     # unit tests (Node.js 22.12+, no Docker needed)
TS_HOST=127.0.0.1 TS_PORT=9987 node test/e2e/native-e2e.mjs   # against a running TS3/TS6 server
```

The Classic engine and the rest of the controller use only the Node.js standard library. The native engine uses one dependency, [teamspeak-js](https://github.com/HoneyBBQ/teamspeak-js) (MIT), pinned to an exact version.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the end-to-end setup.

```
docker/entrypoint.sh        downloads the TS3 client, starts Xvfb + PulseAudio, runs the bot
src/index.js                entry point, signal handling
src/bot.js                  chat → commands, access control, health, watchdog (engine-agnostic)
src/voice/classic.js        Classic engine: TS3 client process, ClientQuery, reconnects
src/voice/native.js         Native engine: teamspeak-js connection, reconnects, identity
src/voice/opus.js           Ogg/Opus demuxer and the 20 ms frame pacer (Native)
src/requests.js             song requests, shared by chat commands and the web panel
src/panel/                  web panel: HTTP API with server-sent events, and the page (public/)
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

The native engine uses [teamspeak-js](https://github.com/HoneyBBQ/teamspeak-js), an independent, open-source implementation of the TeamSpeak protocol that contains no TeamSpeak code. It is not made or endorsed by TeamSpeak either. Check that third-party clients are fine with the servers you connect to.

The TeamSpeak client is proprietary and is **not** included in this repository or its Docker image. It is downloaded from TeamSpeak's servers when the container first starts, and only after you set `TS3CLIENT_LICENSE=accept`. Doing so means you accept [TeamSpeak's license terms](https://www.teamspeak.com/en/privacy-and-terms/).

You are responsible for having the right to play the content you stream, and for complying with the terms of the sites you stream from.

## License

Copyright (C) 2026 ulaski

This program is free software: you can redistribute it and/or modify it under the terms of the
[GNU General Public License](LICENSE) as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version. It comes with ABSOLUTELY NO WARRANTY.
