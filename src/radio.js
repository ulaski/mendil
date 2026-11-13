import { Readable, Transform } from 'node:stream';
import pkg from '../package.json' with { type: 'json' };

/**
 * Internet radio. A station is a stream URL (Icecast/SHOUTcast MP3 or AAC, HLS, or a .pls /
 * .m3u playlist that points to one). Mendil reads the stream itself so it can pick up the
 * song titles the station sends along (ICY metadata); ffmpeg only decodes the audio.
 */

const PLAYLIST_TYPES = /(scpls|mpegurl|x-mpegurl|vnd\.apple\.mpegurl)/i;
const MAX_PLAYLIST_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
// Who is asking, honestly: stations see the project and where to read about it.
export const USER_AGENT = `Mendil/${pkg.version} (+https://github.com/ulaski/mendil)`;

/** RADIO_STATIONS: "name=url,other name=url". Entries without a web address are ignored. */
export function parseStations(raw) {
  const stations = [];
  for (const entry of String(raw ?? '').split(',')) {
    const at = entry.indexOf('=');
    if (at < 1) continue;
    const name = entry.slice(0, at).trim();
    const url = entry.slice(at + 1).trim();
    if (name && /^https?:\/\//i.test(url) && !stations.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      stations.push({ name, url });
    }
  }
  return stations;
}

/** A configured station by name (case-insensitive), or a station made from a web address, or null. */
export function findStation(stations, query) {
  const text = String(query ?? '').trim();
  if (!text) return null;
  const known = stations.find((s) => s.name.toLowerCase() === text.toLowerCase() || s.url === text);
  if (known) return known;
  if (!/^https?:\/\/\S+$/i.test(text)) return null;
  try {
    return { name: new URL(text).hostname.replace(/^www\./, ''), url: text };
  } catch {
    return null;
  }
}

/** "StreamTitle='Artist - Song';StreamUrl='';" -> "Artist - Song" (or null). */
export function parseIcyTitle(block) {
  let text = block.toString('utf8');
  if (text.includes('�')) text = block.toString('latin1'); // many stations still send Latin-1
  const m = text.match(/StreamTitle='(.*?)';/s);
  const title = m?.[1]?.replace(/\0+$/, '').trim();
  return title || null;
}

/**
 * Removes the ICY metadata blocks from a stream (every `metaint` bytes of audio comes one
 * length byte, then length × 16 bytes of text) and reports titles as they change.
 */
export class IcyStripper extends Transform {
  #metaint;
  #untilMeta;
  #metaLeft = -1; // -1: reading audio; 0+: bytes of metadata still to read
  #meta = [];
  #lastTitle = null;

  constructor(metaint, onTitle) {
    super();
    this.#metaint = metaint;
    this.#untilMeta = metaint;
    this.onTitle = onTitle;
  }

  _transform(chunk, _encoding, done) {
    let i = 0;
    while (i < chunk.length) {
      if (this.#metaLeft < 0) {
        const n = Math.min(this.#untilMeta, chunk.length - i);
        if (n > 0) this.push(chunk.subarray(i, i + n));
        i += n;
        this.#untilMeta -= n;
        if (this.#untilMeta === 0 && i < chunk.length) {
          this.#metaLeft = chunk[i] * 16;
          i++;
          if (this.#metaLeft === 0) this.#endMeta();
        }
      } else {
        const n = Math.min(this.#metaLeft, chunk.length - i);
        this.#meta.push(chunk.subarray(i, i + n));
        i += n;
        this.#metaLeft -= n;
        if (this.#metaLeft === 0) this.#endMeta();
      }
    }
    done();
  }

  #endMeta() {
    if (this.#meta.length) {
      const title = parseIcyTitle(Buffer.concat(this.#meta));
      if (title && title !== this.#lastTitle) {
        this.#lastTitle = title;
        this.onTitle?.(title);
      }
    }
    this.#meta = [];
    this.#metaLeft = -1;
    this.#untilMeta = this.#metaint;
  }
}

/** The first stream address in a .pls or .m3u playlist. */
export function firstPlaylistEntry(text) {
  for (const line of text.split(/\r?\n/)) {
    const value = line.replace(/^File\d+=/i, '').trim();
    if (/^https?:\/\/\S+$/i.test(value)) return value;
  }
  return null;
}

/**
 * Connects to a station. Resolves to { audio } (a stream of encoded audio, ICY metadata
 * removed) or { url } when ffmpeg should read the address itself (HLS, or a server Node
 * can't talk to). Aborting `signal` closes the connection.
 */
export async function openStation(url, { signal, onTitle, fetchImpl = fetch, depth = 0, connectTimeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  // The time limit is for connecting only: the audio itself is meant to flow for hours.
  const connecting = new AbortController();
  const timer = setTimeout(() => connecting.abort(new Error('timed out')), connectTimeoutMs);
  const options = { signal, onTitle, fetchImpl, connectTimeoutMs, depth: depth + 1 };
  try {
    return await connect(url, { signal: signal ? AbortSignal.any([signal, connecting.signal]) : connecting.signal, outer: signal, onTitle, fetchImpl, depth, options });
  } finally {
    clearTimeout(timer);
  }
}

async function connect(url, { signal, outer, onTitle, fetchImpl, depth, options }) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'Icy-MetaData': '1', 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal,
    });
  } catch (err) {
    if (outer?.aborted) throw err;
    // Old SHOUTcast servers answer "ICY 200 OK", which isn't HTTP; ffmpeg understands it.
    if (/HPE_|parse|invalid/i.test(`${err.cause?.code ?? ''} ${err.cause?.message ?? ''}`)) return { url };
    throw new Error(`could not reach the station: ${err.cause?.code ?? err.message}`);
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new Error(`the station answered ${res.status}`);
  }

  const type = res.headers.get('content-type') ?? '';
  const path = new URL(res.url || url).pathname.toLowerCase();
  if (PLAYLIST_TYPES.test(type) || /\.(pls|m3u8?)$/.test(path)) {
    const text = (await res.text()).slice(0, MAX_PLAYLIST_BYTES);
    if (/#EXT-X-/.test(text)) return { url: res.url || url }; // HLS: ffmpeg handles the segments
    const next = firstPlaylistEntry(text);
    if (!next || depth >= 2) throw new Error('the station playlist has no stream address');
    return openStation(next, options);
  }
  if (!res.body) throw new Error('the station sent no audio');

  // From here on only the caller's signal may end it (see the time limit above).
  const audio = Readable.fromWeb(res.body);
  outer?.addEventListener('abort', () => audio.destroy(), { once: true });
  const metaint = Number.parseInt(res.headers.get('icy-metaint') ?? '', 10);
  if (!(metaint > 0)) return { audio };
  const stripped = new IcyStripper(metaint, onTitle);
  audio.on('error', (err) => stripped.destroy(err));
  return { audio: audio.pipe(stripped) };
}
