import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ClientQuery } from './ts3/clientquery.js';
import { Ts3ClientProcess } from './ts3/client-process.js';
import { Player } from './player.js';
import { createCommands } from './commands.js';
import fs from 'node:fs';
import { createI18n } from './i18n/index.js';
import { chunkMessage, formatDuration, safe, stripBBCode, trackLink } from './format.js';

const WATCHDOG_INTERVAL_MS = 10_000;
const QUERY_STARTUP_GRACE_MS = 90_000; // restart the client if ClientQuery never comes up
const RECONNECT_MIN_MS = 30_000; // also how long an in-flight connection attempt is given
const RECONNECT_MAX_MS = 5 * 60_000;
const ERR_NOT_CONNECTED = 1794;

// Touched while connected to the server; read by the Docker HEALTHCHECK (src/healthcheck.js).
export const HEALTH_FILE = '/tmp/mendil.healthy';

const TARGET_PRIVATE = '1';
const TARGET_CHANNEL = '2';

export class Bot {
  #cq = null;
  #watchdogTimer = null;
  #stopping = false;
  #restarting = false;
  #status = 'disconnected'; // TeamSpeak connect status of server connection handler 1
  #lastConnectAttempt = 0;
  #reconnectDelay = RECONNECT_MIN_MS;
  #queryConnectTried = false;
  #transmitting = null;
  #resolvedHost = null;

  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.me = { clid: null, cid: null };
    this.i18n = createI18n(config.bot.language, { prefix: config.bot.prefix });
    const { t } = this.i18n;

    this.client = new Ts3ClientProcess({ ...config.ts3, log: log.child('ts3client') });
    this.player = new Player({ ...config.player, log: log.child('player') });
    this.commands = createCommands(this);

    this.client.on('exit', () => this.#restartClient('process exited'));
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
    this.player.on('idle', () => this.setTransmitting(false));
  }

  async start() {
    await this.client.prepare();
    await this.player.init();
    await this.#startClient();
    this.#watchdogTimer = setInterval(() => this.#watchdog(), WATCHDOG_INTERVAL_MS);
    await this.#watchdog();
  }

