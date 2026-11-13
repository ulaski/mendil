import { isYoutubeBlock, resolveTracks, searchTracks } from './ytdlp.js';
import { isSpotifyInput, pickYoutubeMatch, resolveSpotify } from './spotify.js';

/**
 * Song requests, shared by chat commands and the web panel. Results are plain objects;
 * each caller turns them into its own messages.
 *
 * request() resolves to one of:
 *   { ok: true, added: [tracks], position, wasIdle, playlistTitle, tooLong }
 * Spotify links become tracks with `search` set (see spotify.js); findOnYoutube() resolves them.
 *   { ok: false, error: 'empty' | 'queueFull' | 'userLimit' | 'busy' | 'blockedUrl' | 'youtubeBlocked'
 *                       | 'notFound' | 'tooLong' | 'noResults', reason? }
 * `limited` counts tracks left out because of MAX_QUEUE_PER_USER (pass `limit: true` to apply it).
 */
export function createRequests(bot) {
  const { player, config } = bot;

  function failure(err) {
    if (err.busy) return { ok: false, error: 'busy' };
    if (err.blockedUrl) return { ok: false, error: 'blockedUrl' };
    if (isYoutubeBlock(err.message)) return { ok: false, error: 'youtubeBlocked' };
    return { ok: false, error: 'notFound', reason: err.message };
  }

  /** Songs `uid` has waiting in the queue, and how many more MAX_QUEUE_PER_USER allows. */
  function userRoom(uid) {
    const max = config.player.maxQueuePerUser;
    if (!max || !uid) return Infinity;
    return Math.max(0, max - player.queue.filter((tr) => tr.requesterUid === uid).length);
  }

  /** Adds already resolved tracks, respecting MAX_TRACK_DURATION, MAX_QUEUE and MAX_QUEUE_PER_USER. */
  function admit(found, { front = false, requestedBy, requesterUid = null, playlistTitle = null, limit = false } = {}) {
    if (player.queue.length >= config.player.maxQueue) return { ok: false, error: 'queueFull' };
    const room = limit ? userRoom(requesterUid) : Infinity;
    if (room === 0) return { ok: false, error: 'userLimit', max: config.player.maxQueuePerUser };
    const max = config.player.maxTrackDuration;
    let tracks = found.filter((tr) => !max || tr.isLive || !tr.duration || tr.duration <= max);
    const tooLong = found.length - tracks.length;
    tracks = tracks.slice(0, config.player.maxQueue - player.queue.length);
    const limited = Math.max(0, tracks.length - room);
    if (limited) tracks = tracks.slice(0, room);
    if (tracks.length === 0) return { ok: false, error: tooLong ? 'tooLong' : 'noResults' };

    const wasIdle = !player.isPlaying;
    const position = front ? 1 : player.queue.length + 1;
    const added = tracks.map((tr) => ({ ...tr, requestedBy, requesterUid }));
    player.add(added, { front });
    return { ok: true, added, position, wasIdle, playlistTitle, tooLong, limited, max: config.player.maxQueuePerUser };
  }

  /** A link, a playlist or search terms -> tracks in the queue. */
  async function request(input, { front = false, requestedBy, requesterUid = null, limit = false } = {}) {
    if (!input) return { ok: false, error: 'empty' };
    if (player.queue.length >= config.player.maxQueue) return { ok: false, error: 'queueFull' };
    // Before the lookup, so a full allowance doesn't cost a yt-dlp call.
    if (limit && userRoom(requesterUid) === 0) return { ok: false, error: 'userLimit', max: config.player.maxQueuePerUser };
    let result;
    try {
      if (isSpotifyInput(input)) {
        // Only the song list comes from Spotify; each song is looked up on YouTube just before it plays.
        const spotify = await resolveSpotify(input);
        result = { tracks: spotify.tracks.slice(0, config.player.maxPlaylistItems), playlistTitle: spotify.title };
      } else {
        const started = Date.now();
        result = await resolveTracks(input, config.player);
        bot.recordResolve?.(Date.now() - started);
      }
    } catch (err) {
      return failure(err);
    }
    return admit(result.tracks, { front, requestedBy, requesterUid, playlistTitle: result.playlistTitle, limit });
  }

  /** The YouTube version of a Spotify song (a track with `search`): { url, duration }. */
  async function findOnYoutube(track) {
    const results = await searchTracks(track.search, { ...config.player, count: 3 });
    const match = pickYoutubeMatch(results, track.duration);
    if (!match) throw new Error('not found on YouTube');
    return { url: match.url, duration: match.duration ?? track.duration };
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

  return { request, admit, search, findOnYoutube };
}
