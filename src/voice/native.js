import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Client, generateIdentity, parseIdentity, RemovedError, subscribeAllChannels } from '@honeybbq/teamspeak/client';
import {
  Codec, ErrorCode, Reason, ServerError, asChannelID, asClientID,
  moveClient, sendChannelMessage, sendPrivateMessage, updateClient,
} from '@honeybbq/teamspeak';
import { Linux_3_6_2_1695203293 as CLIENT_VERSION } from '@honeybbq/teamspeak/versions';

const CONNECT_TIMEOUT_MS = 30_000;
const KICK_DELAY_MS = 45_000;
const BAN_DEFAULT_MS = 10 * 60_000; // permanent or unknown duration: check back now and then
const FLOOD_BLOCK_MS = 60_000; // the server's temporary flood-prevention block
const CLONE_RETRY_MS = 3_000; // 521: the server still holds our old session; it reaps it soon
const PASSWORD_RETRY_MS = 5 * 60_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const BANTIME_WAIT_MS = 1_000; // the ban duration arrives just after the disconnect
const IDENTITY_LEVEL = 8;

const TARGET_PRIVATE = 1;
const TARGET_CHANNEL = 2;

/**
 * The "Native" voice engine: speaks the TeamSpeak protocol itself through teamspeak-js
 * (https://github.com/HoneyBBQ/teamspeak-js), with no TeamSpeak client, X server or
 * PulseAudio. Works with TeamSpeak 3 and 6 servers and on any CPU architecture.
 *
 * Same contract as ClassicBackend (see classic.js). Differences:
 *  - audio is {kind: 'opus'}: the player hands it encoded Opus frames;
 *  - it always sends Opus Music, which servers relay in any channel (playsAnyCodec);
 *  - refusals come with a reason (wrong password, ban, security level…), which is logged.
 *
 * Not made or endorsed by TeamSpeak Systems.
 */
export class NativeBackend extends EventEmitter {
  #client = null;
  #identity = null;
  #stopping = false;
  #connecting = false;
  #connected = false;
  #retryTimer = null;
  #retryAt = null;
  #backoffMs = BACKOFF_MIN_MS;
  #disconnectedSince = null;
  #bannedUntil = 0;
  #lastBanSeconds = null;
  #lastRefusal = null; // log a repeated refusal once per streak
  #everConnected = false;

  playsAnyCodec = true;

  constructor({ ts3, voice, dataDir }, log) {
    super();
    this.ts3 = ts3;
    this.log = log;
    this.identityFile = path.join(dataDir, 'native-identity');
    this.me = { clid: null, cid: null };
    this.audio = {
      kind: 'opus',
      bitrate: voice.bitrate,
      send: (frame) => this.#sendVoice(frame),
      endSpeech: () => this.#sendVoice(new Uint8Array(0)),
    };
  }

  get connected() {
    return this.#connected;
  }

  get disconnectedSince() {
    return this.#disconnectedSince;
  }

  get banned() {
    return Date.now() < this.#bannedUntil;
  }

  async start() {
    this.#identity = await this.#loadIdentity(IDENTITY_LEVEL);
    this.#disconnectedSince = Date.now();
    this.#createClient();
    const { host, port, nickname, channel } = this.ts3;
    this.log.info(`connecting to ${host}:${port} as "${nickname}"${channel ? ` (channel "${channel}")` : ''} with the native engine`);
    await this.#connect();
  }

