---
title: "FAQ"
description: "Classic or Native, several bots, TeamSpeak 6, Spotify and who can use the bot."
---

**Classic or Native?**
Classic runs TeamSpeak's own client, which has spoken exactly what servers expect for years. Native is lighter, runs on ARM and doesn't care about the channel codec, but it uses an independent implementation of the TeamSpeak protocol that is younger and not endorsed by TeamSpeak. If Classic works for you, keep it. If you're on a Raspberry Pi, short on memory, or can't change the channel codec, try Native.

**Can I run several bots?**
Yes. Run one container per bot, each with its own volumes and nickname. Use a separate compose project (`docker compose -p mendil2 …`) or directory for each.

**Does it work with TeamSpeak 6 servers?**
Yes, with both engines. Tested with TS6 server 6.0.0-beta13.1: commands, announcements and audio all work, and CI tests the native engine against TS3 and TS6 servers on every change.

**TeamSpeak 3 reaches end-of-life at the end of 2027. What happens then?**
TeamSpeak has announced that TS3 reaches end-of-life at the end of 2027, but hasn't said what that means for TS3 clients on TS6 servers. If the TS3 client stops working with TS6 servers, the native engine doesn't depend on it.

**Spotify / SoundCloud?**
Paste a Spotify song, album or playlist link (`open.spotify.com/...` or `spotify.link/...`). Spotify doesn't let anyone else play its audio, so Mendil reads the song list from Spotify's public embed page (no account or API key needed) and plays each song from YouTube. It picks the result whose length matches Spotify's, so it usually gets the album version rather than a music video. The lookup happens just before a song plays, so a long playlist joins the queue at once. Spotify's page lists at most about 100 songs of a playlist, and `MAX_PLAYLIST_ITEMS` still applies. Private playlists can't be read.

yt-dlp supports SoundCloud and many other sites, and direct links usually work.

**Who can use the bot?**
By default everyone who can write to it, and `!play` takes links to any site yt-dlp supports. Name admins with `ADMIN_UIDS` or `ADMIN_GROUPS` so only they control playback ([Roles](../../guides/roles/)), and on a public server limit who can use it at all with `ALLOWED_UIDS` or `ALLOWED_GROUPS`. Each user can start a few searches at once and then one every few seconds, so one person can't keep the bot busy for everyone.
