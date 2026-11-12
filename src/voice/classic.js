import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { ClientQuery } from '../ts3/clientquery.js';
import { Ts3ClientProcess } from '../ts3/client-process.js';
import { ReconnectPolicy } from '../reconnect.js';

const QUERY_STARTUP_GRACE_MS = 90_000; // restart the client if ClientQuery never comes up
const ERR_NOT_CONNECTED = 1794;
const ERR_FLOODING = 524;
const GROUP_CACHE_MS = 60_000;

// TS client restarts after a crash: 3 s, 6 s, 12 s … up to 2 min. If it keeps crashing,
// give up so Docker restarts the whole container (Xvfb and PulseAudio included).
const CLIENT_RESTART_MIN_MS = 3_000;
const CLIENT_RESTART_MAX_MS = 2 * 60_000;
const CLIENT_STABLE_MS = 10 * 60_000; // uptime after which the restart backoff resets
const CLIENT_CRASH_WINDOW_MS = 5 * 60_000;
const CLIENT_MAX_CRASHES = 5;

// notifyclientleftview reasons for our own client
const REASON_KICKED = '5';
const REASON_BANNED = '6';

const TARGET_PRIVATE = '1';
const TARGET_CHANNEL = '2';

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

/**
 * The "Classic" voice engine: the official TeamSpeak 3 client, headless under Xvfb, with
 * PulseAudio as its microphone, remote-controlled through the ClientQuery plugin.
 *
 * Voice backend contract (shared with NativeBackend):
 *  - events: 'connected' {clid, cid}, 'disconnected', 'moved' (cid), 'fatal' (reason),
 *            'text' {mode: 'private'|'channel', invokerId, invokerName, invokerUid, text}
 *  - start(), tick() every few seconds, stop(message)
 *  - connected, me {clid, cid}, disconnectedSince, banned (getters)
 *  - sendText(target, chunk) (throws an error with .flood when anti-flood blocks it),
 *    setTransmitting(on), moveToClientChannel(clid), clientInfo(clid),
 *    channelSettings(cid) -> {codec, quality, neededTalkPower, talkPower, isTalker}
 *  - audio: what the player plays into ({kind: 'pulse', sink} here)
 *  - playsAnyCodec: false (music sounds bad unless the channel uses Opus Music)
 */
export class ClassicBackend extends EventEmitter {
  #cq = null;
  #reconnectTimer = null;
  #stopping = false;
  #restarting = false;
  #status = 'disconnected'; // TeamSpeak connect status of server connection handler 1
  #setupDone = false; // post-connect setup (whoami) succeeded
  #setupRunning = null;
  #wantTransmit = false;
  #transmitting = null; // last state confirmed by the client
  #transmitChain = Promise.resolve();
  #leaving = null; // kick/ban info from notifyclientleftview, applied on the disconnect
  #ownClid = null; // kept after a disconnect, to recognise our own leave notification
  #resolvedHost = null;
  #busy = false;
  #clientRestartDelay = CLIENT_RESTART_MIN_MS;
  #clientCrashes = [];
  #policy = new ReconnectPolicy();
  #refusalLogged = false; // explain a refused connection once per failure streak
  #groupCache = new Map(); // clid -> { uid, groups, at }

  playsAnyCodec = false;

