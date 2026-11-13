---
title: "Where is your server?"
description: "How Mendil reaches your TeamSpeak server: remote, in Docker on the same host, on the host, or not yet installed."
---

| Setup | What to do |
|---|---|
| Another machine, or hosted by a provider | Set `TS3_HOST` to its address. Done. |
| Same host, **in Docker** | Copy [`examples/existing-docker-server/docker-compose.override.yml`](https://github.com/ulaski/mendil/blob/main/examples/existing-docker-server/docker-compose.override.yml) next to `docker-compose.yml`, adjust the network name, and set `TS3_HOST` to the server's service name (e.g. `teamspeak`). |
| Same host, **not in Docker** | Set `TS3_HOST=host.docker.internal` and add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service. |
| No server yet | [`examples/with-ts3-server`](https://github.com/ulaski/mendil/blob/main/examples/with-ts3-server/docker-compose.yml) starts a TeamSpeak server and Mendil together. |
