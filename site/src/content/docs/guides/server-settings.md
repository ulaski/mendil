---
title: "Server settings"
description: "Codec, talk power and anti-flood settings that make Mendil sound good and answer reliably."
---

- Set Mendil's channel to the **Opus Music** codec with quality 10 (*Edit Channel → Audio*). The default *Opus Voice* codec makes music sound bad.
- If the channel requires talk power, give Mendil's server group enough of it.
- Long queue listings send a few messages in a row. If the server's anti-flood blocks Mendil, add it to a group with `b_client_ignore_antiflood`.
- Mendil keeps its identity across restarts in the `ts3client-data` volume, so a server group you give it stays.

Mendil checks the codec and talk power when it joins a channel and posts a short hint if something is off, once per channel. `CHANNEL_HINTS=false` turns this off.
