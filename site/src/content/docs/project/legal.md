---
title: "Legal and license"
description: "Trademarks, the TeamSpeak client license, your responsibility for content, and the GPL."
---

This project is not affiliated with or endorsed by TeamSpeak Systems GmbH. *TeamSpeak* is their trademark.

The native engine uses [teamspeak-js](https://github.com/HoneyBBQ/teamspeak-js), an independent, open-source implementation of the TeamSpeak protocol that contains no TeamSpeak code. It is not made or endorsed by TeamSpeak either. Check that third-party clients are fine with the servers you connect to.

The TeamSpeak client is proprietary and is **not** included in this repository or its Docker image. It is downloaded from TeamSpeak's servers when the container first starts, and only after you set `TS3CLIENT_LICENSE=accept`. Doing so means you accept [TeamSpeak's license terms](https://www.teamspeak.com/en/privacy-and-terms/).

You are responsible for having the right to play the content you stream, and for complying with the terms of the sites you stream from.

## License

Copyright (C) 2026 ulaski

This program is free software: you can redistribute it and/or modify it under the terms of the
[GNU General Public License](https://github.com/ulaski/mendil/blob/main/LICENSE) as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version. It comes with ABSOLUTELY NO WARRANTY.
