# 🧻 Mendil and YouTube blocks

## The symptom

Mendil says in chat that **YouTube is refusing requests from this server**, or the log shows:

```
Sign in to confirm you're not a bot
```

or `HTTP Error 429`. Playback stops and the queue is kept, so nothing is lost while you fix it.

## Why it happens

YouTube treats traffic from data-center IP ranges (VPS and cloud providers) with suspicion and often asks those IPs to sign in. Home connections are rarely affected. Whether your server is affected depends on your provider and changes over time. Many servers never see it.

Mendil already uses a current yt-dlp. It updates in the background, daily and whenever extraction breaks. An outdated yt-dlp is therefore rarely the cause, but this error is not something an update fixes.

## Fix 1: cookies from a YouTube account

Mendil passes the cookies of a logged-in browser session to yt-dlp.

> ⚠️ **Use a throwaway Google account, not your main one.** Automated use can get the account flagged.

1. Sign in to YouTube with the throwaway account in a **private/incognito window**.
2. In the same window, export the cookies in **Netscape format** with a cookies.txt browser extension.
3. Close the private window right away. YouTube rotates cookies of open sessions, which would invalidate your export. The [yt-dlp wiki](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies) explains this in detail.
4. Put the file next to `docker-compose.yml` as `cookies/cookies.txt`. It must be **writable** by the container user (uid 1000), because yt-dlp saves refreshed cookies back to it:
   ```bash
   sudo chown -R 1000:1000 cookies
   ```
5. In `docker-compose.yml`, uncomment the cookies volume (`- ./cookies:/cookies`). Do **not** mount it read-only, or yt-dlp fails.
6. In `.env`, set:
   ```ini
   YTDLP_COOKIES_FILE=/cookies/cookies.txt
   ```
7. Run `docker compose up -d`, then type `!resume` in chat.

Cookies expire eventually. If the error comes back after weeks or months, export them again.

## Fix 2: a proxy

Send yt-dlp's traffic through a connection YouTube trusts more, such as a residential proxy or a home connection:

```ini
YTDLP_PROXY=socks5://user:password@proxy.example.com:1080
```

`http://`, `https://` and `socks5://` URLs work. Only YouTube traffic (yt-dlp) goes through the proxy. The TeamSpeak connection does not.

## Fix 3: PO tokens (advanced, not built in yet)

YouTube also uses "proof of origin" tokens. yt-dlp can get them from a provider plugin. The [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) describes how this works. Mendil doesn't bundle a provider yet. It is on the roadmap.

## Still stuck?

[Open an issue](https://github.com/ulaski/mendil/issues) with the yt-dlp error from `docker compose logs mendil`. Remove cookies, passwords and IPs first.
