export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '?';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Keeps BBCode intact by replacing square brackets in user/remote supplied text. */
export function safe(text) {
  return String(text).replace(/\[/g, '(').replace(/\]/g, ')');
}

export function trackLink(track) {
  return `[url=${track.url}]${safe(track.title)}[/url]`;
}

export function trackLength(track) {
  if (track.isLive) return 'canlı';
  return formatDuration(track.duration);
}

/**
 * TeamSpeak wraps links in BBCode ("[URL]https://…[/URL]" or "[URL=https://…]text[/URL]").
 * Turn them back into plain URLs.
 */
export function stripBBCode(text) {
  return text
    .replace(/\[url=([^\]]+)\][^[]*\[\/url\]/gi, '$1')
    .replace(/\[url\]([^[]*)\[\/url\]/gi, '$1')
    .replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, '')
    .trim();
}

/** Splits a long message into chunks that fit TeamSpeak's text message limit (1024 bytes). */
export function chunkMessage(text, maxBytes = 900) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (Buffer.byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = line;
    while (Buffer.byteLength(current) > maxBytes) {
      // hard-split a single very long line on a character boundary
      let cut = current.length;
      while (Buffer.byteLength(current.slice(0, cut)) > maxBytes) cut = Math.floor(cut * 0.9);
      chunks.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
