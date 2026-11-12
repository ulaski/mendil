import fs from 'node:fs';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { ClientQuery } from './ts3/clientquery.js';
import { Ts3ClientProcess } from './ts3/client-process.js';
import { Player } from './player.js';
import { Prefetcher } from './prefetch.js';
import { ReconnectPolicy } from './reconnect.js';
import { StateStore } from './state.js';
import { StatsReporter } from './stats.js';
import { YtdlpUpdater } from './ytdlp-update.js';
import { createCommands } from './commands.js';
import { createI18n } from './i18n/index.js';
import { chunkMessage, formatDuration, safe, stripBBCode, trackLink } from './format.js';

const WATCHDOG_INTERVAL_MS = 10_000;
const QUERY_STARTUP_GRACE_MS = 90_000; // restart the client if ClientQuery never comes up
const ERR_NOT_CONNECTED = 1794;
const STATE_SAVE_INTERVAL_MS = 5_000;
const STATS_INTERVAL_MS = 10 * 60_000;
const GIVE_UP_DISCONNECTED_MS = 20 * 60_000; // then exit for a clean container restart

// TS client restarts after a crash: 3 s, 6 s, 12 s … up to 2 min. If it keeps crashing,
// exit so Docker restarts the whole container (Xvfb and PulseAudio included).
const CLIENT_RESTART_MIN_MS = 3_000;
const CLIENT_RESTART_MAX_MS = 2 * 60_000;
const CLIENT_STABLE_MS = 10 * 60_000; // uptime after which the restart backoff resets
const CLIENT_CRASH_WINDOW_MS = 5 * 60_000;
const CLIENT_MAX_CRASHES = 5;

// Minimum gap between outgoing chat messages, to stay clear of the server's anti-flood.
const MESSAGE_GAP_MS = 300;

// notifyclientleftview reasons for our own client
const REASON_KICKED = '5';
const REASON_BANNED = '6';

/** True while a process exists and isn't a zombie (Xvfb is our child but never reaped). */
export function isProcessAlive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

// Touched every watchdog tick while everything is fine; the Docker HEALTHCHECK checks its age.
export const HEALTH_FILE = '/tmp/mendil.healthy';
// Human-readable details for `docker exec mendil cat /tmp/mendil-health.json`.
export const HEALTH_DETAILS_FILE = '/tmp/mendil-health.json';

const TARGET_PRIVATE = '1';
const TARGET_CHANNEL = '2';

export class Bot {
  #cq = null;
  #watchdogTimer = null;
  #reconnectTimer = null;
  #timers = [];
  #stopping = false;
  #restarting = false;
  #status = 'disconnected'; // TeamSpeak connect status of server connection handler 1
  #setupDone = false; // post-connect setup (whoami, transmit state) succeeded
  #setupRunning = null;
  #wantTransmit = false;
  #transmitting = null; // last state confirmed by the client
  #transmitChain = Promise.resolve();
  #pausedByDisconnect = false;
  #restored = null; // { tracks, paused } until the restored queue has been started
  #leaving = null; // kick/ban info from notifyclientleftview, applied on the disconnect
  #ownClid = null; // kept after a disconnect, to recognise our own leave notification
  #resolvedHost = null;
  #watchdogBusy = false;
  #clientRestartDelay = CLIENT_RESTART_MIN_MS;
  #clientCrashes = [];
  #sendQueue = Promise.resolve();
  #resolveTimes = [];
  #policy = new ReconnectPolicy();
  #stats = new StatsReporter();

  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.me = { clid: null, cid: null };
    this.i18n = createI18n(config.bot.language, { prefix: config.bot.prefix });
    const { t } = this.i18n;

    this.client = new Ts3ClientProcess({ ...config.ts3, log: log.child('ts3client') });
    const p = config.player;
    const prefetcher = p.prefetch
      ? new Prefetcher({ dir: p.prefetchDir, cookiesFile: p.cookiesFile, cacheDir: p.cacheDir, maxDuration: p.prefetchMaxDuration, normalize: p.normalize, log: log.child('prefetch') })
      : null;
    this.player = new Player({ ...p, prefetcher, log: log.child('player') });
    this.state = new StateStore(path.join(config.dataDir, 'state.json'), log.child('state'));
    this.updater = new YtdlpUpdater({
      enabled: config.ytdlp.autoUpdate,
      venv: config.ytdlp.venv,
      ytOpts: { cookiesFile: p.cookiesFile, cacheDir: p.cacheDir },
      smokeTestUrl: () => this.player.lastGoodUrl,
      log: log.child('yt-dlp'),
    });
    this.commands = createCommands(this);

