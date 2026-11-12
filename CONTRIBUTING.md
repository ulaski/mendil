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

The bot only runs inside its Docker image, because it needs the TeamSpeak client, Xvfb and PulseAudio.
The unit tests run on any machine with Node.js 22 or newer:

```bash
npm test
```

To try your changes end to end you need a TeamSpeak server. `examples/with-ts3-server` starts one together with the bot:

```bash
docker build --platform linux/amd64 -t ghcr.io/ulaski/mendil:latest .
cd examples/with-ts3-server && docker compose up
```

On Apple Silicon this runs under x86_64 emulation. It is slow but works.

## Guidelines

- No new npm dependencies unless there's a very good reason. The project only uses the Node.js standard library.
- Keep user-facing chat messages in `src/i18n/`. Never hard-code them.
- Add or update tests in `test/` for logic that can be tested without TeamSpeak.
- Update `CHANGELOG.md` under *Unreleased*.

## Adding a language

1. Copy `src/i18n/en.js` to `src/i18n/<code>.js` and translate the values. Keep the `{placeholders}`.
2. Optionally add command aliases in `commandAliases` and loop-mode names in `loopAliases`.
3. Register the file in `src/i18n/index.js`.
4. Run `npm test`. It checks that every key and placeholder exists and that aliases don't collide.
