import { LOOP_MODES } from './player.js';
import { YOUTUBE_DOCS_URL } from './ytdlp.js';
import { createRequests } from './requests.js';
import { formatDuration, safe, trackLink } from './format.js';
import { mayManage, queueLimitApplies, ROLE_RANK } from './roles.js';
import { findStation } from './radio.js';
import { BlockedUrlError, UrlGuard } from './netguard.js';

const LOOP_ALIASES = { off: 'off', one: 'one', track: 'one', all: 'all', queue: 'all' };

/**
 * "1:30", "1:02:03" or "90" -> seconds from the start; "+30" / "-10" -> relative to `now`.
 * Returns null for anything else.
 */
export function parseSeekTime(text, now = 0) {
  const m = String(text ?? '').trim().match(/^([+-])?(\d+(?::[0-5]?\d){0,2})$/);
  if (!m) return null;
  const seconds = m[2].split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  if (m[1] === '+') return now + seconds;
  if (m[1] === '-') return Math.max(0, now - seconds);
  return seconds;
}

/**
 * Chat commands. Each handler receives (ctx, argText) where ctx has
 * { invokerId, invokerName, invokerUid, user: {uid, name, role}, reply(text) }.
 * `role` is the least role a command needs (src/roles.js); the bot checks it before run().
 *
 * Returns a Map of every accepted command name/alias -> command.
 */
