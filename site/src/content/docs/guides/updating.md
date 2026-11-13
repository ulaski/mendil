---
title: "Updating"
description: "Updating Mendil, pinning a version, and what survives an update."
---

```bash
docker compose pull && docker compose up -d
# from source: git pull && docker compose up -d --build
```

`latest` always points to the newest release. To stay on a version you've tested, use its tag instead, e.g. `image: ghcr.io/ulaski/mendil:0.6.1`.

yt-dlp also updates itself in the background, daily and whenever YouTube extraction starts failing, so most YouTube changes need no action.

The queue survives updates and restarts. It is stored with the bot's identity in the `ts3client-data` volume.
