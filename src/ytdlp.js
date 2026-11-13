import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { UrlGuard } from './netguard.js';

const execFileAsync = promisify(execFile);

/** Emits 'failure' (stderr text) whenever a yt-dlp call fails; the updater listens. */
export const ytdlpEvents = new EventEmitter();

/**
 * Failures that will hit every track the same way (YouTube blocking us, no audio output…).
 * One of these halts playback right away instead of trying the rest of the queue.
 */
const GLOBAL_ERRORS = [
  /confirm you.?re not a bot/i,
  /sign in to confirm/i,
  /HTTP Error 429/i,
  /pa_simple_new|pulse.*connection refused/i,
  /Temporary failure in name resolution|Network is unreachable/i,
];

export function isGlobalError(text) {
  return GLOBAL_ERRORS.some((re) => re.test(text));
}

/** Largest file yt-dlp may download for one track (prefetch and streaming). */
export const MAX_FILESIZE = '200M';
export const MAX_FILESIZE_BYTES = 200 * 1024 * 1024;

export const YOUTUBE_DOCS_URL = 'https://ulaski.github.io/mendil/guides/youtube/';

/** YouTube refusing this server (usually a data-center IP); see YOUTUBE_DOCS_URL. */
export function isYoutubeBlock(text) {
  return /confirm you.?re not a bot|sign in to confirm|HTTP Error 429/i.test(text);
}

/** Last "ERROR:" line of yt-dlp/ffmpeg output, without the noise. */
export function summarizeError(stderr) {
  const lines = String(stderr).split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.reverse().find((l) => /^ERROR:/.test(l)) || lines[0];
  return (err || 'unknown error').replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '').slice(0, 200);
}

/**
 * Common yt-dlp flags. Node is in the image, so use it as yt-dlp's JS runtime (needed for
 * YouTube). A short socket timeout turns a stalled connection into a quick retry instead
 * of minutes of silence.
 */
export function baseArgs({ cookiesFile, cacheDir, proxy } = {}) {
  const args = ['--no-warnings', '--js-runtimes', 'node', '--socket-timeout', '10'];
  if (cacheDir) args.push('--cache-dir', cacheDir);
  if (cookiesFile) args.push('--cookies', cookiesFile);
  if (proxy) args.push('--proxy', proxy);
  return args;
}

export class BusyError extends Error {
  constructor() {
    super('too many requests at once');
    this.busy = true;
  }
}

/** Limits concurrent work; callers beyond `maxWaiting` are rejected instead of piling up. */
export class Semaphore {
  #active = 0;
  #waiting = [];

  constructor(limit, maxWaiting = Infinity) {
    this.limit = limit;
    this.maxWaiting = maxWaiting;
  }

  async run(fn) {
    if (this.#active >= this.limit) {
      if (this.#waiting.length >= this.maxWaiting) throw new BusyError();
      await new Promise((resolve) => this.#waiting.push(resolve));
    }
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }
}

// Each resolve is a full yt-dlp process (~80 MB plus a node child for YouTube's JS).
const resolveSlots = new Semaphore(2, 8);

export function isUrl(text) {
  return /^https?:\/\/\S+$/i.test(text);
}

export function toTrack(entry) {
  if (!entry) return null;
  let url = entry.webpage_url || entry.original_url || entry.url;
  if ((!url || !isUrl(url)) && entry.id && /youtube/i.test(entry.ie_key || entry.extractor || 'youtube')) {
    url = `https://www.youtube.com/watch?v=${entry.id}`;
  }
  // Only plain web addresses: an entry "URL" from a crafted playlist or feed could otherwise
  // be anything, including a string yt-dlp would read as an option.
  if (!url || !isUrl(url)) return null;
  // Deleted/private playlist entries
  if (/^\[(deleted|private) video\]$/i.test(entry.title || '')) return null;
  return {
    title: entry.title || url,
    url,
    duration: Number.isFinite(entry.duration) ? Math.round(entry.duration) : null,
    isLive: Boolean(entry.is_live || entry.live_status === 'is_live'),
  };
}

async function dumpJson(target, extraArgs, opts) {
  // "--" ends the options: whatever the target is, yt-dlp treats it as a URL.
  const args = [...baseArgs(opts), '-J', '--flat-playlist', '--no-playlist', ...extraArgs, '--', target];
  return resolveSlots.run(async () => {
    try {
      const { stdout } = await execFileAsync('yt-dlp', args, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
      return JSON.parse(stdout);
    } catch (err) {
      const stderr = String(err.stderr || err.message || '');
      ytdlpEvents.emit('failure', stderr);
      throw new Error(summarizeError(stderr) || 'yt-dlp failed');
    }
  });
}

const guards = new Map();
function guardFor({ urlGuard, allowPrivateUrls = false }) {
  if (urlGuard) return urlGuard;
  if (!guards.has(allowPrivateUrls)) guards.set(allowPrivateUrls, new UrlGuard({ allowPrivate: allowPrivateUrls }));
  return guards.get(allowPrivateUrls);
}

/** Drops tracks whose URL points to a private network. */
async function publicOnly(tracks, guard) {
  const ok = await Promise.all(tracks.map((t) => guard.isAllowed(t.url)));
  return tracks.filter((_, i) => ok[i]);
}

/**
 * Resolves user input into tracks:
 *  - a video URL           -> 1 track ("&list=" in a watch URL is ignored)
 *  - a playlist URL        -> up to maxPlaylistItems tracks
 *  - anything else         -> first YouTube search result
 * URLs on private networks (and playlist entries pointing there) are refused unless
 * allowPrivateUrls is set; see netguard.js.
 */
export async function resolveTracks(input, { maxPlaylistItems = 50, cookiesFile, cacheDir, proxy, allowPrivateUrls, urlGuard } = {}) {
  const guard = guardFor({ urlGuard, allowPrivateUrls });
  if (isUrl(input)) await guard.assertAllowed(input);
  const target = isUrl(input) ? input : `ytsearch1:${input}`;
  const json = await dumpJson(target, ['--playlist-end', String(maxPlaylistItems)], { cookiesFile, cacheDir, proxy });
  const entries = json._type === 'playlist' ? json.entries || [] : [json];
  const tracks = await publicOnly(entries.map(toTrack).filter(Boolean), guard);
  return { tracks, playlistTitle: json._type === 'playlist' && isUrl(input) ? json.title : null };
}

export async function searchTracks(query, { count = 5, cookiesFile, cacheDir, proxy, allowPrivateUrls, urlGuard } = {}) {
  const json = await dumpJson(`ytsearch${count}:${query}`, [], { cookiesFile, cacheDir, proxy });
  return publicOnly((json.entries || []).map(toTrack).filter(Boolean), guardFor({ urlGuard, allowPrivateUrls }));
}