export function createCommands(bot) {
  const { player, config, i18n } = bot;
  const { t } = i18n;
  const p = config.bot.prefix;
  const searchResults = new Map(); // invokerUid -> tracks

  const length = (track) => (track.isLive ? t('live') : formatDuration(track.duration));
  const urlGuard = new UrlGuard({ allowPrivate: config.player.allowPrivateUrls });
  const stationList = () => config.radio.stations.map((s) => s.name).join(', ');

  const requests = createRequests(bot);

  /** Turns a request() result into a chat reply. */
  function replyTo(ctx, result) {
    if (!result.ok) {
      switch (result.error) {
        case 'empty': return ctx.reply(t('usagePlay'));
        case 'queueFull': return ctx.reply(t('queueFull', { max: config.player.maxQueue }));
        case 'userLimit': return ctx.reply(t('userLimit', { max: result.max }));
        case 'busy': return ctx.reply(t('busy'));
        case 'blockedUrl': return ctx.reply(t('blockedUrl'));
        case 'youtubeBlocked': return ctx.reply(t('youtubeBlocked', { url: YOUTUBE_DOCS_URL }));
        case 'tooLong': return ctx.reply(t('tooLong', { max: formatDuration(config.player.maxTrackDuration) }));
        case 'noResults': return ctx.reply(t('noResults'));
        default: return ctx.reply(t('notFound', { reason: safe(result.reason ?? '') }));
      }
    }
    const { added, position, wasIdle, playlistTitle, tooLong, limited } = result;
    if (added.length > 1 || limited) {
      const skipped = (tooLong ? t('tooLongSkipped', { count: tooLong }) : '') + (limited ? t('userLimitSkipped', { count: limited, max: result.max }) : '');
      const msg = playlistTitle
        ? t('playlistAddedFrom', { count: added.length, name: `[b]${safe(playlistTitle)}[/b]` })
        : t('playlistAdded', { count: added.length });
      return ctx.reply(msg.replace(/\.$/, `${skipped}.`));
    }
    const vars = { track: trackLink(added[0]), length: length(added[0]) };
    // When idle the track starts right away and the 'now playing' announcement covers it.
    if (wasIdle && config.bot.announceTracks) return undefined;
    if (wasIdle) return ctx.reply(t('playingNow', vars));
    return ctx.reply(t('queued', { ...vars, position }));
  }

  async function enqueue(ctx, input, { front = false } = {}) {
    const limit = queueLimitApplies(config.bot, ctx.user);
    return replyTo(ctx, await requests.request(input, { front, requestedBy: ctx.invokerName, requesterUid: ctx.invokerUid, limit }));
  }

  function parseIndex(arg, max) {
    const n = Number.parseInt(arg, 10);
    return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
  }

  // `names[0]` is the canonical English name; i18n.commandAliases can add more.
  const commands = [
    {
      names: ['play', 'p'],
      role: 'listener',
      run: (ctx, arg) => enqueue(ctx, arg),
    },
    {
      names: ['playnext', 'pn'],
      role: 'admin',
      run: (ctx, arg) => enqueue(ctx, arg, { front: true }),
    },
    {
      names: ['search', 'find'],
      role: 'listener',
      run: async (ctx, arg) => {
        if (!arg) return ctx.reply(t('usageSearch'));
        const found = await requests.search(arg);
        if (!found.ok) {
          if (found.error === 'busy') return ctx.reply(t('busy'));
          if (found.error === 'youtubeBlocked') return ctx.reply(t('youtubeBlocked', { url: YOUTUBE_DOCS_URL }));
          return ctx.reply(t('searchFailed', { reason: safe(found.reason ?? '') }));
        }
        const { results } = found;
        if (results.length === 0) return ctx.reply(t('noResults'));
        searchResults.set(ctx.invokerUid, results);
        const lines = results.map((tr, i) => `[b]${i + 1}.[/b] ${trackLink(tr)} (${length(tr)})`);
        return ctx.reply(`${t('searchResults')}\n${lines.join('\n')}`);
      },
    },
    {
      names: ['pick'],
      role: 'listener',
      run: (ctx, arg) => {
        const results = searchResults.get(ctx.invokerUid);
        if (!results) return ctx.reply(t('searchFirst'));
        const n = parseIndex(arg, results.length);
        if (!n) return ctx.reply(t('pickRange', { max: results.length }));
        const limit = queueLimitApplies(config.bot, ctx.user);
        return replyTo(ctx, requests.admit([results[n - 1]], { requestedBy: ctx.invokerName, requesterUid: ctx.invokerUid, limit }));
      },
    },
    {
      names: ['skip', 's', 'next'],
      role: 'listener',
      run: async (ctx) => {
        if (!player.current) return ctx.reply(t('nothingPlaying'));
        if (player.current.radio && player.queue.length === 0) return ctx.reply(t('radioSkip'));
        if (!mayManage(ctx.user, player.current)) return ctx.reply(t('notYours'));
        // reply first so it shows up before the next track's announcement
        await ctx.reply(t('skipped', { title: safe(player.current.title) }));
        player.skip();
        return undefined;
      },
    },
    {
      names: ['stop'],
      role: 'admin',
      run: (ctx) => {
        player.stop();
        return ctx.reply(t('stopped'));
      },
    },
    {
      names: ['pause'],
      role: 'admin',
      run: (ctx) => {
        if (!player.pause()) return ctx.reply(player.paused ? t('alreadyPaused') : t('nothingPlaying'));
        bot.setTransmitting(false);
        return ctx.reply(t('paused'));
      },
    },
    {
      names: ['resume', 'unpause'],
      role: 'admin',
      run: (ctx) => {
        if (!player.resume()) return ctx.reply(t('notPaused'));
        bot.setTransmitting(true);
        return ctx.reply(t('resumed'));
      },
    },
    {
      names: ['np', 'now', 'nowplaying'],
      role: 'listener',
      run: (ctx) => {
        const tr = player.current;
        if (!tr) return ctx.reply(t('nothingPlaying'));
        if (tr.radio) return ctx.reply(t('radioNow', { station: trackLink(tr), title: safe(tr.streamTitle ?? '-') }));
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
      role: 'listener',
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
      role: 'listener',
      run: (ctx, arg) => {
        if (player.queue.length === 0) return ctx.reply(t('queueEmpty'));
        const n = parseIndex(arg, player.queue.length);
        if (!n) return ctx.reply(t('pickRange', { max: player.queue.length }));
        if (!mayManage(ctx.user, player.queue[n - 1])) return ctx.reply(t('notYours'));
        const removed = player.remove(n);
        return ctx.reply(t('removed', { title: safe(removed.title) }));
      },
    },
    {
      names: ['move', 'mv'],
      role: 'admin',
      run: (ctx, arg) => {
        const [a, b] = arg.split(/\s+/);
        const max = player.queue.length;
        if (max < 2) return ctx.reply(max ? t('moveNothing') : t('queueEmpty'));
        const from = parseIndex(a, max);
        const to = parseIndex(b, max);
        if (!from || !to) return ctx.reply(t('usageMove', { max }));
        const moved = player.move(from, to);
        return ctx.reply(t('moved', { title: safe(moved.title), position: to }));
      },
    },
    {
      names: ['seek', 'goto'],
      role: 'listener',
      run: (ctx, arg) => {
        const tr = player.current;
        if (!tr) return ctx.reply(t('nothingPlaying'));
        if (!player.seekable) return ctx.reply(t('seekLive'));
        if (!mayManage(ctx.user, tr)) return ctx.reply(t('notYours'));
        const target = parseSeekTime(arg, player.elapsed());
        if (target === null) return ctx.reply(t('usageSeek'));
        const at = player.seek(target);
        return ctx.reply(t('seeked', { time: formatDuration(at), length: formatDuration(tr.duration) }));
      },
    },
    {
      names: ['clear'],
      role: 'admin',
      run: (ctx) => {
        const count = player.clear();
        return ctx.reply(t('cleared', { count }));
      },
    },
    {
      names: ['shuffle'],
      role: 'admin',
      run: (ctx) => {
        player.shuffle();
        return ctx.reply(t('shuffled'));
      },
    },
    {
      names: ['loop', 'repeat'],
      role: 'admin',
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
      role: 'listener',
      run: async (ctx, arg) => {
        if (!arg) return ctx.reply(t('volume', { volume: player.volume }));
        if (ctx.user.role !== 'admin') return ctx.reply(t('adminOnly')); // listeners may only look
        const n = Number.parseInt(arg.replace('%', ''), 10);
        if (!Number.isInteger(n) || n < 0 || n > 100) return ctx.reply(t('volumeRange'));
        await player.setVolume(n);
        return ctx.reply(t('volume', { volume: player.volume }));
      },
    },
    {
      names: ['radio'],
      role: 'listener',
      run: async (ctx, arg) => {
        const list = stationList();
        if (!arg) {
          const lines = [player.radio ? t('radioStatus', { station: safe(player.radio.name) }) : t('radioIsOff')];
          lines.push(list ? t('radioStations', { stations: safe(list) }) : t('radioNoStations'));
          return ctx.reply(lines.join('\n'));
        }
        if (ctx.user.role !== 'admin') return ctx.reply(t('adminOnly')); // listeners may only look
        if (['off', ...(i18n.radioOffWords ?? [])].includes(arg.toLowerCase())) {
          player.setRadio(null);
          return ctx.reply(t('radioTurnedOff'));
        }
        const station = findStation(config.radio.stations, arg);
        if (!station) return ctx.reply(list ? t('radioUnknown', { name: safe(arg), stations: safe(list) }) : t('radioNoStations'));
        if (!config.radio.stations.includes(station)) {
          // A station by address, from chat: the same private-network rule as !play.
          try {
            await urlGuard.assertAllowed(station.url);
          } catch (err) {
            if (err instanceof BlockedUrlError || err.blockedUrl) return ctx.reply(t('blockedUrl'));
            return ctx.reply(t('notFound', { reason: safe(err.message) }));
          }
        }
        const waits = player.isPlaying && !player.current?.radio;
        player.setRadio(station);
        return ctx.reply(t(waits ? 'radioSetLater' : 'radioSet', { station: safe(station.name) }));
      },
    },
    {
      names: ['join', 'come'],
      role: 'admin',
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
      role: 'none',
      run: async (ctx) => {
        let groups = '?';
        try {
          groups = (await bot.clientInfo(ctx.invokerId)).groups.join(', ') || '-';
        } catch {
          // not visible to the bot; the unique ID from the message is still useful
        }
        return ctx.reply(t('whoami', { name: safe(ctx.invokerName), uid: ctx.invokerUid, groups, role: t(`roles.${ctx.user.role}`) }));
      },
    },
    {
      names: ['help', 'h', 'commands'],
      role: 'none',
      run: (ctx) => {
        // Only what this user may run; a command for admins is just noise to a listener.
        const rank = ROLE_RANK[ctx.user.role];
        const lines = commands.filter((c) => ROLE_RANK[c.role] <= Math.max(rank, ROLE_RANK.listener)).map((c) => {
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
