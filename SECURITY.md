# Security policy

## Supported versions

Only the latest release of Mendil gets security fixes. Update with `docker compose pull && docker compose up -d`.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem.

Report it privately through GitHub instead: on the repository's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/ulaski/mendil/security/advisories/new)). Include what you found, how to reproduce it, and what an attacker could do with it.

You'll get an answer within 7 days. Once the problem is confirmed, a fix is released as soon as possible and you're credited in the release notes, unless you prefer not to be.

## Scope

In scope:
- the Mendil code in this repository and the Docker image `ghcr.io/ulaski/mendil`;
- the way Mendil handles chat commands, access control (`ALLOWED_UIDS`, `ALLOWED_GROUPS`), its files and the processes it starts (yt-dlp, ffmpeg).

Out of scope, please report these upstream:
- the TeamSpeak client or server (TeamSpeak Systems);
- yt-dlp, ffmpeg, Node.js or the Debian base image, unless the way Mendil uses them makes the problem worse.

## Good to know

- Mendil never needs ServerQuery credentials. It joins your server as a normal client.
- Anyone who can talk to the bot can queue songs unless you set `ALLOWED_UIDS` or `ALLOWED_GROUPS`. That is a configuration choice, not a vulnerability.
- Cookies (`YTDLP_COOKIES_FILE`) give access to the Google account they came from. Use a throwaway account, as [docs/youtube.md](docs/youtube.md) says.
