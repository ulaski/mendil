import { ClientQuery } from './ts3/clientquery.js';
import { Ts3ClientProcess } from './ts3/client-process.js';
import { Player } from './player.js';
import { createCommands } from './commands.js';
import { chunkMessage, safe, stripBBCode, trackLength, trackLink } from './format.js';

const WATCHDOG_INTERVAL_MS = 10_000;
const QUERY_STARTUP_GRACE_MS = 90_000; // restart the client if ClientQuery never comes up
const RECONNECT_MIN_MS = 30_000; // also how long an in-flight connection attempt is given
const RECONNECT_MAX_MS = 5 * 60_000;
const ERR_NOT_CONNECTED = 1794;

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

  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.me = { clid: null, cid: null };

    this.client = new Ts3ClientProcess({ ...config.ts3, log: log.child('ts3client') });
    this.player = new Player({ ...config.player, log: log.child('player') });
    this.commands = createCommands(this);

    this.client.on('exit', () => this.#restartClient('process exited'));
    this.player.on('trackStart', (track) => {
      this.setTransmitting(true);
      if (config.bot.announceTracks) {
        this.sendChannel(`▶ Çalıyor: ${trackLink(track)} (${trackLength(track)}) — isteyen: ${safe(track.requestedBy)}`);
      }
    });
    this.player.on('trackError', (track, message) => {
      this.sendChannel(`Çalınamadı: ${safe(track.title)} — ${safe(message)}`);
    });
    this.player.on('idle', () => this.setTransmitting(false));
  }

  async start() {
    await this.client.prepare();
    await this.player.init();
    this.#startClient();
    this.#watchdogTimer = setInterval(() => this.#watchdog(), WATCHDOG_INTERVAL_MS);
    await this.#watchdog();
  }

  async shutdown() {
    this.#stopping = true;
    clearInterval(this.#watchdogTimer);
    this.player.stop();
    try {
      if (this.#cq?.connected) await this.#cq.send('disconnect', { msg: 'Bot kapanıyor' });
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
    const { host, port, serverPassword, nickname, channel, channelPassword } = this.config.ts3;
    return { host: host.includes(':') ? `[${host}]` : host, port, serverPassword, nickname, channel, channelPassword };
  }

  #connectUrl() {
    const { host, port, serverPassword, nickname, channel, channelPassword } = this.#addressParts();
    const params = new URLSearchParams({ port: String(port), nickname });
    if (serverPassword) params.set('password', serverPassword);
    if (channel) params.set('channel', channel);
    if (channelPassword) params.set('channelpassword', channelPassword);
    return `ts3server://${host}?${params.toString().replace(/\+/g, '%20')}`;
  }

  #startClient() {
    const { host, port, nickname, channel } = this.#addressParts();
    this.log.info(`connecting to ${host}:${port} as "${nickname}"${channel ? ` (channel "${channel}")` : ''}`);
    this.#lastConnectAttempt = Date.now();
    this.client.start([this.#connectUrl()]);
  }

  async #connectViaQuery() {
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
      this.#startClient();
    } catch (err) {
      this.log.error('client restart failed:', err);
    } finally {
      this.#restarting = false;
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
    if (!target) throw new Error('seni bulamadım');
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
        this.log.warn(`disconnected from server${params.error && params.error !== '0' ? ` (error ${params.error})` : ''}`);
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
      if (targetmode === TARGET_PRIVATE) await this.#reply(targetmode, invokerid, `Bilinmeyen komut. ${prefix}help yaz.`);
      return;
    }

    const ctx = {
      invokerId: invokerid,
      invokerName: invokername,
      invokerUid: invokeruid,
      reply: (msg) => this.#reply(targetmode, invokerid, msg),
    };
    if (allowedUids.length > 0 && !allowedUids.includes(invokeruid) && command.names[0] !== 'help') {
      await ctx.reply('Bu botu kullanma yetkin yok.');
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