  constructor({ ts3, player }, log) {
    super();
    this.ts3 = ts3;
    this.log = log;
    this.me = { clid: null, cid: null };
    this.audio = { kind: 'pulse', sink: player.sink };
    this.client = new Ts3ClientProcess({ ...ts3, log: log.child('ts3client') });
    this.client.on('exit', () => this.#restartClient('process exited', { crash: true }));
  }

  get connected() {
    return this.#setupDone && this.#policy.connected;
  }

  get disconnectedSince() {
    return this.#policy.disconnectedSince;
  }

  get banned() {
    return this.#policy.isBanned(Date.now());
  }

  async start() {
    await this.client.prepare();
    await this.#startClient();
  }

  async stop(message) {
    this.#stopping = true;
    clearTimeout(this.#reconnectTimer);
    try {
      if (this.#cq?.connected) await this.#cq.send('disconnect', { msg: message });
    } catch {
      // ignore
    }
    this.#cq?.close();
    await this.client.stop();
  }

  /** Called by the bot's watchdog; never overlaps itself. */
  async tick() {
    if (this.#stopping) return;
    // Checked even while a client restart is pending, so a dead Xvfb/PulseAudio is noticed
    // within one tick instead of after a series of doomed restarts.
    if (!this.#checkSupportProcesses()) return;
    if (this.#restarting || this.#busy) return;
    this.#busy = true;
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
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Xvfb and PulseAudio are started by the entrypoint and nobody else watches them. Without
   * them nothing works, so give up and let Docker's restart policy rebuild the container.
   */
  #checkSupportProcesses() {
    for (const [name, pid] of [['Xvfb', process.env.XVFB_PID], ['PulseAudio', process.env.PULSE_PID]]) {
      if (pid && !isProcessAlive(Number(pid))) {
        this.emit('fatal', `${name} (pid ${pid}) is not running`);
        return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  async #connectQuery() {
    const cq = new ClientQuery({ port: this.ts3.queryPort, log: this.log.child('clientquery') });
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
    const { port, serverPassword, nickname, channel, channelPassword } = this.ts3;
    const host = this.#resolvedHost || this.ts3.host;
    return { host: host.includes(':') ? `[${host}]` : host, port, serverPassword, nickname, channel, channelPassword };
  }

  /**
   * The TS3 client first looks up dot-less host names as TeamSpeak "server nicknames"
   * (e.g. "teamspeak" -> voice.teamspeak.com), so a Docker service name can end up pointing
   * at somebody else's server. Resolve such single-label names to an IP ourselves.
   * Re-resolved on every (re)connect because container IPs change.
   */
  async #resolveHost() {
    const { host } = this.ts3;
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

  /** Post-connect setup. Retried on the next tick if any step fails. */
  #onConnected() {
    this.#setupRunning ??= (async () => {
      try {
        const [me] = await this.#cq.send('whoami');
        this.me = { clid: me.clid, cid: me.cid };
        this.#ownClid = me.clid;
        this.#status = 'connection_established';
        this.#transmitting = null; // unknown after a (re)connect
        this.#setupDone = true;
        this.#refusalLogged = false;
        this.log.info(`connected to server (clid=${me.clid}, cid=${me.cid})`);
        this.emit('connected', { ...this.me });
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

    const leaving = this.#leaving && Date.now() - this.#leaving.at < 10_000 ? this.#leaving : null;
    this.#leaving = null;
    this.#policy.onDisconnected(Date.now(), leaving ?? {});
    const error = params.error && params.error !== '0' ? ` (error ${params.error})` : '';
    this.log.warn(`disconnected from server${error}`);
    if (!leaving && prev !== 'connection_established' && !this.#refusalLogged) {
      // The TS3 client reports every refusal the same way (error 0, no reason anywhere).
      this.#refusalLogged = true;
      this.log.warn('the server refused the connection (TeamSpeak does not say why). Common causes: ' +
        'a wrong or missing TS3_SERVER_PASSWORD; the bot\'s identity, IP or nickname is banned; the server is full; ' +
        'or the server requires an identity security level above 8. Mendil keeps retrying.');
    }
    this.emit('disconnected');
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
          this.emit('fatal', `TeamSpeak client failed ${this.#clientCrashes.length} times in 5 minutes`);
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

  // ---------------------------------------------------------------------------
  // What the bot asks of the engine
  // ---------------------------------------------------------------------------

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

  /** Throws an error with `.flood` set when the server's anti-flood refused the message. */
  async sendText(target, chunk) {
    if (!this.#cq?.connected) return false;
    try {
      await this.#cq.send('sendtextmessage', target.mode === 'private'
        ? { targetmode: 1, target: target.clid, msg: chunk }
        : { targetmode: 2, msg: chunk });
      return true;
    } catch (err) {
      if (err.id === ERR_FLOODING || /flood/i.test(err.queryMessage ?? '')) err.flood = true;
      throw err;
    }
  }

  async moveToClientChannel(clid) {
    const clients = await this.#cq.send('clientlist');
    const target = clients.find((c) => c.clid === String(clid));
    if (!target) return { notFound: true };
    if (target.cid === this.me.cid) return { already: true };
    // me.cid is updated by the move notification (which also runs the channel check), so a
    // refused move doesn't leave it pointing at the wrong channel.
    await this.#cq.send('clientmove', { cid: target.cid, clid: this.me.clid });
    return { moved: true };
  }

  /** Unique id, nickname and server group ids of a client (cached briefly). */
  async clientInfo(clid) {
    const cached = this.#groupCache.get(clid);
    if (cached && Date.now() - cached.at < GROUP_CACHE_MS) return cached;
    const [c] = await this.#cq.send('clientvariable', { clid }, [], ['client_unique_identifier', 'client_servergroups', 'client_nickname']);
    const info = {
      uid: c.client_unique_identifier,
      name: c.client_nickname,
      groups: (c.client_servergroups ?? '').split(',').filter(Boolean),
      at: Date.now(),
    };
    this.#groupCache.set(clid, info);
    return info;
  }

  async channelSettings(cid) {
    if (!this.#cq?.connected) throw new Error('not connected');
    const [ch] = await this.#cq.send('channelvariable', { cid }, [], ['channel_codec', 'channel_codec_quality', 'channel_needed_talk_power']);
    const [me] = await this.#cq.send('clientvariable', { clid: this.me.clid }, [], ['client_talk_power', 'client_is_talker']);
    return {
      codec: Number(ch.channel_codec),
      quality: Number(ch.channel_codec_quality),
      neededTalkPower: Number(ch.channel_needed_talk_power || 0),
      talkPower: Number(me.client_talk_power || 0),
      isTalker: me.client_is_talker === '1',
    };
  }

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
      this.emit('moved', params.ctid);
      return;
    }
    if (name === 'notifytextmessage') {
      const { targetmode, invokerid, invokername, invokeruid, msg } = params;
      if (!msg || invokerid === this.me.clid) return;
      if (targetmode !== TARGET_PRIVATE && targetmode !== TARGET_CHANNEL) return;
      this.emit('text', {
        mode: targetmode === TARGET_PRIVATE ? 'private' : 'channel',
        invokerId: invokerid,
        invokerName: invokername,
        invokerUid: invokeruid,
        text: msg,
      });
    }
  }
}
