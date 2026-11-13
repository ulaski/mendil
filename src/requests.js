import { isYoutubeBlock, resolveTracks, searchTracks } from './ytdlp.js';

/**
 * Song requests, shared by chat commands and the web panel. Results are plain objects;
 * each caller turns them into its own messages.
 *
 * request() resolves to one of:
 *   { ok: true, added: [tracks], position, wasIdle, playlistTitle, tooLong }
 *   { ok: false, error: 'empty' | 'queueFull' | 'busy' | 'blockedUrl' | 'youtubeBlocked'
 *                       | 'notFound' | 'tooLong' | 'noResults', reason? }
 */
export function createRequests(bot) {
  const { player, config } = bot;

  function failure(err) {
    if (err.busy) return { ok: false, error: 'busy' };
    if (err.blockedUrl) return { ok: false, error: 'blockedUrl' };
    if (isYoutubeBlock(err.message)) return { ok: false, error: 'youtubeBlocked' };
    return { ok: false, error: 'notFound', reason: err.message };
  }

  /** Adds already resolved tracks, respecting MAX_TRACK_DURATION and MAX_QUEUE. */
  function admit(found, { front = false, requestedBy, requesterUid = null, playlistTitle = null } = {}) {
    if (player.queue.length >= config.player.maxQueue) return { ok: false, error: 'queueFull' };
    const max = config.player.maxTrackDuration;
    let tracks = found.filter((tr) => !max || tr.isLive || !tr.duration || tr.duration <= max);
    const tooLong = found.length - tracks.length;
    tracks = tracks.slice(0, config.player.maxQueue - player.queue.length);
    if (tracks.length === 0) return { ok: false, error: tooLong ? 'tooLong' : 'noResults' };

    const wasIdle = !player.isPlaying;
    const position = front ? 1 : player.queue.length + 1;
    const added = tracks.map((tr) => ({ ...tr, requestedBy, requesterUid }));
    player.add(added, { front });
    return { ok: true, added, position, wasIdle, playlistTitle, tooLong };
  }

  /** A link, a playlist or search terms -> tracks in the queue. */
  async function request(input, { front = false, requestedBy, requesterUid = null } = {}) {
    if (!input) return { ok: false, error: 'empty' };
    if (player.queue.length >= config.player.maxQueue) return { ok: false, error: 'queueFull' };
    let result;
    try {
      const started = Date.now();
      result = await resolveTracks(input, config.player);
      bot.recordResolve?.(Date.now() - started);
    } catch (err) {
      return failure(err);
    }
    return admit(result.tracks, { front, requestedBy, requesterUid, playlistTitle: result.playlistTitle });
  }

  /** The top YouTube results for some search terms: { ok, results } or a failure. */
  async function search(query, count = 5) {
    try {
      // Searches also return channels and playlists (no duration); only offer playable tracks.
      const results = (await searchTracks(query, { ...config.player, count: count + 2 }))
        .filter((t) => t.isLive || Number.isFinite(t.duration))
        .slice(0, count);
      return { ok: true, results };
    } catch (err) {
      return failure(err);
    }
  }

  return { request, admit, search };
}
