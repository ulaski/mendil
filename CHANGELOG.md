# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Radio.** `RADIO_STATIONS` lists internet radio stations and `RADIO` picks one. The radio plays whenever the queue is empty; a request interrupts it, and it comes back once the queue runs out. `!radio` shows the stations, admins switch with `!radio <name or address>` or `!radio off`, and the web panel has a station picker. The station's current song (ICY metadata) shows in `!np` and in the panel. Icecast/SHOUTcast MP3, AAC and Ogg streams, HLS, and `.pls` / `.m3u` links work.
- **Pause when alone** (`PAUSE_WHEN_ALONE`, on by default). When nobody else has been in the channel for 30 seconds, Mendil pauses and stops transmitting, and it carries on when someone joins. The panel's lamp says NO LISTENERS meanwhile.

## [0.4.0] - 2026-11-13

Spotify links.

### Added
- **Spotify links.** `!play` and the panel take Spotify song, album and playlist links (also `spotify.link` short links). Mendil reads the song list from Spotify's public embed page, without an account or API key, and plays each song from YouTube, choosing the result whose length matches Spotify's. Songs are looked up just before they play, the next one ahead of time, so a playlist joins the queue at once and songs still follow each other without a gap.

## [0.3.0] - 2026-11-13

Roles for admins and listeners, web panel sign-in with TeamSpeak, and a smaller native image.

### Added
- **Roles.** `ADMIN_UIDS` / `ADMIN_GROUPS` name the admins; everyone else is a listener. Listeners can request and search songs, see the queue, and skip or remove the songs they requested. Pause, stop, volume, loop, shuffle, clear, play-next, `!join` and other people's songs are for admins. Without admin lists, everyone stays an admin as before. `!help` lists only what you may use, and `!whoami` shows your role.
- **Web panel sign-in with TeamSpeak.** Type your nickname, get a one-time code from Mendil in a private message, and the panel knows who you are: your role matches chat, and your requests carry your name. The panel password still works and always signs you in as an admin. Listeners don't see the log.

