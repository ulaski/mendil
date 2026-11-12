# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
