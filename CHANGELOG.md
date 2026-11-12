# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Skipping or stopping a track no longer leaves a yt-dlp process and an ~85 MB temp directory behind. yt-dlp now runs in its own process group, which is stopped as a whole.
- A chat command could run twice when a watchdog run overlapped the next one. Stale ClientQuery connections are now closed and ignored.
- The container stayed up but silent when Xvfb or PulseAudio died. The bot now exits within one watchdog tick so Docker restarts it.
- The health check could report "healthy" right after a restart, before the bot had reconnected.
- PulseAudio ran at 44.1 kHz, so audio was resampled twice. Everything now runs at 48 kHz.

### Changed
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
