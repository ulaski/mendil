/**
 * Spotify links. Spotify doesn't let anyone else stream its audio, so Mendil reads a link's
 * public metadata (title, artists, length) from Spotify's embed page, which needs no API
 * key, and plays each song from YouTube. The YouTube lookup happens shortly before a song
 * plays (Player `resolver`), so a 50-song playlist lands in the queue at once.
 *
 * Queued Spotify tracks look like any other track, plus `search`: the YouTube search terms.
 * Their `url` is the Spotify link, for display only; it is never played.
 */

const LINK = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{22})(?:[/?#]|$)/i;
const URI = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/i;
const SHORT = /^https?:\/\/spotify\.link\/[A-Za-z0-9]+$/i;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/** { type: 'track' | 'album' | 'playlist', id } for a Spotify link or URI, else null. */
export function parseSpotifyUrl(input) {
  const text = String(input ?? '').trim();
  const m = text.match(LINK) ?? text.match(URI);
  return m ? { type: m[1].toLowerCase(), id: m[2] } : null;
}

export function isSpotifyInput(input) {
  return Boolean(parseSpotifyUrl(input)) || SHORT.test(String(input ?? '').trim());
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const trackLink = (uri) => {
  const id = String(uri ?? '').split(':').pop();
  return /^[A-Za-z0-9]{22}$/.test(id) ? `https://open.spotify.com/track/${id}` : null;
};

/** A queue entry for one song; `search` is what Mendil looks for on YouTube. */
function toTrack({ title, artists, durationMs, link }) {
  const name = clean(title);
  if (!name) return null;
  const by = clean(artists);
  const label = by ? `${by} - ${name}` : name;
  return {
    title: label,
    url: link,
    duration: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : null,
    isLive: false,
    search: label,
  };
}

/** The entity from an embed page's __NEXT_DATA__ JSON. Exported for tests. */
export function parseEmbedPage(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Spotify changed its page; the link could not be read');
  const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity?.type) throw new Error('Spotify did not return anything for this link');
  if (entity.type === 'track') {
    const track = toTrack({
      title: entity.name ?? entity.title,
      artists: (entity.artists ?? []).map((a) => a.name).join(', '),
      durationMs: entity.duration,
      link: trackLink(entity.uri),
    });
    return { title: null, tracks: track ? [track] : [] };
  }
  const tracks = (entity.trackList ?? [])
    .map((t) => toTrack({ title: t.title, artists: t.subtitle, durationMs: t.duration, link: trackLink(t.uri) }))
    .filter((t) => t?.url);
  return { title: clean(entity.name ?? entity.title) || null, tracks };
}

async function fetchText(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Mendil)', 'accept-language': 'en' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (res.status === 404) throw new Error('Spotify says this link does not exist');
  if (!res.ok) throw new Error(`Spotify answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_PAGE_BYTES) throw new Error('Spotify page too large');
  return { text, finalUrl: res.url };
}

/**
 * The songs behind a Spotify link: { title (album/playlist name or null), tracks }.
 * Spotify's embed page lists at most about 100 songs of a playlist.
 */
export async function resolveSpotify(input, { fetchImpl = fetch } = {}) {
  let ref = parseSpotifyUrl(input);
  if (!ref && SHORT.test(String(input).trim())) {
    // spotify.link short links redirect to open.spotify.com.
    const { finalUrl } = await fetchText(String(input).trim(), fetchImpl);
    ref = parseSpotifyUrl(finalUrl);
  }
  if (!ref) throw new Error('not a Spotify song, album or playlist link');
  const { text } = await fetchText(`https://open.spotify.com/embed/${ref.type}/${ref.id}`, fetchImpl);
  return parseEmbedPage(text);
}

/**
 * Picks the YouTube result for a Spotify song: the first of the top results whose length is
 * within a few seconds of Spotify's (so an official audio upload beats a music video with a
 * long intro), else the closest one that is not far off, else the top result.
 */
export function pickYoutubeMatch(results, durationS) {
  const playable = results.filter((r) => !r.isLive && r.url);
  if (playable.length === 0) return null;
  if (!Number.isFinite(durationS) || durationS <= 0) return playable[0];
  const off = (r) => (Number.isFinite(r.duration) ? Math.abs(r.duration - durationS) : Infinity);
  const close = playable.find((r) => off(r) <= 5);
  if (close) return close;
  const best = [...playable].sort((a, b) => off(a) - off(b))[0];
  return off(best) <= Math.max(30, durationS * 0.25) ? best : playable[0];
}
