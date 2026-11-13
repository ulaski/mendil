---
title: "Pterodactyl"
description: "Run Mendil from a Pterodactyl or Pelican panel with the Mendil egg."
---

The egg runs Mendil's official image with the experimental native engine, so it works on x86_64 and ARM64 nodes and needs no TeamSpeak client. The Classic engine isn't offered here, because it needs more shared memory (`/dev/shm`) than Pterodactyl gives a server.

## Add the egg

1. Download [`egg-mendil.json`](https://raw.githubusercontent.com/ulaski/mendil/main/examples/pterodactyl/egg-mendil.json).
2. In the admin area, go to **Nests**, pick or create a nest, and use **Import Egg** with that file. Pelican imports it the same way.

## Create a server

Create a server with the Mendil egg. Give it 512 MB of memory (in testing it peaked at about 160 MB while fetching and playing songs) and 1 GB of disk, most of which holds songs downloaded ahead.

- The server's **allocation** is the web panel's port. Open `http://<node-address>:<that port>` to reach it.
- Set **TeamSpeak server** to your TeamSpeak server's address. It must be reachable from the node, so a TeamSpeak server on the same node is usually its public or LAN IP, not `localhost`.
- Set the **server password** if your TeamSpeak server has one.

Start the server. The console shows `connected to server` once Mendil has joined, and the panel marks it as running. On first start the web panel password is in the console.

## How it runs

Pterodactyl starts the image as its own user and mounts the server's folder at `/home/container`. Mendil notices that and keeps everything there: its identity and settings in `.ts3client`, and songs downloaded ahead in `cache`. Keep `.ts3client`: it holds the bot's identity, so server groups you give the bot stay. **Stop** shuts Mendil down cleanly.

yt-dlp doesn't update itself here, because the copy inside the image isn't writable for Pterodactyl's user. New yt-dlp versions come with new Mendil images (`ghcr.io/ulaski/mendil:native`); restart the server to get the newest one, or reinstall it if your node keeps the old image.

The egg was tested by running the image the way Pterodactyl's daemon does (its user, `/home/container`, the server's port). If you run it on a real panel, [tell us how it went](https://github.com/ulaski/mendil/issues/12).