  async stop(message) {
    this.#stopping = true;
    clearTimeout(this.#retryTimer);
    await this.#client?.disconnect({ reasonMessage: message, signal: AbortSignal.timeout(3_000) }).catch(() => {});
  }

  /** Safety net from the bot's watchdog: make sure a reconnect is always on its way. */
  async tick() {
    if (this.#stopping || this.#connected || this.#connecting || this.#retryTimer) return;
    this.#schedule(0, 'watchdog');
  }

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  /** The bot's identity, kept in the data volume so server groups and bans stick to it. */
  async #loadIdentity(level) {
    let identity = null;
    try {
      identity = parseIdentity(fs.readFileSync(this.identityFile, 'utf8').trim());
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`could not read ${this.identityFile} (${err.message}); creating a new identity`);
    }
    if (!identity) {
      identity = await generateIdentity(level);
      this.log.info('created a new identity for the native engine');
    }
    if (identity.securityLevel() < level) {
      const started = Date.now();
      this.log.info(`raising the identity's security level to ${level} (may take a while above ~25)…`);
      identity = await identity.upgradeToLevel(level);
      this.log.info(`identity is now at security level ${identity.securityLevel()} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    fs.mkdirSync(path.dirname(this.identityFile), { recursive: true });
    fs.writeFileSync(this.identityFile, `${identity.export()}\n`, { mode: 0o600 });
    return identity;
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  #createClient() {
    const { host, port, nickname, serverPassword, channel, channelPassword } = this.ts3;
    const address = host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`;
    const client = new Client(this.#identity, address, nickname, {
      version: CLIENT_VERSION,
      serverPassword: serverPassword || undefined,
      defaultChannel: channel || undefined,
      defaultChannelPassword: channelPassword || undefined,
      logger: {
        debug: (msg) => this.log.debug(`teamspeak-js: ${msg}`),
        info: (msg) => this.log.debug(`teamspeak-js: ${msg}`),
        warn: (msg) => this.log.warn(`teamspeak-js: ${msg}`),
        error: (msg) => this.log.error(`teamspeak-js: ${msg}`),
      },
    });
    client.on('disconnected', ({ error }) => {
      if (this.#client === client) this.#onDisconnected(error);
    });
    client.on('clientMoved', (ev) => {
      if (this.#client !== client || Number(ev.clientID) !== Number(client.clientID)) return;
      this.me = { ...this.me, cid: String(ev.targetChannelID) };
      this.emit('moved', this.me.cid);
    });
    client.on('textMessage', (msg) => {
      if (this.#client !== client || Number(msg.invokerID) === Number(client.clientID)) return;
      if (msg.targetMode !== TARGET_PRIVATE && msg.targetMode !== TARGET_CHANNEL) return;
      this.emit('text', {
        mode: msg.targetMode === TARGET_PRIVATE ? 'private' : 'channel',
        invokerId: String(msg.invokerID),
        invokerName: msg.invokerName,
        invokerUid: String(msg.invokerUID),
        text: msg.message,
      });
    });
    // The ban duration is only in the raw leave notification, which arrives after the
    // disconnect (teamspeak-js issue #209).
    client.on('notification', (n) => {
      if (n?.name === 'notifyclientleftview' && n.params?.reasonid === String(Reason.KickServerBan)
        && Number(n.params.clid) === Number(this.me.clid ?? -1)) {
        this.#lastBanSeconds = Number(n.params.bantime ?? 0);
      }
    });
    this.#client = client;
  }

  async #connect() {
    if (this.#stopping || this.#connecting || this.#connected) return;
    this.#connecting = true;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    try {
      await this.#client.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    } catch (err) {
      this.#connecting = false;
      await this.#onRefused(err);
      return;
    }
    this.#connecting = false;
    await this.#onConnected();
  }

  async #onConnected() {
    const client = this.#client;
    this.#connected = true;
    this.#everConnected = true;
    this.#disconnectedSince = null;
    this.#backoffMs = BACKOFF_MIN_MS;
    this.#lastRefusal = null;
    this.#lastBanSeconds = null;
    try {
      // The channel tree and our own place in it arrive just after the handshake.
      await client.view.whenReady({ signal: AbortSignal.timeout(10_000) });
    } catch {
      this.log.debug('the server view was not ready in time');
    }
    this.me = { clid: String(client.clientID), cid: String(client.channelID) };
    try {
      // A client only sees the people in channels it is subscribed to. Subscribe to all, so
      // !join and the group check work for users in other channels too (Classic sees all).
      await subscribeAllChannels(client);
    } catch (err) {
      this.log.warn(`could not subscribe to all channels (!join may not find users elsewhere): ${err.message}`);
    }
    try {
      // The server only relays our voice while we say we have a working microphone.
      await updateClient(client, { hasInputHardware: true, hasOutputHardware: true, isInputMuted: false });
    } catch (err) {
      this.log.warn(`could not update the client state: ${err.message}`);
    }
    this.log.info(`connected to server (clid=${this.me.clid}, cid=${this.me.cid})`);
    this.emit('connected', { ...this.me });
  }

  #onDisconnected(error) {
    if (this.#stopping) return;
    const wasConnected = this.#connected;
    this.#connected = false;
    this.#disconnectedSince ??= Date.now();
    const lastClid = this.me.clid;
    this.me = { clid: null, cid: null };
    if (wasConnected) this.emit('disconnected');

    if (error instanceof RemovedError) {
      const by = error.invokerName ? ` by ${error.invokerName}` : '';
      const why = error.reasonMessage ? `: ${error.reasonMessage}` : '';
      if (error.reason === Reason.KickServer) {
        this.log.warn(`kicked from the server${by}${why}; rejoining in ${KICK_DELAY_MS / 1000}s`);
        this.#schedule(KICK_DELAY_MS, 'kick');
        return;
      }
      if (error.reason === Reason.KickServerBan) {
        // Wait a moment for the leave notification that carries the ban duration.
        this.me = { clid: lastClid, cid: null };
        setTimeout(() => {
          this.me = { clid: null, cid: null };
          const seconds = this.#lastBanSeconds;
          const ms = seconds > 0 ? seconds * 1000 + 5_000 : BAN_DEFAULT_MS;
          this.#bannedUntil = Date.now() + ms;
          this.log.error(`BANNED from the server${by}${why} (${seconds > 0 ? `${seconds}s` : 'permanent or unknown'}); trying again in ${Math.round(ms / 1000)}s`);
          this.#schedule(ms, 'ban');
        }, BANTIME_WAIT_MS);
        return;
      }
      // Server stopped or shut down: it is probably restarting.
      this.log.warn(`disconnected: ${error.message}`);
      this.#schedule(BACKOFF_MIN_MS, 'server stop');
      return;
    }
    this.log.warn(`connection lost${error ? `: ${error.message}` : ''}`);
    this.#schedule(this.#nextBackoff(), 'connection lost');
  }

  /** A connect attempt failed: work out why, say so once, and decide when to try again. */
  async #onRefused(err) {
    if (this.#stopping) return;
    this.#disconnectedSince ??= Date.now();
    const code = err instanceof ServerError ? err.code : null;
    let delay = this.#nextBackoff();
    let message = `could not connect: ${err.message}`;
    let level = 'warn';

    if (code === ErrorCode.ClientCouldNotValidateIdentity && Number(err.extraMessage) > 0) {
      // The server wants a higher identity security level; it says which.
      const needed = Number(err.extraMessage);
      this.log.warn(`the server requires identity security level ${needed}`);
      try {
        this.#identity = await this.#loadIdentity(needed);
        this.#createClient();
        delay = 0;
        message = null;
      } catch (e) {
        message = `could not raise the identity's security level: ${e.message}`;
        level = 'error';
      }
    } else if (code === ErrorCode.ClientTooManyClonesConnected) {
      delay = CLONE_RETRY_MS;
      message = 'the server still holds our previous session; retrying until it lets go';
    } else if (code === ErrorCode.ServerInvalidPassword) {
      delay = PASSWORD_RETRY_MS;
      message = 'the server refused the password: check TS3_SERVER_PASSWORD';
      level = 'error';
    } else if (code === ErrorCode.ConnectFailedBanned || code === ErrorCode.BanFlooding) {
      const flood = /flood/i.test(err.message);
      delay = flood ? FLOOD_BLOCK_MS : BAN_DEFAULT_MS;
      this.#bannedUntil = Date.now() + delay;
      message = flood
        ? "the server's flood protection is blocking this IP for a while"
        : "the bot's identity, IP or nickname is banned on this server";
      level = 'error';
    } else if (code === ErrorCode.ChannelInvalidPassword) {
      message = 'the channel password is wrong: check TS3_CHANNEL_PASSWORD';
      level = 'error';
    }

    if (message && message !== this.#lastRefusal) {
      this.#lastRefusal = message;
      this.log[level](`${message}${delay ? ` (retrying in ${Math.round(delay / 1000)}s)` : ''}`);
    } else if (message) {
      this.log.debug(`${message} (retrying in ${Math.round(delay / 1000)}s)`);
    }
    if (!this.#everConnected && code === null) this.log.debug('first connection attempt failed; check TS3_HOST and TS3_PORT');
    this.#schedule(delay, 'refused');
  }

  #nextBackoff() {
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS);
    return delay;
  }

  #schedule(ms, why) {
    if (this.#stopping) return;
    clearTimeout(this.#retryTimer);
    this.#retryAt = Date.now() + ms;
    this.log.debug(`reconnecting in ${Math.round(ms / 1000)}s (${why})`);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#retryAt = null;
      this.#connect();
    }, ms);
  }

