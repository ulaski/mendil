---
title: "Roles"
description: "Admins and listeners: who may request songs, and who controls playback."
---

Out of the box everyone can do everything. To keep the controls for a few people, name them as admins:

```env
# e.g. your server's "Server Admin" group, and/or single people (!whoami shows your ID and groups)
ADMIN_GROUPS=6
ADMIN_UIDS=abc123=
```

Everyone else becomes a listener. Listeners can request and search songs, see what's playing and the queue, and skip or remove the songs they requested themselves. Pausing, stopping, the volume, loop, shuffle, clearing, play-next, the radio station, `!join` and other people's songs are for admins. The web panel follows the same rules.

To keep some people out entirely, add `ALLOWED_UIDS` / `ALLOWED_GROUPS`: then only those people (and the admins) can use the bot at all.
