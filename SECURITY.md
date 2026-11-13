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
- the way Mendil handles chat commands, roles and access control (`ADMIN_*`, `ALLOWED_*`), web panel sign-in, its files and the processes it starts (yt-dlp, ffmpeg).

Out of scope, please report these upstream:
- the TeamSpeak client or server (TeamSpeak Systems);
- yt-dlp, ffmpeg, Node.js or the Debian base image, unless the way Mendil uses them makes the problem worse.

## Trust assumptions

- On first start Mendil downloads the TeamSpeak client from TeamSpeak's servers. For the default version (3.6.2) the download is checked against the SHA-256 that TeamSpeak publishes, and a mismatch stops the container. For another version, set `TS3_CLIENT_SHA256`, or the download is used unverified (the log says so).
- yt-dlp updates itself from PyPI in the background (`YTDLP_AUTO_UPDATE`). A new version must pass a self-test, otherwise it is rolled back, but a malicious release would still run once. Set `YTDLP_AUTO_UPDATE=false` if you'd rather take yt-dlp updates only with new Mendil images.
- The native engine depends on [teamspeak-js](https://github.com/HoneyBBQ/teamspeak-js), pinned to an exact version in `package-lock.json`. Its identity is stored in the data volume (`mendil/native-identity`, readable only by the bot user); anyone with that file can connect as the bot.
- `docker-compose.yml` uses the `latest` tag. To run exactly the version you tested, use a version tag such as `ghcr.io/ulaski/mendil:0.3.0`.

## Good to know

- Mendil never needs ServerQuery credentials. It joins your server as a normal client.
- Anyone who can talk to the bot can queue songs unless you set `ALLOWED_UIDS` or `ALLOWED_GROUPS`, and controls playback unless you name admins with `ADMIN_UIDS` or `ADMIN_GROUPS`. That is a configuration choice, not a vulnerability.
- For a Spotify link, Mendil itself fetches only `open.spotify.com` (and follows a `spotify.link` short link there); the songs are then searched and played from YouTube.
- `!play` accepts links to any site yt-dlp supports, not only YouTube. Mendil refuses addresses on private networks (loopback, LAN, link-local such as cloud metadata) unless you set `ALLOW_PRIVATE_URLS=true`. yt-dlp follows redirects on its own, so a public site that redirects to a private address is not caught; restrict who can use the bot if that matters on your network.
- The web panel uses a signed session cookie (HttpOnly, SameSite=Strict). It speaks plain HTTP, so don't publish it to the internet without a reverse proxy that adds HTTPS; the compose file binds it to 127.0.0.1. Ten failed sign-ins or code requests from one address lock it out for ten minutes. Changing `PANEL_PASSWORD` signs everyone out.
- TeamSpeak sign-in trusts the TeamSpeak server: the one-time code goes to whoever has that nickname right now, so a server that lets people take others' nicknames, or a TeamSpeak account someone else can use, means a panel session for them too. The code has six digits, lasts five minutes and dies after five wrong guesses. The session keeps the server groups from sign-in for up to seven days; `ADMIN_*` and `ALLOWED_*` changes apply at once.
- The server and channel passwords reach the TeamSpeak client as a connect URL on its command line, so other processes in the container can see them, just as they can see the environment. They are masked in Mendil's debug log.
- Cookies (`YTDLP_COOKIES_FILE`) give access to the Google account they came from. Use a throwaway account, as [docs/youtube.md](docs/youtube.md) says.
