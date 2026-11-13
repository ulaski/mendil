---
title: "Configuration"
description: "Every setting, its default, and what it does."
---

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
| `ADMIN_UIDS` | | Comma-separated TeamSpeak unique IDs of [admins](../../guides/roles/). `!whoami` shows yours. |
| `ADMIN_GROUPS` | | Comma-separated server group IDs of admins. If both admin lists are empty, everyone who may use the bot is an admin. |
| `ALLOWED_UIDS` | | Comma-separated unique IDs allowed to use the bot at all. |
| `ALLOWED_GROUPS` | | Comma-separated server group IDs allowed to use the bot at all. If both lists are empty, everyone can; `!help` and `!whoami` always work, and admins are always allowed. |
| `CHANNEL_HINTS` | `true` | Post a hint when the channel's codec or talk power is wrong for music |
| `ANNOUNCE_TRACKS` | `true` | Post "Now playing" messages |
| `PAUSE_WHEN_ALONE` | `true` | Pause while nobody else is in the bot's channel ([details](../../guides/radio/#when-nobody-is-listening)) |
| `RADIO_STATIONS` | | Radio stations, as `name=stream address` separated by commas ([Radio](../../guides/radio/)) |
| `RADIO` | | Station name or stream address that plays whenever the queue is empty, from the first start |
| `DEFAULT_VOLUME` | `70` | Start-up volume, 0 to 100 |
| `NORMALIZE_AUDIO` | `true` | Loudness-normalise tracks to -16 LUFS |
| `MAX_QUEUE` | `100` | Max queue length |
| `MAX_PLAYLIST_ITEMS` | `50` | Max tracks taken from one playlist |
| `MAX_QUEUE_PER_USER` | `0` | Songs one person may have waiting in the queue; `0` means no limit. Named [admins](../../guides/roles/) are exempt. A playlist adds only as many songs as fit. |
| `MAX_TRACK_DURATION` | `0` | Max track length in seconds, live streams included. `0` means unlimited. |
| `PREFETCH` | `true` | Download tracks before playing them, so there are no gaps and network hiccups don't matter. `false` streams everything. |
| `PREFETCH_MAX_DURATION` | `1800` | Longer tracks (in seconds) and live streams are streamed instead of downloaded |
| `YTDLP_AUTO_UPDATE` | `true` | Keep yt-dlp up to date in the background (daily, and when YouTube extraction breaks). A new version that fails a self-test is rolled back. |
| `YTDLP_COOKIES_FILE` | | Cookies file for YouTube, see [YouTube blocks](../../guides/youtube/) |
| `YTDLP_PROXY` | | Proxy for YouTube traffic only, e.g. `socks5://user:pass@host:1080` |
| `ALLOW_PRIVATE_URLS` | `false` | Let `!play` open addresses on private networks (LAN, localhost), e.g. a media server at home. Off by default, see [SECURITY.md](https://github.com/ulaski/mendil/blob/main/SECURITY.md). |
| `VOICE_BACKEND` | per image | `classic` (official TeamSpeak client) or `native`, see [How it works](../../project/how-it-works/). Each image sets its own; only set this to run the native engine inside the classic image. |
| `NATIVE_BITRATE` | `128` | Native engine only: Opus bitrate in kbit/s, 48 to 192 |
| `PANEL_PORT` | `8080` | Port of the web panel inside the container. `0` turns it off. |
| `PANEL_HOST` | `0.0.0.0` | Address the panel listens on inside the container. Keep the default in Docker and limit access with the published port instead. |
| `PANEL_TRUST_PROXY` | `false` | Set to `true` when the panel is behind a reverse proxy, so the login limit applies per client instead of to the proxy |
| `PANEL_PASSWORD` | | Admin password for the web panel. If empty, one is generated on first start and printed in the log. Everyone else signs in with their TeamSpeak nickname. |
| `TS3_CLIENT_VERSION` | `3.6.2` | TeamSpeak client version to download |
| `TS3_CLIENT_SHA256` | | Expected SHA-256 of that download. Known for 3.6.2; set it if you change the version. |
| `PUID` / `PGID` | `1000` | User and group IDs to run as when the container is started as root (`--user 0`), for example `99` / `100` on Unraid. Mendil hands its data folders to that user and never runs as root itself. Without `--user 0` they have no effect. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