  async shutdown() {
    this.#stopping = true;
    clearInterval(this.#watchdogTimer);
    this.player.stop();
    try {
      if (this.#cq?.connected) await this.#cq.send('disconnect', { msg: this.i18n.t('shuttingDown') });
    } catch {
      // ignore
    }
    this.#cq?.close();
    await this.client.stop();
  }

  // ---------------------------------------------------------------------------
  // TeamSpeak connection management
  // ---------------------------------------------------------------------------

  async #watchdog() {
    if (this.#stopping || this.#restarting) return;
    try {
      if (!this.client.running) return void (await this.#restartClient('process not running'));

      if (!this.#cq?.connected) {
        try {
          await this.#connectQuery();
        } catch (err) {
          const age = Date.now() - this.client.startedAt;
          this.log.debug(`ClientQuery not reachable yet: ${err.message}`);
          if (age > QUERY_STARTUP_GRACE_MS) await this.#restartClient('ClientQuery unreachable');
          return;
        }
      }

      await this.#checkServerConnection();
    } catch (err) {
      this.log.error('watchdog error:', err);
    }
  }

  async #connectQuery() {
    const cq = new ClientQuery({ port: this.config.ts3.queryPort, log: this.log.child('clientquery') });
    await cq.connect(this.client.readApiKey());
    cq.on('notify', (name, params) => this.#onNotify(name, params));
    cq.on('close', () => {
      if (this.#cq === cq) this.log.warn('ClientQuery connection lost');
    });
    for (const event of ['notifytextmessage', 'notifyconnectstatuschange', 'notifyclientmoved']) {
      await cq.send('clientnotifyregister', { schandlerid: 0, event });
    }
    this.#cq = cq;
    this.#status = 'unknown';
    this.log.info('ClientQuery connected');
  }

  async #checkServerConnection() {
    try {
      const [me] = await this.#cq.send('whoami');
      if (this.#status !== 'connection_established') await this.#onConnected();
      this.me = { clid: me.clid, cid: me.cid };
      this.#markHealthy(true);
    } catch (err) {
      if (err.id !== ERR_NOT_CONNECTED) throw err;
      if (Date.now() - this.#lastConnectAttempt < this.#reconnectDelay) return; // attempt in flight / backoff
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS);
      // Cheap path first: ask the running client to reconnect. If that didn't help either,
      // restart the client, which connects via the ts3server:// URL (the most reliable path).
      if (!this.#queryConnectTried) {
        this.#queryConnectTried = true;
        await this.#connectViaQuery();
      } else {
        this.#queryConnectTried = false;
        await this.#restartClient('could not connect to the server');
      }
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
    this.#lastConnectAttempt = Date.now();
    this.client.start([this.#connectUrl()]);
  }

  async #connectViaQuery() {
    await this.#resolveHost();
    const { host, port, serverPassword, nickname, channel, channelPassword } = this.#addressParts();
    this.#lastConnectAttempt = Date.now();
    this.log.info(`reconnecting to ${host}:${port}`);
    await this.#cq.send('connect', {
      address: `${host}:${port}`,
      password: serverPassword,
      nickname,
      channel,
      channel_pw: channelPassword,
    });
  }

  async #onConnected() {
    this.#status = 'connection_established';
    this.#reconnectDelay = RECONNECT_MIN_MS;
    this.#queryConnectTried = false;
    const [me] = await this.#cq.send('whoami');
    this.me = { clid: me.clid, cid: me.cid };
    this.log.info(`connected to server (clid=${me.clid}, cid=${me.cid})`);
    // Only transmit while music is actually playing. (Don't mute the client's output to
    // save work: TeamSpeak then stops transmitting too. What it hears goes to "devnull".)
    this.#transmitting = null;
    await this.setTransmitting(this.player.isPlaying && !this.player.paused);
  }

  async #restartClient(reason) {
    if (this.#stopping || this.#restarting) return;
    this.#restarting = true;
    try {
      this.log.warn(`restarting TeamSpeak client: ${reason}`);
      this.#cq?.close();
      this.#cq = null;
      this.#status = 'disconnected';
      await this.client.stop();
      await new Promise((r) => setTimeout(r, 3_000));
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

  async setTransmitting(on) {
    if (this.#transmitting === on || !this.#cq?.connected || this.#status !== 'connection_established') return;
    try {
      // "deactivated" (unlike "muted") stops transmission without showing a muted mic icon.
      await this.#cq.send('clientupdate', { client_input_deactivated: on ? 0 : 1 });
      this.#transmitting = on;
    } catch (err) {
      this.log.warn('could not change transmission state:', err.message);
    }
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
  // Messages
  // ---------------------------------------------------------------------------

  #onNotify(name, params) {
    if (name === 'notifyconnectstatuschange') {
      const prev = this.#status;
      this.#status = params.status;
      if (params.status === 'connection_established' && prev !== 'connection_established') {
        this.#status = prev; // let #onConnected run its setup
        this.#onConnected().catch((err) => this.log.error('post-connect setup failed:', err));
      } else if (params.status === 'disconnected') {
        this.me = { clid: null, cid: null };
        this.#transmitting = null;
        this.#markHealthy(false);
        this.log.warn(`disconnected from server${params.error && params.error !== '0' ? ` (error ${params.error})` : ''}`);
        if (prev !== 'connection_established') {
          // TS3 servers reject a wrong/missing password without an error code or a log line.
          this.log.warn(
            'the server refused the connection. If this keeps happening, check TS3_SERVER_PASSWORD, ' +
              'whether the bot is banned and whether the server is full.',
          );
        }
      }
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

  async #sendText(target, text) {
    if (!this.#cq?.connected) return;
    for (const chunk of chunkMessage(text)) {
      try {
        await this.#cq.send('sendtextmessage', { ...target, msg: chunk });
      } catch (err) {
        this.log.warn('could not send message:', err.message);
        return;
      }
    }
  }
}
