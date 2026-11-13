---
title: "Commands"
description: "Every chat command, its aliases, and who may use it."
---

Mendil reads its own channel's chat and private messages sent to it. In private chat the `!` prefix is optional. Commands tagged <span class="admin-tag">admin</span> are for admins once you've set up [roles](../../guides/roles/).

| Command | Aliases | Description |
|---|---|---|
| `!play <link \| search>` | `!p` | Play now, or add to the end of the queue. Accepts a YouTube link, a playlist, a Spotify song, album or playlist link, or search terms. |
| `!playnext <link \| search>` <span class="admin-tag">admin</span> | `!pn` | Add to the front of the queue |
| `!search <search>` | `!find` | Show the top 5 YouTube results |
| `!pick <number>` | | Queue a result from `!search` |
| `!skip` | `!s`, `!next` | Skip the current track. Listeners can skip only their own songs. |
| `!pause` / `!resume` <span class="admin-tag">admin</span> | `!unpause` | Pause / resume |
| `!stop` <span class="admin-tag">admin</span> | | Stop and clear the queue |
| `!np` | `!now`, `!nowplaying` | Show the current track and its progress |
| `!queue` | `!q`, `!list` | Show the queue |
| `!remove <number>` | `!rm` | Remove a track from the queue. Listeners can remove only their own songs. |
| `!seek <1:30 \| +30 \| -10>` | | Jump to a time in the current track. Listeners can seek only their own songs. In the web panel, click the progress bar. |
| `!move <from> <to>` <span class="admin-tag">admin</span> | `!mv` | Move a queued track to another position |
| `!clear` <span class="admin-tag">admin</span> | | Clear the queue (the current track keeps playing) |
| `!shuffle` <span class="admin-tag">admin</span> | | Shuffle the queue |
| `!loop [off\|one\|all]` <span class="admin-tag">admin</span> | `!repeat` | Loop nothing, the current track, or the whole queue |
| `!vol [0-100]` | `!volume`, `!v` | Show the volume; setting it is for admins <span class="admin-tag">admin</span> |
| `!radio [name \| link \| off]` | | Show the radio and its stations. Picking a station or turning it off is for admins <span class="admin-tag">admin</span>. See [Radio](../../guides/radio/). |
| `!join` <span class="admin-tag">admin</span> | `!come` | Move the bot to your channel. From another channel, send it as a private message. |
| `!whoami` | `!me`, `!id` | Show your unique ID, server groups and role |
| `!help` | `!h`, `!commands` | List commands |

With `BOT_LANGUAGE=tr`, Turkish aliases also work, e.g. `!çal`, `!geç`, `!ses`, `!gel`.
