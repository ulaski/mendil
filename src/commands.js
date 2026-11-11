import { LOOP_MODES } from './player.js';
import { resolveTracks, searchTracks } from './ytdlp.js';
import { formatDuration, safe, trackLength, trackLink } from './format.js';

const LOOP_ALIASES = {
  off: 'off', kapali: 'off', kapalı: 'off', kapat: 'off',
  one: 'one', track: 'one', sarki: 'one', şarkı: 'one', tek: 'one',
  all: 'all', queue: 'all', liste: 'all', hepsi: 'all',
};
const LOOP_LABELS = { off: 'kapalı', one: 'şarkı', all: 'liste' };

/**
 * Chat commands. Each handler receives (ctx, argText) where ctx has
 * { invokerId, invokerName, invokerUid, reply(text) }.
 */
export function createCommands(bot) {
  const { player, config } = bot;
  const p = config.bot.prefix;
  const searchResults = new Map(); // invokerUid -> tracks

  async function enqueue(ctx, input, { front = false } = {}) {
    if (!input) return ctx.reply(`Kullanım: ${p}play <YouTube linki veya arama>`);
    const free = config.player.maxQueue - player.queue.length;
    if (free <= 0) return ctx.reply(`Kuyruk dolu (en fazla ${config.player.maxQueue} şarkı).`);

    let result;
    try {
      result = await resolveTracks(input, config.player);
    } catch (err) {
      return ctx.reply(`Bulunamadı: ${safe(err.message)}`);
    }
    return addTracks(ctx, result.tracks, { front, playlistTitle: result.playlistTitle });
  }

  function addTracks(ctx, found, { front = false, playlistTitle = null } = {}) {
    const max = config.player.maxTrackDuration;
    let tracks = found.filter((t) => !max || t.isLive || !t.duration || t.duration <= max);
    const tooLong = found.length - tracks.length;
    tracks = tracks.slice(0, config.player.maxQueue - player.queue.length);
    if (tracks.length === 0) {
      return ctx.reply(tooLong ? `Şarkı çok uzun (en fazla ${formatDuration(max)}).` : 'Hiçbir sonuç bulunamadı.');
    }

    const requested = tracks.map((t) => ({ ...t, requestedBy: ctx.invokerName }));
    const wasIdle = !player.isPlaying;
    const position = front ? 1 : player.queue.length + 1;
    player.add(requested, { front });

    if (tracks.length > 1) {
      const name = playlistTitle ? `[b]${safe(playlistTitle)}[/b] listesinden ` : '';
      const skipped = tooLong ? ` (${tooLong} uzun şarkı atlandı)` : '';
      return ctx.reply(`${name}${tracks.length} şarkı kuyruğa eklendi${skipped}.`);
    }
    // When idle, the track starts right away and the 'trackStart' announcement covers it.
    if (wasIdle && config.bot.announceTracks) return undefined;
    if (wasIdle) return ctx.reply(`Çalıyor: ${trackLink(tracks[0])} (${trackLength(tracks[0])})`);
    return ctx.reply(`Kuyruğa eklendi (#${position}): ${trackLink(tracks[0])} (${trackLength(tracks[0])})`);
  }

  function parseIndex(arg, length) {
    const n = Number.parseInt(arg, 10);
    return Number.isInteger(n) && n >= 1 && n <= length ? n : null;
  }

  const commands = [
    {
      names: ['play', 'p', 'cal', 'çal'],
      usage: 'play <link | arama>',
      help: 'Çalar veya kuyruğun sonuna ekler (YouTube linki, oynatma listesi ya da arama)',
      run: (ctx, arg) => enqueue(ctx, arg),
    },
    {
      names: ['playnext', 'pn', 'siradaki', 'sıradaki'],
      usage: 'playnext <link | arama>',
      help: 'Kuyruğun en başına ekler',
      run: (ctx, arg) => enqueue(ctx, arg, { front: true }),
    },
    {
      names: ['search', 'ara'],
      usage: 'search <arama>',
      help: "YouTube'da arar, 5 sonuç listeler",
      run: async (ctx, arg) => {
        if (!arg) return ctx.reply(`Kullanım: ${p}search <arama>`);
        let results;
        try {
          results = await searchTracks(arg, { count: 5, cookiesFile: config.player.cookiesFile });
        } catch (err) {
          return ctx.reply(`Arama başarısız: ${safe(err.message)}`);
        }
        if (results.length === 0) return ctx.reply('Sonuç yok.');
        searchResults.set(ctx.invokerUid, results);
        const lines = results.map((t, i) => `[b]${i + 1}.[/b] ${trackLink(t)} (${trackLength(t)})`);
        return ctx.reply(`Sonuçlar — seçmek için ${p}pick <numara>:\n${lines.join('\n')}`);
      },
    },
    {
      names: ['pick', 'sec', 'seç'],
      usage: 'pick <numara>',
      help: `${p}search sonucundan seçip kuyruğa ekler`,
      run: (ctx, arg) => {
        const results = searchResults.get(ctx.invokerUid);
        if (!results) return ctx.reply(`Önce ${p}search ile arama yap.`);
        const n = parseIndex(arg, results.length);
        if (!n) return ctx.reply(`1 ile ${results.length} arasında bir numara gir.`);
        if (player.queue.length >= config.player.maxQueue) return ctx.reply('Kuyruk dolu.');
        return addTracks(ctx, [results[n - 1]]);
      },
    },
    {
      names: ['skip', 's', 'next', 'gec', 'geç'],
      usage: 'skip',
      help: 'Çalan şarkıyı geçer',
      run: async (ctx) => {
        if (!player.current) return ctx.reply('Şu an bir şey çalmıyor.');
        // reply first so it shows up before the next track's announcement
        await ctx.reply(`Geçildi: ${safe(player.current.title)}`);
        player.skip();
        return undefined;
      },
    },
    {
      names: ['stop', 'dur'],
      usage: 'stop',
      help: 'Durdurur ve kuyruğu temizler',
      run: (ctx) => {
        player.stop();
        return ctx.reply('Durduruldu, kuyruk temizlendi.');
      },
    },
    {
      names: ['pause', 'duraklat'],
      usage: 'pause',
      help: 'Duraklatır',
      run: (ctx) => {
        if (!player.pause()) return ctx.reply(player.paused ? 'Zaten duraklatıldı.' : 'Şu an bir şey çalmıyor.');
        bot.setTransmitting(false);
        return ctx.reply(`Duraklatıldı. Devam için ${p}resume`);
      },
    },
    {
      names: ['resume', 'devam'],
      usage: 'resume',
      help: 'Devam ettirir',
      run: (ctx) => {
        if (!player.resume()) return ctx.reply('Duraklatılmış bir şarkı yok.');
        bot.setTransmitting(true);
        return ctx.reply('Devam ediliyor.');
      },
    },
    {
      names: ['np', 'now', 'nowplaying', 'simdi', 'şimdi'],
      usage: 'np',
      help: 'Şu an çalan şarkı',
      run: (ctx) => {
        const t = player.current;
        if (!t) return ctx.reply('Şu an bir şey çalmıyor.');
        const state = player.paused ? ' [duraklatıldı]' : '';
        return ctx.reply(
          `Çalıyor: ${trackLink(t)} — ${formatDuration(player.elapsed())} / ${trackLength(t)}${state} — isteyen: ${safe(t.requestedBy)}`,
        );
      },
    },
    {
      names: ['queue', 'q', 'list', 'liste', 'kuyruk'],
      usage: 'queue',
      help: 'Kuyruğu gösterir',
      run: (ctx) => {
        const lines = [];
        if (player.current) lines.push(`▶ ${trackLink(player.current)} (${trackLength(player.current)})`);
        const shown = player.queue.slice(0, 15);
        shown.forEach((t, i) => lines.push(`[b]${i + 1}.[/b] ${trackLink(t)} (${trackLength(t)}) — ${safe(t.requestedBy)}`));
        if (player.queue.length > shown.length) lines.push(`… ve ${player.queue.length - shown.length} şarkı daha`);
        if (lines.length === 0) return ctx.reply('Kuyruk boş.');
        const total = player.queue.reduce((sum, t) => sum + (t.duration || 0), 0);
        lines.push(`Toplam ${player.queue.length} şarkı, ~${formatDuration(total)} — tekrar: ${LOOP_LABELS[player.loop]}`);
        return ctx.reply(lines.join('\n'));
      },
    },
    {
      names: ['remove', 'rm', 'sil'],
      usage: 'remove <numara>',
      help: 'Kuyruktan şarkı siler',
      run: (ctx, arg) => {
        const n = parseIndex(arg, player.queue.length);
        if (!n) return ctx.reply(player.queue.length ? `1 ile ${player.queue.length} arasında bir numara gir.` : 'Kuyruk boş.');
        const [removed] = player.queue.splice(n - 1, 1);
        return ctx.reply(`Silindi: ${safe(removed.title)}`);
      },
    },
    {
      names: ['clear', 'temizle'],
      usage: 'clear',
      help: 'Kuyruğu temizler (çalan şarkı devam eder)',
      run: (ctx) => {
        const n = player.queue.length;
        player.queue = [];
        return ctx.reply(`${n} şarkı kuyruktan silindi.`);
      },
    },
    {
      names: ['shuffle', 'karistir', 'karıştır'],
      usage: 'shuffle',
      help: 'Kuyruğu karıştırır',
      run: (ctx) => {
        player.shuffle();
        return ctx.reply('Kuyruk karıştırıldı.');
      },
    },
    {
      names: ['loop', 'repeat', 'tekrar'],
      usage: 'loop [off|one|all]',
      help: 'Tekrar modu: kapalı / şarkı / liste',
      run: (ctx, arg) => {
        if (arg) {
          const mode = LOOP_ALIASES[arg.toLowerCase()];
          if (!mode) return ctx.reply(`Geçersiz mod. Seçenekler: ${LOOP_MODES.join(', ')}`);
          player.loop = mode;
        } else {
          player.loop = LOOP_MODES[(LOOP_MODES.indexOf(player.loop) + 1) % LOOP_MODES.length];
        }
        return ctx.reply(`Tekrar: ${LOOP_LABELS[player.loop]}`);
      },
    },
    {
      names: ['vol', 'volume', 'ses'],
      usage: 'vol [0-100]',
      help: 'Ses seviyesini gösterir / ayarlar',
      run: async (ctx, arg) => {
        if (!arg) return ctx.reply(`Ses: ${player.volume}%`);
        const n = Number.parseInt(arg.replace('%', ''), 10);
        if (!Number.isInteger(n) || n < 0 || n > 100) return ctx.reply('0 ile 100 arasında bir değer gir.');
        await player.setVolume(n);
        return ctx.reply(`Ses: ${player.volume}%`);
      },
    },
    {
      names: ['join', 'gel'],
      usage: 'join',
      help: 'Botu bulunduğun kanala çeker',
      run: async (ctx) => {
        try {
          await bot.moveToClientChannel(ctx.invokerId);
          return ctx.reply('Geldim!');
        } catch (err) {
          return ctx.reply(`Kanala geçemedim: ${safe(err.queryMessage || err.message)}`);
        }
      },
    },
    {
      names: ['help', 'h', 'yardim', 'yardım', 'komutlar'],
      usage: 'help',
      help: 'Bu liste',
      run: (ctx) => {
        const lines = commands.map((c) => `[b]${p}${c.usage}[/b] — ${c.help}`);
        return ctx.reply(`Komutlar:\n${lines.join('\n')}`);
      },
    },
  ];

  const byName = new Map();
  for (const cmd of commands) for (const name of cmd.names) byName.set(name, cmd);
  return byName;
}
