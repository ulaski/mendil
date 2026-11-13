---
title: "How it works"
description: "The two voice engines, how audio gets into TeamSpeak, and where things live in the code."
---

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

## Classic

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

## Native

Mendil connects to the server itself. ffmpeg encodes the music as Opus (the codec TeamSpeak uses), and Mendil sends it as voice packets, 50 per second. There is no TeamSpeak client, X server or sound card involved, which is why it is lighter and runs on any CPU. It keeps its own identity in the data volume, separate from Classic's, so a server group you gave the Classic bot has to be given again after switching.

## Source tree

```bash
npm ci       # the native engine's one dependency
npm test     # unit tests (Node.js 22.12+, no Docker needed)
TS_HOST=127.0.0.1 TS_PORT=9987 node test/e2e/native-e2e.mjs   # against a running TS3/TS6 server
```

The Classic engine and the rest of the controller use only the Node.js standard library. The native engine uses one dependency, [teamspeak-js](https://github.com/HoneyBBQ/teamspeak-js) (MIT), pinned to an exact version.

See [CONTRIBUTING.md](../../project/contributing/) for the end-to-end setup.

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
