import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Common yt-dlp flags. Node is in the image, so use it as yt-dlp's JS runtime (needed for YouTube). */
export function baseArgs({ cookiesFile } = {}) {
  const args = ['--no-warnings', '--js-runtimes', 'node'];
  if (cookiesFile) args.push('--cookies', cookiesFile);
  return args;
}

export function isUrl(text) {
  return /^https?:\/\/\S+$/i.test(text);
}

function toTrack(entry) {
  if (!entry) return null;
  let url = entry.webpage_url || entry.original_url || entry.url;
  if ((!url || !isUrl(url)) && entry.id && /youtube/i.test(entry.ie_key || entry.extractor || 'youtube')) {
    url = `https://www.youtube.com/watch?v=${entry.id}`;
  }
  if (!url) return null;
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
  const args = [...baseArgs(opts), '-J', '--flat-playlist', '--no-playlist', ...extraArgs, target];
  try {
    const { stdout } = await execFileAsync('yt-dlp', args, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    return JSON.parse(stdout);
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    const reason = stderr.split('\n').reverse().find((l) => l.startsWith('ERROR:')) || stderr.trim().split('\n').pop();
    throw new Error(reason ? reason.replace(/^ERROR:\s*/, '') : 'yt-dlp failed');
  }
}

/**
 * Resolves user input into tracks:
 *  - a video URL           -> 1 track ("&list=" in a watch URL is ignored)
 *  - a playlist URL        -> up to maxPlaylistItems tracks
 *  - anything else         -> first YouTube search result
 */
export async function resolveTracks(input, { maxPlaylistItems = 50, cookiesFile } = {}) {
  const target = isUrl(input) ? input : `ytsearch1:${input}`;
  const json = await dumpJson(target, ['--playlist-end', String(maxPlaylistItems)], { cookiesFile });
  const entries = json._type === 'playlist' ? json.entries || [] : [json];
  const tracks = entries.map(toTrack).filter(Boolean);
  return { tracks, playlistTitle: json._type === 'playlist' && isUrl(input) ? json.title : null };
}

export async function searchTracks(query, { count = 5, cookiesFile } = {}) {
  const json = await dumpJson(`ytsearch${count}:${query}`, [], { cookiesFile });
  return (json.entries || []).map(toTrack).filter(Boolean);
}
