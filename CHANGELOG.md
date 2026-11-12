# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security
- A crafted playlist or feed could make yt-dlp run a command inside the container: an entry whose "URL" was really a yt-dlp option was passed on unchecked. Entries must now be http(s) URLs, and every yt-dlp call ends its options with `--`. Please update.
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

[Unreleased]: https://github.com/ulaski/mendil/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ulaski/mendil/releases/tag/v0.1.0