    this.client.on('exit', () => this.#restartClient('process exited', { crash: true }));
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
      this.sendChannel(t('playbackHalted', { reason: safe(message) }));
    });
    this.player.on('idle', () => this.setTransmitting(false));
  }

  async start() {
    await this.client.prepare();
    const saved = this.state.load();
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
    await this.#startClient();
    await this.#watchdog();
    this.#scheduleWatchdog();
  }

  async shutdown() {
    if (this.#stopping) return;
    this.#stopping = true;
    clearTimeout(this.#watchdogTimer);
    clearTimeout(this.#reconnectTimer);
    for (const timer of this.#timers) clearInterval(timer);
    this.updater.stop();
    this.#saveState(); // before stopping playback, so the queue survives
    this.player.dispose();
    try {
      if (this.#cq?.connected) await this.#cq.send('disconnect', { msg: this.i18n.t('shuttingDown') });
    } catch {
      // ignore
    }
    this.#cq?.close();
    this.#markHealthy(false);
    await this.client.stop();
  }

  recordResolve(ms) {
    this.#resolveTimes.push(ms);
    if (this.#resolveTimes.length > 100) this.#resolveTimes.shift();
  }

  #saveState() {
    const snapshot = this.player.snapshot();
    if (this.#restored?.paused) snapshot.paused = true; // restored but not started yet
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
    if (this.#stopping) return;
    // Checked even while a client restart is pending, so a dead Xvfb/PulseAudio is noticed
    // within one tick instead of after a series of doomed restarts.
    if (!this.#checkSupportProcesses()) return;
    if (this.#restarting || this.#watchdogBusy) return;
    this.#watchdogBusy = true;
    try {
      if (!this.client.running) return void (await this.#restartClient('process not running', { crash: true }));

      if (!this.#cq?.connected) {
        try {
          await this.#connectQuery();
        } catch (err) {
          const age = Date.now() - this.client.startedAt;
          this.log.debug(`ClientQuery not reachable yet: ${err.message}`);
          if (age > QUERY_STARTUP_GRACE_MS) await this.#restartClient('ClientQuery unreachable', { crash: true });
          return;
        }
      }

      await this.#checkServerConnection();
      if (this.#setupDone) this.#syncTransmit(); // re-send if a previous update got lost

      const since = this.#policy.disconnectedSince;
      if (since && Date.now() - since > GIVE_UP_DISCONNECTED_MS && !this.#policy.isBanned(Date.now())) {
        this.#fatal('not connected to the server for 20 minutes');
      }
    } catch (err) {
      this.log.error('watchdog error:', err);
    } finally {
      this.#watchdogBusy = false;
      this.#writeHealth();
    }
  }

  /**
   * Xvfb and PulseAudio are started by the entrypoint and nobody else watches them. Without
   * them nothing works, so exit and let Docker's restart policy rebuild the whole container.
   */
  #checkSupportProcesses() {
    for (const [name, pid] of [['Xvfb', process.env.XVFB_PID], ['PulseAudio', process.env.PULSE_PID]]) {
      if (pid && !isProcessAlive(Number(pid))) {
        this.#fatal(`${name} (pid ${pid}) is not running`);
        return false;
      }
    }
    return true;
  }

  #fatal(reason) {
    if (this.#stopping) return;
    this.log.error(`${reason}; exiting so the container gets restarted`);
    this.shutdown()
      .catch(() => {})
      .finally(() => process.exit(1));
  }

  // ---------------------------------------------------------------------------
  // TeamSpeak connection management
  // ---------------------------------------------------------------------------

  async #connectQuery() {
    const cq = new ClientQuery({ port: this.config.ts3.queryPort, log: this.log.child('clientquery') });
    // Ignore events from any connection other than the current one, so a leaked or
    // replaced connection can never run a chat command a second time.
    cq.on('notify', (name, params) => {
      if (this.#cq === cq) this.#onNotify(name, params);
    });
    cq.on('close', () => {
      if (this.#cq === cq && !this.#stopping) this.log.warn('ClientQuery connection lost');
    });
    try {
      await cq.connect(this.client.readApiKey());
      for (const event of ['notifytextmessage', 'notifyconnectstatuschange', 'notifyclientmoved', 'notifyclientleftview']) {
        await cq.send('clientnotifyregister', { schandlerid: 0, event });
      }
    } catch (err) {
      cq.close();
      throw err;
    }
    this.#cq?.close();
    this.#cq = cq;
    this.#status = 'unknown';
    this.#setupDone = false;
    this.log.info('ClientQuery connected');
  }

  async #checkServerConnection() {
    try {
      const [me] = await this.#cq.send('whoami');
      this.me = { clid: me.clid, cid: me.cid };
      this.#ownClid = me.clid;
      if (!this.#policy.connected) this.#policy.onStatus('connection_established', Date.now());
      if (!this.#setupDone) await this.#onConnected();
    } catch (err) {
      if (err.id !== ERR_NOT_CONNECTED) throw err;
      if (this.#policy.connected) this.#policy.onDisconnected(Date.now()); // missed the notification
      await this.#driveReconnect();
    }
  }

  /** Asks the reconnect policy what to do and does it; reschedules itself while waiting. */
  async #driveReconnect() {
    clearTimeout(this.#reconnectTimer);
    if (this.#stopping || this.#restarting || !this.#cq?.connected) return;
    const now = Date.now();
    const step = this.#policy.next(now);
    if (step.action === 'connect') {
      await this.#connectViaQuery().catch((err) => this.log.warn(`connect failed: ${err.message}`));
    } else if (step.action === 'restart') {
      await this.#restartClient(step.reason);
      return;
    }
    const due = this.#policy.dueIn(Date.now());
    if (due !== null) {
      this.#reconnectTimer = setTimeout(() => this.#driveReconnect(), Math.max(500, due));
      this.#reconnectTimer.unref?.();
    }
  }

  #addressParts() {
    const { port, serverPassword, nickname, channel, channelPassword } = this.config.ts3;
    const host = this.#resolvedHost || this.config.ts3.host;
    return { host: host.includes(':') ? `[${host}]` : host, port, serverPassword, nickname, channel, channelPassword };
  }

  /**
   * The TS3 client first looks up dot-less host names as TeamSpeak "server nicknames"
   * (e.g. "teamspeak" -> voice.teamspeak.com), so a Docker service name can end up pointing
   * at somebody else's server. Resolve such single-label names to an IP ourselves.
   * Re-resolved on every (re)connect because container IPs change.
   */
  async #resolveHost() {
    const { host } = this.config.ts3;
    this.#resolvedHost = null;
    if (host.includes('.') || isIP(host)) return;
    try {
      const { address } = await lookup(host);
      this.#resolvedHost = address;
      this.log.debug(`resolved "${host}" to ${address}`);
    } catch (err) {
      this.log.warn(`could not resolve "${host}": ${err.message}`);
    }
  }

  #connectUrl() {
    const { host, port, serverPassword, nickname, channel, channelPassword } = this.#addressParts();
    const params = new URLSearchParams({ port: String(port), nickname });
    if (serverPassword) params.set('password', serverPassword);
    if (channel) params.set('channel', channel);
    if (channelPassword) params.set('channelpassword', channelPassword);
    return `ts3server://${host}?${params.toString().replace(/\+/g, '%20')}`;
  }

  async #startClient() {
    await this.#resolveHost();
    const { host, port, nickname, channel } = this.#addressParts();
    this.log.info(`connecting to ${host}:${port} as "${nickname}"${channel ? ` (channel "${channel}")` : ''}`);
    this.#policy.onClientStarted(Date.now());
    this.client.start([this.#connectUrl()]);
  }

  async #connectViaQuery() {
    await this.#resolveHost();
    const { host, port, serverPassword, nickname, channel, channelPassword } = this.#addressParts();
    this.log.info(`reconnecting to ${host}:${port} (attempt ${this.#policy.attempts})`);
    await this.#cq.send('connect', {
      address: `${host}:${port}`,
      password: serverPassword,
      nickname,
      channel,
      channel_pw: channelPassword,
    });
  }

  /** Post-connect setup. Retried on the next watchdog tick if any step fails. */
  #onConnected() {
    this.#setupRunning ??= (async () => {
      try {
        const [me] = await this.#cq.send('whoami');
        this.me = { clid: me.clid, cid: me.cid };
        this.#ownClid = me.clid;
        this.#status = 'connection_established';
        this.#transmitting = null; // unknown after a (re)connect
        this.#setupDone = true;
        this.log.info(`connected to server (clid=${me.clid}, cid=${me.cid})`);

        if (this.#pausedByDisconnect) {
          this.#pausedByDisconnect = false;
          if (this.player.resume()) this.log.info('resumed playback after reconnecting');
        }
        if (this.#restored) {
          const { paused } = this.#restored;
          this.#restored = null;
          if (!paused) this.player.start();
        }
        // Only transmit while music is actually playing. (Don't mute the client's output to
        // save work: TeamSpeak then stops transmitting too. What it hears goes to "devnull".)
        await this.setTransmitting(this.player.isPlaying && !this.player.paused);
        this.#writeHealth();
      } catch (err) {
        this.#setupDone = false;
        this.log.warn(`post-connect setup failed (will retry): ${err.message}`);
      } finally {
        this.#setupRunning = null;
      }
    })();
    return this.#setupRunning;
  }

  #onDisconnected(params) {
    const prev = this.#status;
    this.me = { clid: null, cid: null };
    this.#transmitting = null;
    this.#setupDone = false;
    this.#writeHealth();
    // Nobody can hear us: pause instead of playing (and using up) the queue into the void.
    if (this.player.isPlaying && !this.player.paused && this.player.pause()) this.#pausedByDisconnect = true;

    const leaving = this.#leaving && Date.now() - this.#leaving.at < 10_000 ? this.#leaving : null;
    this.#leaving = null;
    this.#policy.onDisconnected(Date.now(), leaving ?? {});
    const error = params.error && params.error !== '0' ? ` (error ${params.error})` : '';
    this.log.warn(`disconnected from server${error}`);
    if (!leaving && prev !== 'connection_established') {
      // TS3 servers reject a wrong/missing password without an error code or a log line.
      this.log.warn('the server refused the connection. If this keeps happening, check TS3_SERVER_PASSWORD, ' +
        'whether the bot is banned and whether the server is full.');
    }
    this.#driveReconnect();
  }

  /** Our own client left the server view: kicked or banned (reasonid 5/6). */
  #onOwnLeave(params) {
    const by = params.invokername ? ` by ${params.invokername}` : '';
    const why = params.reasonmsg ? `: ${params.reasonmsg}` : '';
    if (params.reasonid === REASON_BANNED) {
      const seconds = Number(params.bantime ?? 0);
      this.#leaving = { at: Date.now(), banSeconds: seconds };
      this.log.error(`BANNED from the server${by}${why} (${seconds > 0 ? `${seconds}s` : 'permanent'}); waiting before reconnecting`);
    } else if (params.reasonid === REASON_KICKED) {
      this.#leaving = { at: Date.now(), kicked: true };
      this.log.warn(`kicked from the server${by}${why}; reconnecting in a bit`);
    } else {
      return;
    }
    // In case the disconnect notification came first, apply the kick/ban now.
    if (!this.#policy.connected) this.#policy.onDisconnected(Date.now(), this.#leaving);
  }

  /** @param {{crash?: boolean}} opts crash=true when the client itself failed (not the server) */
  async #restartClient(reason, { crash = false } = {}) {
    if (this.#stopping || this.#restarting) return;
    this.#restarting = true;
    try {
      let delay = CLIENT_RESTART_MIN_MS;
      if (crash) {
        const now = Date.now();
        if (now - this.client.startedAt > CLIENT_STABLE_MS) this.#clientRestartDelay = CLIENT_RESTART_MIN_MS;
        this.#clientCrashes = this.#clientCrashes.filter((t) => now - t < CLIENT_CRASH_WINDOW_MS);
        this.#clientCrashes.push(now);
        if (this.#clientCrashes.length > CLIENT_MAX_CRASHES) {
          this.#fatal(`TeamSpeak client failed ${this.#clientCrashes.length} times in 5 minutes`);
          return;
        }
        delay = this.#clientRestartDelay;
        this.#clientRestartDelay = Math.min(this.#clientRestartDelay * 2, CLIENT_RESTART_MAX_MS);
      }
      this.log.warn(`restarting TeamSpeak client in ${Math.round(delay / 1000)}s: ${reason}`);
      clearTimeout(this.#reconnectTimer);
      this.#cq?.close();
      this.#cq = null;
      this.#status = 'disconnected';
      this.#setupDone = false;
      this.#writeHealth();
      await this.client.stop();
      await sleep(delay);
      if (this.#stopping || !this.#checkSupportProcesses()) return;
      await this.client.prepare();
      await this.#startClient();
    } catch (err) {
      this.log.error('client restart failed:', err);
    } finally {
      this.#restarting = false;
    }
  }

  #markHealthy(healthy) {
    try {
      if (healthy) fs.writeFileSync(HEALTH_FILE, String(Date.now()));
      else fs.rmSync(HEALTH_FILE, { force: true });
    } catch {
      // best effort
    }
  }

  #writeHealth() {
    const connected = this.#setupDone && this.#policy.connected;
    this.#markHealthy(connected && !this.#stopping);
    const details = {
      at: new Date().toISOString(),
      connected,
      clid: this.me.clid,
      channel: this.me.cid,
      disconnectedSince: this.#policy.disconnectedSince ? new Date(this.#policy.disconnectedSince).toISOString() : null,
      banned: this.#policy.isBanned(Date.now()),
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

  /** Requests the transmit state; updates are serialised and re-sent until confirmed. */
  setTransmitting(on) {
    this.#wantTransmit = on;
    return this.#syncTransmit();
  }

  #syncTransmit() {
    this.#transmitChain = this.#transmitChain.then(async () => {
      const want = this.#wantTransmit;
      if (this.#transmitting === want || !this.#cq?.connected || !this.#setupDone) return;
      try {
        // "deactivated" (unlike "muted") stops transmission without showing a muted mic icon.
        await this.#cq.send('clientupdate', { client_input_deactivated: want ? 0 : 1 });
        this.#transmitting = want;
      } catch (err) {
        this.log.warn('could not change transmission state:', err.message);
      }
    });
    return this.#transmitChain;
  }

  async moveToClientChannel(clid) {
    const clients = await this.#cq.send('clientlist');
    const target = clients.find((c) => c.clid === String(clid));
    if (!target) throw new Error(this.i18n.t('clientNotFound'));
    if (target.cid === this.me.cid) return;
    await this.#cq.send('clientmove', { cid: target.cid, clid: this.me.clid });
    this.me.cid = target.cid;
  }

  // ---------------------------------------------------------------------------
  // Notifications and messages
  // ---------------------------------------------------------------------------

  #onNotify(name, params) {
    if (name === 'notifyconnectstatuschange') {
      const prev = this.#status;
      this.#status = params.status;
      this.#policy.onStatus(params.status === 'disconnected' ? 'disconnecting' : params.status, Date.now());
      if (params.status === 'connection_established' && !this.#setupDone) {
        clearTimeout(this.#reconnectTimer);
        this.#onConnected();
      } else if (params.status === 'disconnected') {
        this.#status = prev; // #onDisconnected wants to know where we came from
        this.#onDisconnected(params);
        this.#status = 'disconnected';
      }
      return;
    }
    if (name === 'notifyclientleftview' && this.#ownClid && params.clid === this.#ownClid) {
      this.#onOwnLeave(params);
      return;
    }
    if (name === 'notifyclientmoved' && params.clid === this.me.clid) {
      this.me.cid = params.ctid;
      return;
    }
    if (name === 'notifytextmessage') {
      this.#onTextMessage(params).catch((err) => this.log.error('command failed:', err));
    }
  }

  async #onTextMessage(params) {
    const { targetmode, invokerid, invokername, invokeruid } = params;
    if (!params.msg || invokerid === this.me.clid) return;
    if (targetmode !== TARGET_PRIVATE && targetmode !== TARGET_CHANNEL) return;

    const { prefix, allowedUids } = this.config.bot;
    let text = stripBBCode(params.msg);
    if (text.startsWith(prefix)) text = text.slice(prefix.length);
    else if (targetmode !== TARGET_PRIVATE) return; // in private chat the prefix is optional

    const [rawName, ...rest] = text.trim().split(/\s+/);
    const command = this.commands.get((rawName || '').toLowerCase());
    if (!command) {
      if (targetmode === TARGET_PRIVATE) await this.#reply(targetmode, invokerid, this.i18n.t('unknownCommand'));
      return;
    }

    const ctx = {
      invokerId: invokerid,
      invokerName: invokername,
      invokerUid: invokeruid,
      reply: (msg) => this.#reply(targetmode, invokerid, msg),
    };
    if (allowedUids.length > 0 && !allowedUids.includes(invokeruid) && command.names[0] !== 'help') {
      await ctx.reply(this.i18n.t('notAllowed'));
      return;
    }

    this.log.info(`${invokername}: ${prefix}${rawName} ${rest.join(' ')}`.trim());
    await command.run(ctx, rest.join(' ').trim());
  }

  async #reply(targetmode, invokerId, text) {
    if (targetmode === TARGET_PRIVATE) return this.#sendText({ targetmode: 1, target: invokerId }, text);
    return this.sendChannel(text);
  }

  sendChannel(text) {
    return this.#sendText({ targetmode: 2 }, text);
  }

  /** Messages go out one at a time with a small gap, in the order they were requested. */
  #sendText(target, text) {
    const job = this.#sendQueue.then(async () => {
      for (const chunk of chunkMessage(text)) {
        if (!this.#cq?.connected) return;
        try {
          await this.#cq.send('sendtextmessage', { ...target, msg: chunk });
        } catch (err) {
          this.log.warn('could not send message:', err.message);
          return;
        }
        await sleep(MESSAGE_GAP_MS);
      }
    });
    this.#sendQueue = job.catch(() => {});
    return job;
  }
}