  // ---------------------------------------------------------------------------
  // What the bot asks of the engine
  // ---------------------------------------------------------------------------

  #sendVoice(frame) {
    if (!this.#connected) return false;
    try {
      this.#client.sendVoice(frame, Codec.OpusMusic);
      return true;
    } catch {
      return false;
    }
  }

  /** Voice is only sent while music plays, so there is nothing to switch. */
  async setTransmitting() {}

  async sendText(target, chunk) {
    if (!this.#connected) return false;
    try {
      if (target.mode === 'private') await sendPrivateMessage(this.#client, asClientID(Number(target.clid)), chunk);
      else await sendChannelMessage(this.#client, chunk);
      return true;
    } catch (err) {
      if (err instanceof ServerError && err.code === ErrorCode.ClientIsFlooding) err.flood = true;
      throw err;
    }
  }

  async moveToClientChannel(clid) {
    const target = this.#client.view.clients.get(asClientID(Number(clid)))
      ?? (await new Promise((r) => setTimeout(r, 500)), this.#client.view.clients.get(asClientID(Number(clid))));
    if (!target) return { notFound: true };
    if (String(target.channelID) === this.me.cid) return { already: true };
    await moveClient(this.#client, this.#client.clientID, target.channelID);
    return { moved: true };
  }

  async clientInfo(clid) {
    const c = this.#client.view.clients.get(asClientID(Number(clid)));
    if (!c) throw new Error(`client ${clid} is not in view`);
    return { uid: String(c.uid ?? ''), name: c.nickname, groups: (c.serverGroups ?? []).map(String) };
  }

  async channelSettings(cid) {
    const view = this.#client.view;
    const ch = view.channels.get(asChannelID(BigInt(cid)));
    const me = view.clients.get(this.#client.clientID);
    if (!ch) throw new Error(`channel ${cid} is not in view`);
    return {
      codec: Number(ch.codec ?? 5),
      quality: Number(ch.codecQuality ?? 10),
      neededTalkPower: Number(ch.neededTalkPower ?? 0),
      talkPower: Number(me?.talkPower ?? 0),
      isTalker: Boolean(me?.isTalker),
    };
  }
}
