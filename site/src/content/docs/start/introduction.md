---
title: "Introduction"
description: "What Mendil is, where the name comes from, and what you need to run it."
---

Mendil is a music bot for your TeamSpeak server. Write a song in chat and Mendil plays it in your channel. You run it yourself, in one Docker container.

## Why "Mendil"?

In Türkiye, people at a *gazino* or *meyhane* used to write their song request on a *mendil*, a napkin, and pass it up to the musicians on stage. Mendil does the same for your TeamSpeak server. Write your request in chat and the band plays it. *(Pronounced men-DEEL.)*

## What it does

- 🎵 Plays YouTube links, whole playlists, or the first result for a search. Spotify songs, albums and playlists work too: Mendil finds each song on YouTube.
- 📝 Has a proper queue: search and pick, play next, skip, pause, seek, move, loop, shuffle and volume, with an optional limit of songs per person
- 📻 Plays an internet radio station whenever the queue is empty, so the channel never goes quiet. A request interrupts the radio, and it comes back afterwards.
- 💤 Pauses while nobody is in its channel and carries on when someone joins
- 🔊 Keeps every track at the same loudness, so nobody has to ride the volume
- 🐳 Runs as one container. You accept the TeamSpeak license and give it your server's address.
- ⏭️ Downloads the next track while the current one plays, so songs follow each other without a gap
- 🩹 Gets back on its feet after crashes, kicks, bans and server restarts, and after a restart it continues the song where it stopped
- 🌍 Speaks English and Turkish. [Adding a language](../../project/contributing/#adding-a-language) means translating one file.
- 🩺 Tells you when a channel setting makes music sound bad or keeps it from being heard, and explains YouTube blocks
- 🔐 Knows admins from listeners: listeners request songs and can skip or remove their own, admins control the rest. Set by TeamSpeak unique ID or server group.
- 🖥️ Has a web panel: see what's playing, manage the queue and add songs from your browser or phone. Friends sign in with their TeamSpeak name.
- 🧪 Comes with two voice engines: the official TeamSpeak client, or an experimental native engine that also runs on ARM and plays music in any channel

## Requirements

- A TeamSpeak 3 or TeamSpeak 6 server. Tested with TS3 server 3.13.9 and TS6 server 6.0.0-beta13.1.
- Docker with Docker Compose
- For Classic: an x86_64 (amd64) host, because the official TS3 client only exists for x86_64. ARM machines such as a Raspberry Pi or a Mac with Apple Silicon can run it under emulation, but slowly. About 300 MB of RAM per bot, and internet access on first start to download the TeamSpeak client.
- For Native: any x86_64 or ARM64 host and about 100 MB of RAM per bot.

Ready? Go to the [quick start](../quick-start/).
