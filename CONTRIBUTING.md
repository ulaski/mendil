# Contributing to 🧻 Mendil

Thanks for helping out! Bug reports, translations and pull requests are all welcome.

By contributing you agree that your contributions are licensed under the project's license,
the [GNU GPL v3 or later](LICENSE).

## Reporting bugs

Open an issue with:

- what you did, what you expected and what happened,
- the bot's log (`docker compose logs mendil`). Run with `LOG_LEVEL=debug` if you can.
- for connection problems, the TeamSpeak client's own log:
  `docker compose exec mendil sh -c 'tail -100 $(ls -t ~/.ts3client/logs/*.log | head -1)'`

Remove server passwords, IPs and other private data first.

## Development setup

The Classic engine only runs inside its Docker image, because it needs the TeamSpeak client, Xvfb and PulseAudio. The native engine also runs directly with Node.js, ffmpeg and yt-dlp. The unit tests run on any machine with Node.js 22.12 or newer:

```bash
npm ci
npm test
```

The end-to-end test runs the native engine against a real TeamSpeak 3 or 6 server (CI does this for both):

```bash
docker run -d --name ts3 -e TS3SERVER_LICENSE=accept -p 9987:9987/udp teamspeak:latest
TS_HOST=127.0.0.1 TS_PORT=9987 node test/e2e/native-e2e.mjs
```

To try your changes end to end you need a TeamSpeak server. `examples/with-ts3-server` starts one together with the bot:

```bash
docker build --platform linux/amd64 -t ghcr.io/ulaski/mendil:latest .
cd examples/with-ts3-server && docker compose up
```

On Apple Silicon this runs under x86_64 emulation. It is slow but works. The native image builds natively on any architecture: `docker build --target native -t mendil-native .`

## Guidelines

- No new npm dependencies unless there's a very good reason. Apart from teamspeak-js for the native engine, the project only uses the Node.js standard library. Dependencies are pinned to exact versions.
- Keep user-facing chat messages in `src/i18n/`. Never hard-code them.
- Add or update tests in `test/` for logic that can be tested without TeamSpeak.
- Update `CHANGELOG.md` under *Unreleased*.

## Adding a language

1. Copy `src/i18n/en.js` to `src/i18n/<code>.js` and translate the values. Keep the `{placeholders}`.
2. Optionally add command aliases in `commandAliases` and loop-mode names in `loopAliases`.
3. Register the file in `src/i18n/index.js`.
4. Run `npm test`. It checks that every key and placeholder exists and that aliases don't collide.
