# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Tracks are downloaded before they play, and the next track while the current one plays. The gap between songs dropped from seconds to about 0.2 s, and network hiccups mid-song no longer matter. Live streams and tracks over 30 minutes (`PREFETCH_MAX_DURATION`) are still streamed; `PREFETCH=false` streams everything.
- The queue, current position, loop mode and volume are saved, and restored after a restart, crash or update. Playback resumes a few seconds before where it stopped.
- Kicks and bans are recognised: Mendil waits 45 s after a kick and waits out a ban before reconnecting.
- A `stats:` log line every 10 minutes with CPU/memory per process and track gap/load times, and `/tmp/mendil-health.json` with connection details.
- yt-dlp updates in the background (daily, and when YouTube extraction breaks); a new version that fails a self-test is rolled back.


### Fixed
- Skipping or stopping a track no longer leaves a yt-dlp process and an ~85 MB temp directory behind. yt-dlp now runs in its own process group, which is stopped as a whole.
- A chat command could run twice when a watchdog run overlapped the next one. Stale ClientQuery connections are now closed and ignored.
- The container stayed up but silent when Xvfb or PulseAudio died. The bot now exits within one watchdog tick so Docker restarts it.
- The health check could report "healthy" right after a restart, before the bot had reconnected.
- PulseAudio ran at 44.1 kHz, so audio was resampled twice. Everything now runs at 48 kHz.

### Changed
- Loudness is measured once per downloaded track and applied as a fixed gain with a limiter, which uses about a tenth of the CPU of realtime `loudnorm`.
- Reconnecting: a lost connection is retried within seconds, then with backoff (5–60 s); the TeamSpeak client is only restarted when it is stuck. Playback pauses while disconnected and resumes afterwards. After 20 minutes without a connection the container restarts.
- Tracks that end early or stall are detected and retried once from where they stopped.
- Live streams no longer download video.
- At most 2 searches/link lookups run at once; more requests get a "busy" reply.
- yt-dlp is installed from PyPI into a venv (pinned, updated by Dependabot) instead of the self-extracting binary, so each call starts faster and nothing is unpacked to `/tmp`. It is no longer updated synchronously at startup.
- The Docker health check is a plain shell check and turns unhealthy while disconnected.
- When tracks keep failing (3 in a row, or right away for YouTube bot checks and similar), playback stops and keeps the queue instead of draining it; `!resume` or a new `!play` retries.
- "Now playing" is announced once audio actually starts, so a track that fails to load gives one message instead of two.
- Outgoing chat messages are spaced 300 ms apart to stay clear of anti-flood limits.
- TeamSpeak client restarts after crashes back off (3 s up to 2 min); after more than 5 crashes in 5 minutes the container restarts.
- The image uses `tini` as init and a pinned Node.js base image (updated via Dependabot). Compose files rotate logs and allow 20 s for a clean shutdown.

## [0.1.0] - 2026-11-12

First public version of 🧻 Mendil.

### Added
- Headless official TeamSpeak 3 client (Xvfb + PulseAudio) controlled through the ClientQuery plugin.
- YouTube playback through yt-dlp and ffmpeg, with loudness normalisation.
- Chat commands: play, playnext, search/pick, skip, stop, pause/resume, now playing, queue, remove, clear, shuffle, loop, volume, join and help.
- YouTube playlist support.
- English and Turkish chat messages (`BOT_LANGUAGE`).
- Automatic recovery from client crashes and lost server connections.
- The TeamSpeak client is downloaded on first start after accepting its license (`TS3CLIENT_LICENSE=accept`).
- Docker health check, example compose files and GitHub Actions for CI and image publishing.

[Unreleased]: https://github.com/ulaski/mendil/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ulaski/mendil/releases/tag/v0.1.0
