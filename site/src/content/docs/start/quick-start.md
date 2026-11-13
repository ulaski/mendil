---
title: "Quick start"
description: "From nothing to the first song: download two files, set your server, start the container."
---

No need to clone the repo. Download the compose file and the example settings:

```bash
mkdir mendil && cd mendil
curl -fsSLO https://raw.githubusercontent.com/ulaski/mendil/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/ulaski/mendil/main/.env.example
```

Edit `.env` and set at least:

```ini
TS3CLIENT_LICENSE=accept      # accepts the TeamSpeak client license, see Legal
TS3_HOST=ts.example.com       # your server
TS3_SERVER_PASSWORD=          # if your server has one
```

Then start it:

```bash
docker compose up -d
docker compose logs -f
```

The first start downloads the TeamSpeak client (~110 MB). Once you see `connected to server`, join Mendil's channel and type `!help`.

<details>
<summary>Without Compose: a single <code>docker run</code></summary>

```bash
docker run -d --name mendil --restart unless-stopped --shm-size 256m \
  -e TS3CLIENT_LICENSE=accept \
  -e TS3_HOST=ts.example.com \
  -e TS3_SERVER_PASSWORD= \
  -v mendil-data:/home/node/.ts3client \
  -v mendil-client:/opt/ts3client \
  ghcr.io/ulaski/mendil:latest
```

Add `--platform linux/amd64` on an ARM machine.
</details>

<details>
<summary>From source</summary>

```bash
git clone https://github.com/ulaski/mendil.git
cd mendil
cp .env.example .env   # then edit it
docker compose up -d --build
```
</details>

<details>
<summary>With the native engine</summary>

In `docker-compose.yml`, use the native image and drop what only Classic needs:

```yaml
services:
  mendil:
    image: ghcr.io/ulaski/mendil:native
    container_name: mendil
    restart: unless-stopped
    env_file: .env
    volumes:
      - ts3client-data:/home/node/.ts3client

volumes:
  ts3client-data:
```

`TS3CLIENT_LICENSE` isn't needed, because no TeamSpeak client is downloaded. Everything else in `.env` stays the same; if your `.env` sets `VOICE_BACKEND=classic`, remove that line.

From source, add a `build` section to the same service, so Compose builds the native image instead of downloading it:

```yaml
    build:
      context: .
      target: native
```

and start it with `docker compose up -d --build`.
</details>

Next: tell Mendil [where your TeamSpeak server is](../../guides/your-server/) if it runs on the same machine, and set up the [channel](../../guides/server-settings/).
