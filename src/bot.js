import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Player } from './player.js';
import { Prefetcher } from './prefetch.js';
import { StateStore } from './state.js';
import { StatsReporter } from './stats.js';
import { RateLimiter } from './ratelimit.js';
import { YtdlpUpdater } from './ytdlp-update.js';
import { createCommands } from './commands.js';
import { createRequests } from './requests.js';
import { createI18n } from './i18n/index.js';
import { chunkMessage, formatDuration, safe, stripBBCode, trackLink } from './format.js';
import { isYoutubeBlock, YOUTUBE_DOCS_URL } from './ytdlp.js';
import { createBackend } from './voice/index.js';

export { isProcessAlive } from './voice/classic.js';

// Commands that start a yt-dlp lookup; each user gets a few at once, then one every few seconds.
const RATE_LIMITED = new Set(['play', 'playnext', 'search']);

const WATCHDOG_INTERVAL_MS = 10_000;
const STATE_SAVE_INTERVAL_MS = 5_000;
const STATS_INTERVAL_MS = 10 * 60_000;
const GIVE_UP_DISCONNECTED_MS = 20 * 60_000; // then exit for a clean container restart

// Minimum gap between outgoing chat messages, to stay clear of the server's anti-flood.
const MESSAGE_GAP_MS = 300;

// TeamSpeak codec ids (channel_codec).
const CODECS = { 0: 'Speex Narrowband', 1: 'Speex Wideband', 2: 'Speex Ultra-Wideband', 3: 'CELT Mono', 4: 'Opus Voice', 5: 'Opus Music' };
const CODEC_OPUS_MUSIC = 5;
const MIN_MUSIC_QUALITY = 7;

// Touched every watchdog tick while everything is fine; the Docker HEALTHCHECK checks its age.
export const HEALTH_FILE = '/tmp/mendil.healthy';
// Human-readable details for `docker exec mendil cat /tmp/mendil-health.json`.
export const HEALTH_DETAILS_FILE = '/tmp/mendil-health.json';

/**
 * Everything that doesn't depend on how Mendil talks to TeamSpeak: chat commands, access
 * control, the player and its state, health and stats. The voice engine (src/voice/) owns
 * the connection.
 */
export class Bot {
  #watchdogTimer = null;
  #timers = [];
  #stopping = false;
  #watchdogBusy = false;
  #pausedByDisconnect = false;
  #restored = null; // { tracks, paused } until the restored queue has been started
  #sendQueue = Promise.resolve();
  #resolveTimes = [];
  #hinted = new Set(); // channel hints already posted ("<cid>:<issue>")
  #diagnosing = new Map(); // cid -> running check (a move triggers it twice)
  #floodWarned = false;
  #limiter = new RateLimiter(); // per user, for commands that start yt-dlp
  #stats = new StatsReporter();

