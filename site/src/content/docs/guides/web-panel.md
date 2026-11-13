---
title: "Web panel"
description: "Mendil's browser panel: what's playing, the queue and controls, with TeamSpeak sign-in."
---

Mendil also has a web panel on port 8080: what's playing, the queue, volume and loop, a box to request songs and search YouTube, and the live log. It works on phones too.

There are two ways to sign in:

- **With TeamSpeak.** Type your TeamSpeak nickname while you're on the server, and Mendil sends you a one-time code in a private message. The panel then knows who you are and gives you the same [role](../../guides/roles/) as in chat: listeners see the queue and request songs, admins get every control. Songs you request show your name.
- **With the panel password.** Always an admin. Use it when Mendil isn't connected to TeamSpeak.

To open it, publish the port in `docker-compose.yml`:

```yaml
    ports:
      - "127.0.0.1:8080:8080"
```

Then open http://localhost:8080 on the machine that runs Mendil. The panel password is in the log on first start (`docker compose logs mendil | grep password`), or choose one with `PANEL_PASSWORD`.

On a server, keep the `127.0.0.1:` part and reach the panel through an SSH tunnel (`ssh -L 8080:localhost:8080 you@server`, then open http://localhost:8080), or put it behind a reverse proxy with HTTPS. Don't publish it to the internet over plain HTTP: the password would travel unencrypted. `PANEL_PORT=0` turns the panel off.