### Changed
- The native image uses a static ffmpeg build ([wader/static-ffmpeg](https://github.com/wader/static-ffmpeg), pinned by digest) instead of Debian's, which brought ~400 MB of shared libraries with it. The image shrinks from 284 MB to 185 MB compressed (1.12 GB to 740 MB unpacked). The classic image keeps Debian's ffmpeg, because it plays into PulseAudio.
- Panel sessions from 0.2.0 end after the update, because the session cookie changed: sign in again once.

### Fixed
- The native engine's "from source" instructions built an untagged image, so Compose pulled the published one instead; the README now adds a `build` section. `.env.example` no longer sets `VOICE_BACKEND`, which had overridden the native image's engine.

## [0.2.0] - 2026-11-13

A web panel, and a second, experimental voice engine that works without the TeamSpeak client.

### Added
- **Web panel** on port 8080, laid out like a radio station's running order:
  - The current track sits under an ON AIR lamp, with the time left.
  - Every queued song shows when it will air, and the panel shows when the queue ends.
  - From the panel you can pause, skip, stop, change the volume and the loop mode, request songs by link or search, remove, shuffle and clear the queue, and read the live log.
  - It works on phones, in light and dark mode, and in English and Turkish.
  - It is protected by a password (`PANEL_PASSWORD`, or generated on first start). `PANEL_TRUST_PROXY` is for running it behind a reverse proxy. See README "Web panel".
- **Native engine (experimental):** `VOICE_BACKEND=native` connects to TeamSpeak without the official client, through [teamspeak-js](https://github.com/HoneyBBQ/teamspeak-js). It runs on x86_64 and ARM64 (`ghcr.io/ulaski/mendil:native`), uses about a quarter of the memory, plays music in stereo in any channel (no Opus Music codec needed), and logs why a server refused it (wrong password, ban, security level). It raises its identity's security level when a server asks for more. Classic stays the default.
- `NATIVE_BITRATE` sets the native engine's Opus bitrate.
- CI tests the native engine end to end against TeamSpeak 3 and TeamSpeak 6 servers.

### Changed
- `!search` only lists playable tracks, not channels or playlists.
- The controller is split into an engine-agnostic bot and two voice engines (`src/voice/`). Classic behaves as before.

## [0.1.1] - 2026-11-13

Security release. Everyone running 0.1.0 should update.

### Security
- A crafted playlist or feed could make yt-dlp run a command inside the container: an entry whose "URL" was really a yt-dlp option was passed on unchecked. Entries must now be http(s) URLs, and every yt-dlp call ends its options with `--`.
- `!play` no longer opens addresses on private networks (localhost, LAN, cloud metadata). `ALLOW_PRIVATE_URLS=true` allows them again.
- Passwords and API keys are masked in the debug log.
- Links in chat messages are encoded so a crafted URL can't inject BBCode.
- The TeamSpeak client download is checked against TeamSpeak's published SHA-256 (`TS3_CLIENT_SHA256` for other versions).

### Changed
- Each user can start a few searches or `!play` lookups at once, then one every few seconds.
- A track that keeps playing far past its stated length is stopped, and `MAX_TRACK_DURATION` now applies to live streams too.
- Streamed tracks get the same 200 MB download limit as downloaded ones, and downloads are stopped at 200 MB even when the server doesn't announce the size.

### Fixed
- After `!join`, the bot no longer assumes the move worked before the server confirms it.

## [0.1.0] - 2026-11-13

First public version of 🧻 Mendil.

### Playback
- YouTube links, playlists and search terms, via yt-dlp and ffmpeg.
- Chat commands: play, playnext, search/pick, skip, stop, pause/resume, now playing, queue, remove, clear, shuffle, loop, volume, join, whoami and help.
- Tracks are downloaded before they play, and the next one is fetched while the current one plays. Songs follow each other with a gap of about 0.2 s. Live streams and tracks over 30 minutes (`PREFETCH_MAX_DURATION`) are streamed instead. `PREFETCH=false` streams everything.
- Consistent loudness: each track is measured once and played at a fixed gain with a limiter.
- The queue, the current position, the loop mode and the volume survive restarts, crashes and updates. Playback resumes a few seconds before where it stopped.
- When tracks keep failing, playback stops and the queue is kept. `!resume` or a new `!play` retries.

### TeamSpeak
- Works with TeamSpeak 3 and TeamSpeak 6 servers (tested with 3.13 and 6.0.0-beta13.1).
- It runs the official TeamSpeak 3 client headless (Xvfb + PulseAudio) and controls it through the ClientQuery plugin. The client is downloaded on first start once you accept its license (`TS3CLIENT_LICENSE=accept`).
- Recovers on its own:
  - A lost connection is retried within seconds, then with backoff.
  - After a kick it waits 45 s; after a ban it waits until the ban ends.
  - A stuck or crashed client is restarted.
  - The container restarts when nothing else helps.
- Channel self-check: Mendil posts a short hint when the channel's codec or talk power is wrong for music (`CHANNEL_HINTS`).
- Access control by unique ID (`ALLOWED_UIDS`) or server group (`ALLOWED_GROUPS`). `!whoami` shows both.
- Outgoing messages are paced to stay clear of anti-flood limits. If a block happens anyway, Mendil names the permission that fixes it.

### YouTube
- YouTube blocks are recognised: Mendil explains them in chat and links to [docs/youtube.md](docs/youtube.md) (cookies, proxy).
- `YTDLP_PROXY` routes YouTube traffic through a proxy.
- yt-dlp updates in the background (daily, and when extraction breaks). A new version that fails a self-test is rolled back.

### Running it
- One Docker image (`ghcr.io/ulaski/mendil`), a quick start without cloning the repo, and a single `docker run` alternative.
- The Docker health check turns unhealthy while Mendil is disconnected.
- A `stats:` log line every 10 minutes, and `/tmp/mendil-health.json` with connection details.
- English and Turkish chat messages (`BOT_LANGUAGE`). Adding a language means translating one file.

[Unreleased]: https://github.com/ulaski/mendil/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/ulaski/mendil/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ulaski/mendil/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ulaski/mendil/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/ulaski/mendil/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ulaski/mendil/releases/tag/v0.1.0
