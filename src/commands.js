import { LOOP_MODES } from './player.js';
import { isYoutubeBlock, resolveTracks, searchTracks, YOUTUBE_DOCS_URL } from './ytdlp.js';
import { formatDuration, safe, trackLink } from './format.js';

const LOOP_ALIASES = { off: 'off', one: 'one', track: 'one', all: 'all', queue: 'all' };

/**
 * Chat commands. Each handler receives (ctx, argText) where ctx has
 * { invokerId, invokerName, invokerUid, reply(text) }.
 *
 * Returns a Map of every accepted command name/alias -> command.
 */
export function createCommands(bot) {
  const { player, config, i18n } = bot;
  const { t } = i18n;
  const p = config.bot.prefix;
  const searchResults = new Map(); // invokerUid -> tracks

  const length = (track) => (track.isLive ? t('live') : formatDuration(track.duration));

  async function enqueue(ctx, input, { front = false } = {}) {
    if (!input) return ctx.reply(t('usagePlay'));
    if (player.queue.length >= config.player.maxQueue) return ctx.reply(t('queueFull', { max: config.player.maxQueue }));

    let result;
    try {
      const started = Date.now();
      result = await resolveTracks(input, config.player);
      bot.recordResolve?.(Date.now() - started);
    } catch (err) {
      if (err.busy) return ctx.reply(t('busy'));
      if (isYoutubeBlock(err.message)) return ctx.reply(t('youtubeBlocked', { url: YOUTUBE_DOCS_URL }));
      return ctx.reply(t('notFound', { reason: safe(err.message) }));
    }
    return addTracks(ctx, result.tracks, { front, playlistTitle: result.playlistTitle });
  }

  function addTracks(ctx, found, { front = false, playlistTitle = null } = {}) {
    const max = config.player.maxTrackDuration;
    let tracks = found.filter((tr) => !max || tr.isLive || !tr.duration || tr.duration <= max);
    const tooLong = found.length - tracks.length;
    tracks = tracks.slice(0, config.player.maxQueue - player.queue.length);
    if (tracks.length === 0) {
      return ctx.reply(tooLong ? t('tooLong', { max: formatDuration(max) }) : t('noResults'));
    }

    const requested = tracks.map((tr) => ({ ...tr, requestedBy: ctx.invokerName }));
    const wasIdle = !player.isPlaying;
    const position = front ? 1 : player.queue.length + 1;
    player.add(requested, { front });

    if (tracks.length > 1) {
      const skipped = tooLong ? t('tooLongSkipped', { count: tooLong }) : '';
      const msg = playlistTitle
        ? t('playlistAddedFrom', { count: tracks.length, name: `[b]${safe(playlistTitle)}[/b]` })
        : t('playlistAdded', { count: tracks.length });
      return ctx.reply(msg.replace(/\.$/, `${skipped}.`));
    }
    const vars = { track: trackLink(tracks[0]), length: length(tracks[0]) };
    // When idle the track starts right away and the 'now playing' announcement covers it.
    if (wasIdle && config.bot.announceTracks) return undefined;
    if (wasIdle) return ctx.reply(t('playingNow', vars));
    return ctx.reply(t('queued', { ...vars, position }));
  }

  function parseIndex(arg, max) {
    const n = Number.parseInt(arg, 10);
    return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
  }

  // `names[0]` is the canonical English name; i18n.commandAliases can add more.
  const commands = [
    {
      names: ['play', 'p'],
      run: (ctx, arg) => enqueue(ctx, arg),
    },
    {
      names: ['playnext', 'pn'],
      run: (ctx, arg) => enqueue(ctx, arg, { front: true }),
    },
    {
      names: ['search', 'find'],
      run: async (ctx, arg) => {
        if (!arg) return ctx.reply(t('usageSearch'));
        let results;
        try {
          results = await searchTracks(arg, { ...config.player, count: 5 });
        } catch (err) {
          if (err.busy) return ctx.reply(t('busy'));
          if (isYoutubeBlock(err.message)) return ctx.reply(t('youtubeBlocked', { url: YOUTUBE_DOCS_URL }));
          return ctx.reply(t('searchFailed', { reason: safe(err.message) }));
        }
        if (results.length === 0) return ctx.reply(t('noResults'));
        searchResults.set(ctx.invokerUid, results);
        const lines = results.map((tr, i) => `[b]${i + 1}.[/b] ${trackLink(tr)} (${length(tr)})`);
        return ctx.reply(`${t('searchResults')}\n${lines.join('\n')}`);
      },
    },
    {
      names: ['pick'],
      run: (ctx, arg) => {
        const results = searchResults.get(ctx.invokerUid);
        if (!results) return ctx.reply(t('searchFirst'));
        const n = parseIndex(arg, results.length);
        if (!n) return ctx.reply(t('pickRange', { max: results.length }));
        if (player.queue.length >= config.player.maxQueue) return ctx.reply(t('queueFull', { max: config.player.maxQueue }));
        return addTracks(ctx, [results[n - 1]]);
      },
    },
    {
      names: ['skip', 's', 'next'],
      run: async (ctx) => {
        if (!player.current) return ctx.reply(t('nothingPlaying'));
        // reply first so it shows up before the next track's announcement
        await ctx.reply(t('skipped', { title: safe(player.current.title) }));
        player.skip();
        return undefined;
      },
    },
    {
      names: ['stop'],
      run: (ctx) => {
        player.stop();
        return ctx.reply(t('stopped'));
      },
    },
    {
      names: ['pause'],
      run: (ctx) => {
        if (!player.pause()) return ctx.reply(player.paused ? t('alreadyPaused') : t('nothingPlaying'));
        bot.setTransmitting(false);
        return ctx.reply(t('paused'));
      },
    },
    {
      names: ['resume', 'unpause'],
      run: (ctx) => {
        if (!player.resume()) return ctx.reply(t('notPaused'));
        bot.setTransmitting(true);
        return ctx.reply(t('resumed'));
      },
    },
    {
      names: ['np', 'now', 'nowplaying'],
      run: (ctx) => {
        const tr = player.current;
        if (!tr) return ctx.reply(t('nothingPlaying'));
        return ctx.reply(
          t('nowPlayingDetail', {
            track: trackLink(tr),
            elapsed: formatDuration(player.elapsed()),
            length: length(tr),
            state: player.paused ? t('pausedTag') : '',
            user: safe(tr.requestedBy),
          }),
        );
      },
    },
    {
      names: ['queue', 'q', 'list'],
      run: (ctx) => {
        const lines = [];
        if (player.current) lines.push(`▶ ${trackLink(player.current)} (${length(player.current)})`);
        const shown = player.queue.slice(0, 15);
        shown.forEach((tr, i) => lines.push(`[b]${i + 1}.[/b] ${trackLink(tr)} (${length(tr)}) — ${safe(tr.requestedBy)}`));
        if (player.queue.length > shown.length) lines.push(t('queueMore', { count: player.queue.length - shown.length }));
        if (lines.length === 0) return ctx.reply(t('queueEmpty'));
        const total = player.queue.reduce((sum, tr) => sum + (tr.duration || 0), 0);
        lines.push(
          t('queueTotal', {
            count: player.queue.length,
            duration: formatDuration(total),
            loop: t(`loopModes.${player.loop}`),
          }),
        );
        return ctx.reply(lines.join('\n'));
      },
    },
    {
      names: ['remove', 'rm'],
      run: (ctx, arg) => {
        if (player.queue.length === 0) return ctx.reply(t('queueEmpty'));
        const n = parseIndex(arg, player.queue.length);
        if (!n) return ctx.reply(t('pickRange', { max: player.queue.length }));
        const removed = player.remove(n);
        return ctx.reply(t('removed', { title: safe(removed.title) }));
      },
    },
    {
      names: ['clear'],
      run: (ctx) => {
        const count = player.clear();
        return ctx.reply(t('cleared', { count }));
      },
    },
    {
      names: ['shuffle'],
      run: (ctx) => {
        player.shuffle();
        return ctx.reply(t('shuffled'));
      },
    },
    {
      names: ['loop', 'repeat'],
      run: (ctx, arg) => {
        if (arg) {
          const key = arg.toLowerCase();
          const mode = LOOP_ALIASES[key] ?? i18n.loopAliases[key];
          if (!mode) return ctx.reply(t('invalidLoop', { modes: LOOP_MODES.join(', ') }));
          player.loop = mode;
        } else {
          player.loop = LOOP_MODES[(LOOP_MODES.indexOf(player.loop) + 1) % LOOP_MODES.length];
        }
        return ctx.reply(t('loopSet', { mode: t(`loopModes.${player.loop}`) }));
      },
    },
    {
      names: ['vol', 'volume', 'v'],
      run: async (ctx, arg) => {
        if (!arg) return ctx.reply(t('volume', { volume: player.volume }));
        const n = Number.parseInt(arg.replace('%', ''), 10);
        if (!Number.isInteger(n) || n < 0 || n > 100) return ctx.reply(t('volumeRange'));
        await player.setVolume(n);
        return ctx.reply(t('volume', { volume: player.volume }));
      },
    },
    {
      names: ['join', 'come'],
      run: async (ctx) => {
        try {
          await bot.moveToClientChannel(ctx.invokerId);
          return ctx.reply(t('joined'));
        } catch (err) {
          return ctx.reply(t('joinFailed', { reason: safe(err.queryMessage || err.message) }));
        }
      },
    },
    {
      names: ['whoami', 'me', 'id'],
      run: async (ctx) => {
        let groups = '?';
        try {
          groups = (await bot.clientInfo(ctx.invokerId)).groups.join(', ') || '-';
        } catch {
          // not visible to the bot; the unique ID from the message is still useful
        }
        return ctx.reply(t('whoami', { name: safe(ctx.invokerName), uid: ctx.invokerUid, groups }));
      },
    },
    {
      names: ['help', 'h', 'commands'],
      run: (ctx) => {
        const lines = commands.map((c) => {
          const name = c.names[0];
          const usage = t(`usage.${name}`);
          const args = usage === `usage.${name}` ? '' : ` ${usage}`;
          return `[b]${p}${name}${args}[/b] — ${t(`help.${name}`)}`;
        });
        return ctx.reply(`${t('commandsTitle')}\n${lines.join('\n')}`);
      },
    },
  ];

  const byName = new Map();
  for (const cmd of commands) {
    const aliases = i18n.commandAliases[cmd.names[0]] ?? [];
    for (const name of [...cmd.names, ...aliases]) byName.set(name.toLowerCase(), cmd);
  }
  return byName;
}