  constructor(config, log, { backend } = {}) {
    this.config = config;
    this.log = log;
    this.i18n = createI18n(config.bot.language, { prefix: config.bot.prefix });
    const { t } = this.i18n;

    this.voice = backend ?? createBackend(config, log);
    const p = config.player;
    const prefetcher = p.prefetch
      ? new Prefetcher({ dir: p.prefetchDir, cookiesFile: p.cookiesFile, cacheDir: p.cacheDir, proxy: p.proxy, maxDuration: p.prefetchMaxDuration, normalize: p.normalize, log: log.child('prefetch') })
      : null;
    this.player = new Player({ ...p, output: this.voice.audio, prefetcher, log: log.child('player') });
    this.state = new StateStore(path.join(config.dataDir, 'state.json'), log.child('state'));
    this.updater = new YtdlpUpdater({
      enabled: config.ytdlp.autoUpdate,
      venv: config.ytdlp.venv,
      ytOpts: { cookiesFile: p.cookiesFile, cacheDir: p.cacheDir, proxy: p.proxy },
      smokeTestUrl: () => this.player.lastGoodUrl,
      log: log.child('yt-dlp'),
    });
    this.requests = createRequests(this);
    this.commands = createCommands(this);

    this.player.on('trackStart', (track) => {
      this.setTransmitting(true);
      if (config.bot.announceTracks) {
        const length = track.isLive ? t('live') : formatDuration(track.duration);
        this.sendChannel(t('nowPlaying', { track: trackLink(track), length, user: safe(track.requestedBy) }));
      }
    });
    this.player.on('trackError', (track, message) => {
      this.sendChannel(t('playFailed', { title: safe(track.title), reason: safe(message) }));
    });
    this.player.on('halted', (track, message) => {
      const blocked = isYoutubeBlock(message);
      if (blocked) this.log.warn(`YouTube is blocking this server; see ${YOUTUBE_DOCS_URL}`);
      this.sendChannel(blocked ? t('youtubeBlocked', { url: YOUTUBE_DOCS_URL }) : t('playbackHalted', { reason: safe(message) }));
    });
    this.player.on('idle', () => this.setTransmitting(false));

    this.voice.on('connected', ({ cid }) => this.#onConnected(cid));
    this.voice.on('disconnected', () => this.#onDisconnected());
    this.voice.on('moved', (cid) => this.#diagnoseChannel(cid));
    this.voice.on('text', (msg) => this.#onTextMessage(msg).catch((err) => this.log.error('command failed:', err)));
    this.voice.on('fatal', (reason) => this.#fatal(reason));
  }

  /** Our own client id and channel, as the voice engine knows them. */
  get me() {
    return this.voice.me;
  }

  async start() {
    const saved = this.state.load();
    if (Array.isArray(saved?.hinted)) this.#hinted = new Set(saved.hinted); // don't repeat hints after a restart
    if (saved) {
      this.#restored = this.player.restore(saved);
      if (this.#restored.tracks > 0) {
        this.log.info(`restored ${this.#restored.tracks} track(s); playback resumes once connected${this.#restored.paused ? ' (was paused)' : ''}`);
      } else {
        this.#restored = null;
      }
    }
    await this.player.init();
    this.updater.start();
    this.#timers.push(setInterval(() => this.#saveState(), STATE_SAVE_INTERVAL_MS));
    this.#timers.push(setInterval(() => this.#logStats(), STATS_INTERVAL_MS));
    this.#stats.sample(Date.now()); // baseline for the first CPU numbers
    await this.voice.start();
    await this.#watchdog();
    this.#scheduleWatchdog();
  }

  async shutdown() {
    if (this.#stopping) return;
    this.#stopping = true;
    clearTimeout(this.#watchdogTimer);
    for (const timer of this.#timers) clearInterval(timer);
    this.updater.stop();
    this.#saveState(); // before stopping playback, so the queue survives
    this.player.dispose();
    this.#markHealthy(false);
    await this.voice.stop(this.i18n.t('shuttingDown'));
  }

  recordResolve(ms) {
    this.#resolveTimes.push(ms);
    if (this.#resolveTimes.length > 100) this.#resolveTimes.shift();
  }

  #saveState() {
    const snapshot = this.player.snapshot();
    if (this.#restored?.paused) snapshot.paused = true; // restored but not started yet
    snapshot.hinted = [...this.#hinted];
    this.state.save(snapshot);
  }

  #logStats() {
    const { gap, load } = this.player.metrics;
    this.log.info(`stats: ${this.#stats.sample(Date.now(), { gaps: gap, loads: load, resolves: this.#resolveTimes })}`);
  }

  // ---------------------------------------------------------------------------
  // Watchdog
  // ---------------------------------------------------------------------------

  /** Self-scheduling (not setInterval), so a slow run can never overlap the next one. */
  #scheduleWatchdog() {
    if (this.#stopping) return;
    this.#watchdogTimer = setTimeout(async () => {
      await this.#watchdog();
      this.#scheduleWatchdog();
    }, WATCHDOG_INTERVAL_MS);
  }

  async #watchdog() {
    if (this.#stopping || this.#watchdogBusy) return;
    this.#watchdogBusy = true;
    try {
      await this.voice.tick();
      const since = this.voice.disconnectedSince;
      if (since && Date.now() - since > GIVE_UP_DISCONNECTED_MS && !this.voice.banned) {
        this.#fatal('not connected to the server for 20 minutes');
      }
    } catch (err) {
      this.log.error('watchdog error:', err);
    } finally {
      this.#watchdogBusy = false;
      this.#writeHealth();
    }
  }

  #fatal(reason) {
    if (this.#stopping) return;
    this.log.error(`${reason}; exiting so the container gets restarted`);
    this.shutdown()
      .catch(() => {})
      .finally(() => process.exit(1));
  }

  // ---------------------------------------------------------------------------
  // Connection events from the voice engine
  // ---------------------------------------------------------------------------

  async #onConnected(cid) {
    this.#diagnoseChannel(cid);
    if (this.#pausedByDisconnect) {
      this.#pausedByDisconnect = false;
      if (this.player.resume()) this.log.info('resumed playback after reconnecting');
    }
    if (this.#restored) {
      const { paused } = this.#restored;
      this.#restored = null;
      if (!paused) this.player.start();
    }
    // Only transmit while music is actually playing.
    await this.setTransmitting(this.player.isPlaying && !this.player.paused);
    this.#writeHealth();
  }

  #onDisconnected() {
    this.#writeHealth();
    // Nobody can hear us: pause instead of playing (and using up) the queue into the void.
    if (this.player.isPlaying && !this.player.paused && this.player.pause()) this.#pausedByDisconnect = true;
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  #markHealthy(healthy) {
    try {
      if (healthy) fs.writeFileSync(HEALTH_FILE, String(Date.now()));
      else fs.rmSync(HEALTH_FILE, { force: true });
    } catch {
      // best effort
    }
  }

  #writeHealth() {
    const { connected, me, disconnectedSince } = this.voice;
    this.#markHealthy(connected && !this.#stopping);
    const details = {
      at: new Date().toISOString(),
      engine: this.config.voice.backend,
      connected,
      clid: me.clid,
      channel: me.cid,
      disconnectedSince: disconnectedSince ? new Date(disconnectedSince).toISOString() : null,
      banned: this.voice.banned,
      playing: this.player.current?.title ?? null,
      paused: this.player.paused,
      halted: this.player.halted,
      queue: this.player.queue.length,
    };
    try {
      fs.writeFileSync(HEALTH_DETAILS_FILE, `${JSON.stringify(details, null, 2)}\n`);
    } catch {
      // best effort
    }
  }

  // ---------------------------------------------------------------------------
  // What commands ask of the bot
  // ---------------------------------------------------------------------------

  setTransmitting(on) {
    return this.voice.setTransmitting(on);
  }

  async moveToClientChannel(clid) {
    const result = await this.voice.moveToClientChannel(clid);
    if (result?.notFound) throw new Error(this.i18n.t('clientNotFound'));
  }

  /** Unique id, nickname and server group ids of a client (cached briefly by the engine). */
  clientInfo(clid) {
    return this.voice.clientInfo(clid);
  }

  /**
   * Checks the channel for settings that make the bot sound bad or inaudible and says so
   * (once per channel and issue), so admins don't have to guess.
   */
  #diagnoseChannel(cid) {
    if (!cid || !this.voice.connected) return Promise.resolve();
    if (!this.#diagnosing.has(cid)) {
      this.#diagnosing.set(cid, this.#checkChannel(cid).finally(() => this.#diagnosing.delete(cid)));
    }
    return this.#diagnosing.get(cid);
  }

  async #checkChannel(cid) {
    const { t } = this.i18n;
    try {
      const ch = await this.voice.channelSettings(cid);
      this.channelName = ch.name || null;
      const issues = [];
      // The native engine always sends Opus Music, which the server relays in any channel.
      if (!this.voice.playsAnyCodec) {
        if (ch.codec !== CODEC_OPUS_MUSIC) {
          issues.push(['codec', t('hintCodec', { codec: CODECS[ch.codec] ?? `codec ${ch.codec}`, quality: ch.quality })]);
        } else if (ch.quality < MIN_MUSIC_QUALITY) {
          issues.push(['quality', t('hintQuality', { quality: ch.quality })]);
        }
      }
      if (ch.neededTalkPower > ch.talkPower && !ch.isTalker) {
        issues.push(['talk', t('hintTalkPower', { needed: ch.neededTalkPower, have: ch.talkPower })]);
      }

      for (const [issue, message] of issues) {
        this.log.warn(`channel ${cid}: ${message}`);
        const key = `${cid}:${issue}`;
        if (!this.config.bot.channelHints || this.#hinted.has(key)) continue;
        this.#hinted.add(key);
        this.sendChannel(`🧻 ${message}`);
      }
    } catch (err) {
      this.log.debug(`channel check failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async #onTextMessage({ mode, invokerId, invokerName, invokerUid, text: raw }) {
    const { prefix } = this.config.bot;
    let text = stripBBCode(raw);
    if (text.startsWith(prefix)) text = text.slice(prefix.length);
    else if (mode !== 'private') return; // in private chat the prefix is optional

    const [rawName, ...rest] = text.trim().split(/\s+/);
    const command = this.commands.get((rawName || '').toLowerCase());
    const reply = (msg) => (mode === 'private' ? this.#sendText({ mode: 'private', clid: invokerId }, msg) : this.sendChannel(msg));
    if (!command) {
      if (mode === 'private') await reply(this.i18n.t('unknownCommand'));
      return;
    }

    const ctx = { invokerId, invokerName, invokerUid, reply };
    if (!['help', 'whoami'].includes(command.names[0]) && !(await this.#isAllowed(invokerId, invokerUid))) {
      this.log.info(`denied ${invokerName} (${invokerUid}): ${prefix}${rawName}`);
      await ctx.reply(this.i18n.t('notAllowed'));
      return;
    }

    if (RATE_LIMITED.has(command.names[0]) && !this.#limiter.take(invokerUid || invokerId)) {
      this.log.info(`rate-limited ${invokerName} (${invokerUid}): ${prefix}${rawName}`);
      await ctx.reply(this.i18n.t('slowDown'));
      return;
    }

    this.log.info(`${invokerName}: ${prefix}${rawName} ${rest.join(' ')}`.trim());
    await command.run(ctx, rest.join(' ').trim());
  }

  /** ALLOWED_UIDS / ALLOWED_GROUPS; both empty means everyone may use the bot. */
  async #isAllowed(clid, uid) {
    const { allowedUids, allowedGroups } = this.config.bot;
    if (allowedUids.length === 0 && allowedGroups.length === 0) return true;
    if (allowedUids.includes(uid)) return true;
    if (allowedGroups.length === 0) return false;
    try {
      const { groups } = await this.clientInfo(clid);
      return groups.some((g) => allowedGroups.includes(String(g)));
    } catch (err) {
      this.log.warn(`could not look up server groups of client ${clid}: ${err.message}`);
      return false;
    }
  }

  sendChannel(text) {
    return this.#sendText({ mode: 'channel' }, text);
  }

  /** Messages go out one at a time with a small gap, in the order they were requested. */
  #sendText(target, text) {
    const job = this.#sendQueue.then(async () => {
      for (const chunk of chunkMessage(text)) {
        if (!this.voice.connected) return;
        try {
          await this.voice.sendText(target, chunk);
        } catch (err) {
          if (err.flood) {
            if (!this.#floodWarned) {
              this.#floodWarned = true;
              this.log.warn("the server's anti-flood is blocking Mendil's messages. Give the bot's server group the " +
                'permission b_client_ignore_antiflood, or raise the server\'s anti-flood limits.');
            }
            await sleep(3_000);
          } else {
            this.log.warn('could not send message:', err.message);
          }
          return;
        }
        await sleep(MESSAGE_GAP_MS);
      }
    });
    this.#sendQueue = job.catch(() => {});
    return job;
  }
}
