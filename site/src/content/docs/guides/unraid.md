---
title: "Unraid"
description: "Install Mendil on Unraid with a template, with its data in appdata."
---

There are two templates: **Mendil** runs the Classic engine (the official TeamSpeak 3 client), and **Mendil-Native** runs the experimental native engine, which needs about 80 MB of RAM and no TeamSpeak client download.

## Install

Until the templates are in Community Applications, add one by hand. In the Unraid terminal:

```bash
# Classic
wget -O /boot/config/plugins/dockerMan/templates-user/my-Mendil.xml \
  https://raw.githubusercontent.com/ulaski/mendil/main/examples/unraid/mendil.xml

# or Native
wget -O /boot/config/plugins/dockerMan/templates-user/my-Mendil-Native.xml \
  https://raw.githubusercontent.com/ulaski/mendil/main/examples/unraid/mendil-native.xml
```

Then open **Docker → Add Container**, pick the template, and fill in:

- **TeamSpeak server**: your server's address. If TeamSpeak runs on this Unraid server too, use the server's IP.
- **Accept the TeamSpeak client license** (Classic only): type `accept` after reading the [license](https://www.teamspeak.com/en/privacy-and-terms/). Mendil downloads the client on first start.
- **Server password**, if your server has one.

Click **Apply**. The log shows `connected to server` once Mendil has joined. Then join its channel and type `!help`.

## Web panel

Open `http://<unraid-ip>:8080`. On first start the panel password is in the container log; friends sign in with their TeamSpeak nickname instead (see [Web panel](../web-panel/)). Keep port 8080 on your LAN, or put it behind a reverse proxy with HTTPS before you expose it.

## Data and permissions

Mendil keeps its identity, settings and saved queue in `/mnt/user/appdata/mendil/data`, and the Classic engine keeps the downloaded TeamSpeak client in `/mnt/user/appdata/mendil/client`. Keep the data folder: it holds the bot's identity, so server groups you give the bot stay after updates.

The templates start the container with `--user=0:0` and `PUID=99` / `PGID=100`. Mendil uses root only to hand those two folders to that user, then runs everything as `nobody:users`, like Unraid's other apps. See `PUID` / `PGID` in [Configuration](../../reference/configuration/).

## More settings

The template shows the common settings; **Show more settings** adds admins, radio stations and the panel password. Every other setting from [Configuration](../../reference/configuration/) works too: add it to the container as a variable.
