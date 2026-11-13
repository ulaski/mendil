---
title: "Troubleshooting"
description: "What to check when Mendil does not connect, play or sound right."
---

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
YouTube sometimes blocks data-center IPs. Cookies from a throwaway YouTube account or a proxy (`YTDLP_PROXY`) fix it, and the [YouTube guide](../../guides/youtube/) explains both step by step. Mendil links to that page in chat when it detects the block.

**Music sounds bad**
The channel codec is almost always the cause. Use Opus Music at quality 10.

**Container is "unhealthy"**
The health check passes while Mendil is connected to the server. `docker compose exec mendil cat /tmp/mendil-health.json` shows the details, and the logs say why it isn't connected. Mendil retries on its own: within seconds after a disconnect, 45 s after a kick, and after a ban has expired. If it can't connect for 20 minutes, it restarts itself.

**Playback stopped with "tracks keep failing"**
After 3 failed tracks in a row, or right away when YouTube blocks the bot, Mendil stops instead of skipping through the whole queue. Fix the cause (see the YouTube note above), then type `!resume`.

**Resource usage**
Every 10 minutes the log has a `stats:` line with CPU and memory per process and the gap/load times of recent tracks.
