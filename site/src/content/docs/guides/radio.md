---
title: "Radio and quiet channels"
description: "Internet radio for an empty queue, and pausing while nobody is listening."
---

Mendil can play an internet radio station whenever the queue is empty. When someone requests a song, the radio stops at once and the song plays; when the queue runs out, the radio comes back. The station's current song shows in `!np` and in the web panel.

List your stations, and optionally pick one to start with:

```env
RADIO_STATIONS=Groove Salad=https://somafm.com/groovesalad.pls,Radio Paradise=https://stream.radioparadise.com/mp3-128
RADIO=Radio Paradise
```

Then `!radio` shows the stations, `!radio <name>` switches (admins), and `!radio off` turns it off. Admins can also use a stream address directly, as in `!radio https://…`, and pick a station in the web panel. Mendil remembers the choice across restarts until you change `RADIO`. `!stop` turns the radio off too.

Most Icecast and SHOUTcast streams work (MP3, AAC, Ogg), as do HLS streams and `.pls` / `.m3u` playlist links. A station that keeps failing is stopped after three tries, like a song. Some stations refuse anything that isn't their own player; then Mendil says what the station answered.

## When nobody is listening

When Mendil is the only one in its channel for 30 seconds, it pauses and stops transmitting. When someone joins, it continues, and the radio reconnects to the live stream. If you resume it by hand while the channel is empty (from the web panel, say), it keeps playing. `PAUSE_WHEN_ALONE=false` turns this off.
