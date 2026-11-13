import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOP_MODES } from '../player.js';
import { logEvents, recentLogs } from '../log.js';
import { mayManage, queueLimitApplies, roleFor } from '../roles.js';
import { findStation } from '../radio.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};
const COOKIE = 'mendil_session';
const SESSION_MS = 30 * 24 * 3600 * 1000; // signed in with the panel password
const TS_SESSION_MS = 7 * 24 * 3600 * 1000; // signed in through TeamSpeak; server groups are re-read at the next sign-in
const CODE_MS = 5 * 60_000;
const CODE_TRIES = 5;
const CODE_RESEND_MS = 30_000; // per TeamSpeak user, so nobody can flood someone's chat with codes
const MAX_PENDING = 100;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const MAX_BODY = 16 * 1024;
const STATE_TICK_MS = 1_000;
const CSP = [
  "default-src 'self'", "img-src 'self' data: https://i.ytimg.com", "style-src 'self'", "script-src 'self'",
  "font-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Playback controls that affect everyone; listeners may only request, and skip or remove their own songs.
const ADMIN_ROUTES = new Set(['/api/stop', '/api/pause', '/api/resume', '/api/clear', '/api/shuffle', '/api/loop', '/api/volume', '/api/radio']);

/** Reads a secret from `file`, or creates one there (readable only by us). Returns [value, created]. */
function secretFile(file, make) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value) return [value, false];
  } catch {
    // create below
  }
  const value = make();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return [value, true];
}

/** Every file under public/, by URL path, so nothing outside it can ever be served. */
function staticFiles() {
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else files.set(`/${prefix}${entry.name}`, full);
    }
  };
  walk(PUBLIC_DIR, '');
  files.set('/', path.join(PUBLIC_DIR, 'index.html'));
  return files;
}

/**
 * The web panel: status, now playing, queue and controls in the browser, next to chat.
 * Plain node:http with server-sent events; the page itself is static (public/).
 */
export class PanelServer {
  #server = null;
  #clients = new Map(); // SSE response -> user
  #lastState = '';
  #timer = null;
  #attempts = new Map(); // ip -> { count, resetAt }
  #pending = new Map(); // TeamSpeak sign-in id -> { uid, name, groups, codeHash, expires, tries }
  #lastCode = new Map(); // uid -> when a code was last sent
  #files = staticFiles();
  #onLog = (line) => this.#send('log', line);

  constructor({ bot, config, log }) {
    this.bot = bot;
    this.config = config;
    this.log = log;
  }

  async start() {
    const { port, host, password } = this.config.panel;
    const dir = this.config.dataDir;
    const [generated, created] = password ? [password, false] : secretFile(path.join(dir, 'panel-password'), () => crypto.randomBytes(12).toString('base64url'));
    this.passwordHash = sha256(generated);
    [this.secret] = secretFile(path.join(dir, 'panel-secret'), () => crypto.randomBytes(32).toString('hex'));

    this.#server = http.createServer((req, res) => this.#handle(req, res).catch((err) => {
      this.log.warn(`request failed: ${err.message}`);
      if (!res.headersSent) this.#json(res, 500, { error: 'internal' });
      else res.end();
    }));
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, host, resolve);
    });
    this.port = this.#server.address().port;
    this.log.info(`web panel on http://${host === '0.0.0.0' ? '<this machine>' : host}:${this.port}`);
    if (created) {
      this.log.info(`web panel password: ${generated} (saved in ${path.join(dir, 'panel-password')}; set PANEL_PASSWORD to choose your own)`);
    } else if (!password) {
      this.log.info(`web panel password: see ${path.join(dir, 'panel-password')}`);
    }

    const push = () => this.#pushState();
    for (const e of ['trackStart', 'trackError', 'halted', 'idle', 'streamTitle']) this.bot.player.on(e, push);
    for (const e of ['connected', 'disconnected', 'moved']) this.bot.voice.on(e, push);
    logEvents.on('line', this.#onLog);
    this.#timer = setInterval(push, STATE_TICK_MS);
    this.#timer.unref();
  }

  async stop() {
    clearInterval(this.#timer);
    logEvents.off('line', this.#onLog);
    for (const res of this.#clients.keys()) res.end();
    await new Promise((resolve) => (this.#server ? this.#server.close(resolve) : resolve()));
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  state() {
    const { player, voice, config } = this.bot;
    const track = (t) => t && ({
      title: t.title, url: t.url, duration: t.duration ?? null, isLive: Boolean(t.isLive),
      requestedBy: t.requestedBy ?? null, requesterUid: t.requesterUid ?? null,
    });
    return {
      lang: config.bot.language,
      nickname: config.ts3.nickname,
      engine: config.voice.backend,
      connected: voice.connected,
      channel: voice.me.cid,
      channelName: voice.connected ? this.bot.channelName ?? null : null,
      disconnectedSince: voice.disconnectedSince,
      current: player.current ? {
        ...track(player.current), position: Math.floor(player.current.position ?? 0),
        radio: Boolean(player.current.radio), streamTitle: player.current.streamTitle ?? null,
        seekable: Boolean(player.seekable),
      } : null,
      paused: player.paused,
      waiting: Boolean(this.bot.waitingForListeners), // paused until someone joins the channel
      radio: player.radio ? { name: player.radio.name, url: player.radio.url } : null,
      stations: (config.radio?.stations ?? []).map((s) => s.name),
      halted: player.halted,
      queue: player.queue.map(track),
      loop: player.loop,
      volume: player.volume,
    };
  }

  #pushState() {
    if (this.#clients.size === 0) return;
    const json = JSON.stringify(this.state());
    if (json === this.#lastState) return;
    this.#lastState = json;
    for (const res of this.#clients.keys()) res.write(`event: state\ndata: ${json}\n\n`);
  }

  /** The log is for admins: it shows unique IDs, addresses and failed sign-ins. */
  #send(event, data) {
    if (this.#clients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [res, user] of this.#clients) if (user.role === 'admin') res.write(payload);
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  #headers(res, extra = {}) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }

  #json(res, status, body, extra = {}) {
    this.#headers(res, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.writeHead(status);
    res.end(JSON.stringify(body));
  }

  /**
   * The signed-in user, or null. The cookie holds who signed in and how, signed with the
   * panel secret and the password, so changing the password signs everyone out. A TeamSpeak
   * user's role is worked out again on every request, so ADMIN_* / ALLOWED_* changes apply
   * at once.
   */
  #session(req) {
    const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
    if (!cookie) return null;
    const [payload, sig] = cookie.slice(COOKIE.length + 1).split('.');
    if (!payload || !sig || !safeEqual(sig, this.#sign(payload))) return null;
    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!(data.exp > Date.now())) return null;
    if (data.via === 'password') return { via: 'password', uid: null, name: null, role: 'admin' };
    if (data.via !== 'ts' || typeof data.uid !== 'string') return null;
    const role = roleFor(this.config.bot, { uid: data.uid, groups: data.groups ?? [] });
    return role === 'none' ? null : { via: 'ts', uid: data.uid, name: String(data.name ?? ''), role };
  }

  #sign(payload) {
    return crypto.createHmac('sha256', this.secret).update(payload).update(this.passwordHash).digest('base64url');
  }

  #sessionCookie(req, maxAgeMs, who) {
    const payload = Buffer.from(JSON.stringify({ ...who, exp: Date.now() + maxAgeMs })).toString('base64url');
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
    return `${COOKIE}=${payload}.${this.#sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
  }

  async #body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(chunk);
    }
    try {
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      throw Object.assign(new Error('invalid JSON'), { status: 400 });
    }
  }

  async #handle(req, res) {
    const url = new URL(req.url, 'http://panel');
    const route = url.pathname;

    if (req.method === 'GET' && this.#files.has(route)) return this.#static(req, res, this.#files.get(route));
    if (!route.startsWith('/api/')) return this.#json(res, 404, { error: 'notFound' });

    if (req.method === 'POST') {
      // Requires a custom header, which a cross-site form or image can't send (CSRF).
      if (req.headers['x-mendil'] !== '1') return this.#json(res, 403, { error: 'forbidden' });
      if (route === '/api/login') return this.#login(req, res);
      if (route === '/api/login/code') return this.#sendCode(req, res);
      if (route === '/api/login/verify') return this.#verifyCode(req, res);
      if (route === '/api/logout') {
        return this.#json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
      }
    }
    const user = this.#session(req);
    if (route === '/api/session') {
      return this.#json(res, 200, {
        loggedIn: Boolean(user), user, lang: this.config.bot.language, teamspeak: this.bot.voice.connected,
      });
    }
    if (!user) return this.#json(res, 401, { error: 'loginRequired' });

    if (req.method === 'GET') {
      if (route === '/api/state') return this.#json(res, 200, this.state());
      if (route === '/api/logs') return user.role === 'admin' ? this.#json(res, 200, recentLogs()) : this.#json(res, 403, { error: 'adminOnly' });
      if (route === '/api/events') return this.#events(req, res, user);
      return this.#json(res, 404, { error: 'notFound' });
    }
    if (req.method !== 'POST') return this.#json(res, 405, { error: 'methodNotAllowed' });

    let body;
    try {
      body = await this.#body(req);
    } catch (err) {
      return this.#json(res, err.status ?? 400, { error: err.message });
    }
    const result = await this.#action(route, body, user);
    this.#pushState();
    return this.#json(res, result.status ?? 200, result.body);
  }

  async #action(route, body, user) {
    const { player, requests, i18n } = this.bot;
    const ok = (extra = {}) => ({ body: { ok: true, ...extra } });
    const fail = (error, status = 400) => ({ status, body: { ok: false, error } });
    const requestedBy = user.via === 'ts' ? user.name : i18n.t('panelUser');
    const requesterUid = user.uid;
    const admin = user.role === 'admin';
    if (!admin && (ADMIN_ROUTES.has(route) || (route === '/api/play' && body.next))) return fail('adminOnly', 403);

    switch (route) {
      case '/api/play': {
        const query = String(body.query ?? '').trim().slice(0, 500);
        const limit = queueLimitApplies(this.config.bot, user);
        const result = await requests.request(query, { front: Boolean(body.next), requestedBy, requesterUid, limit });
        if (!result.ok) return { status: 200, body: { ok: false, error: result.error, max: result.max } };
        return ok({
          added: result.added.map((t) => t.title), position: result.position, playlistTitle: result.playlistTitle,
          tooLong: result.tooLong, limited: result.limited ?? 0, max: result.max,
        });
      }
      case '/api/search': {
        const query = String(body.query ?? '').trim().slice(0, 200);
        if (!query) return fail('empty');
        const result = await requests.search(query);
        if (!result.ok) return fail(result.error, 200);
        return ok({ results: result.results.map((t) => ({ title: t.title, url: t.url, duration: t.duration, isLive: t.isLive })) });
      }
      case '/api/skip':
        if (!player.current) return fail('nothingPlaying', 200);
        if (!mayManage(user, player.current)) return fail('notYours', 403);
        player.skip();
        return ok();
      case '/api/stop':
        player.stop();
        return ok();
      case '/api/pause':
        if (!player.pause()) return fail('nothingPlaying', 200);
        this.bot.setTransmitting(false);
        return ok();
      case '/api/resume':
        if (!player.resume()) return fail('notPaused', 200);
        this.bot.setTransmitting(true);
        return ok();
      case '/api/clear':
        return ok({ count: player.clear() });
      case '/api/shuffle':
        player.shuffle();
        return ok();
      case '/api/seek': {
        if (!player.current) return fail('nothingPlaying', 200);
        if (!player.seekable) return fail('notSeekable', 200);
        if (!mayManage(user, player.current)) return fail('notYours', 403);
        const at = player.seek(Number(body.position));
        return at === null ? fail('badPosition') : ok({ position: at });
      }
      case '/api/remove': {
        // The URL guards against removing the wrong track if the queue changed meanwhile.
        const index = Number(body.index);
        if (!Number.isInteger(index) || index < 1 || index > player.queue.length) return fail('badIndex');
        if (body.url && player.queue[index - 1].url !== body.url) return fail('queueChanged', 409);
        if (!mayManage(user, player.queue[index - 1])) return fail('notYours', 403);
        player.remove(index);
        return ok();
      }
      case '/api/radio': {
        // Stations from RADIO_STATIONS only; other addresses go through chat (!radio <link>).
        if (body.station == null || body.station === '') {
          player.setRadio(null);
          return ok();
        }
        const stations = this.bot.config.radio?.stations ?? [];
        const station = findStation(stations, String(body.station));
        if (!station || !stations.includes(station)) return fail('unknownStation');
        player.setRadio(station);
        return ok();
      }
      case '/api/loop':
        if (!LOOP_MODES.includes(body.mode)) return fail('badMode');
        player.loop = body.mode;
        return ok();
      case '/api/volume': {
        const volume = Number(body.volume);
        if (!Number.isFinite(volume) || volume < 0 || volume > 100) return fail('badVolume');
        await player.setVolume(volume);
        return ok({ volume: player.volume });
      }
      default:
        return fail('notFound', 404);
    }
  }

  /** The client's address. Behind a reverse proxy (PANEL_TRUST_PROXY) it's the last X-Forwarded-For hop. */
  #clientIp(req) {
    const forwarded = this.config.panel.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop() : null;
    return forwarded || req.socket.remoteAddress || '?';
  }

  /** Counts sign-in attempts per address; false once there have been too many. */
  #attempt(ip, { failed }) {
    const now = Date.now();
    const a = this.#attempts.get(ip);
    if (a && a.resetAt > now && a.count >= LOGIN_MAX_ATTEMPTS) return false;
    if (failed) {
      const entry = a && a.resetAt > now ? a : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      entry.count++;
      this.#attempts.set(ip, entry);
    }
    return true;
  }

  async #login(req, res) {
    const ip = this.#clientIp(req);
    if (!this.#attempt(ip, { failed: false })) return this.#json(res, 429, { ok: false, error: 'tooManyAttempts' });
    let body;
    try {
      body = await this.#body(req);
    } catch (err) {
      return this.#json(res, err.status ?? 400, { ok: false, error: err.message });
    }
    if (crypto.timingSafeEqual(sha256(body.password ?? ''), this.passwordHash)) {
      this.#attempts.delete(ip);
      return this.#json(res, 200, { ok: true }, { 'Set-Cookie': this.#sessionCookie(req, SESSION_MS, { via: 'password' }) });
    }
    this.#attempt(ip, { failed: true });
    this.log.warn(`failed panel login from ${ip}`);
    return this.#json(res, 401, { ok: false, error: 'wrongPassword' });
  }

  /**
   * TeamSpeak sign-in, step 1: finds the online user with that nickname and sends them a
   * one-time code in a private message. Whoever can read that chat is that user.
   */
  async #sendCode(req, res) {
    const ip = this.#clientIp(req);
    // Every code request counts, so this can't be used to probe nicknames or spam people.
    if (!this.#attempt(ip, { failed: true })) return this.#json(res, 429, { ok: false, error: 'tooManyAttempts' });
    let body;
    try {
      body = await this.#body(req);
    } catch (err) {
      return this.#json(res, err.status ?? 400, { ok: false, error: err.message });
    }
    const nickname = String(body.nickname ?? '').trim().slice(0, 64);
    if (!nickname) return this.#json(res, 400, { ok: false, error: 'empty' });
    if (!this.bot.voice.connected) return this.#json(res, 503, { ok: false, error: 'teamspeakOffline' });

    let client;
    try {
      client = await this.bot.findClient(nickname);
    } catch (err) {
      this.log.warn(`panel sign-in: could not look up "${nickname}": ${err.message}`);
    }
    if (!client) return this.#json(res, 404, { ok: false, error: 'notOnline' });
    if (roleFor(this.config.bot, client) === 'none') return this.#json(res, 403, { ok: false, error: 'notAllowed' });

    const now = Date.now();
    for (const [id, p] of this.#pending) if (p.expires < now) this.#pending.delete(id);
    if (now - (this.#lastCode.get(client.uid) ?? 0) < CODE_RESEND_MS) return this.#json(res, 429, { ok: false, error: 'codeRecentlySent' });
    if (this.#pending.size >= MAX_PENDING) return this.#json(res, 429, { ok: false, error: 'tooManyAttempts' });

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const id = crypto.randomBytes(16).toString('base64url');
    this.#pending.set(id, { uid: client.uid, name: client.name, groups: client.groups, codeHash: sha256(code), expires: now + CODE_MS, tries: 0 });
    this.#lastCode.set(client.uid, now);
    await this.bot.sendPrivate(client.clid, this.bot.i18n.t('panelCode', { code }));
    this.log.info(`panel sign-in: sent a code to ${client.name} (${client.uid}) for ${ip}`);
    return this.#json(res, 200, { ok: true, id, name: client.name });
  }

  /** TeamSpeak sign-in, step 2: the code from the private message. */
  async #verifyCode(req, res) {
    const ip = this.#clientIp(req);
    if (!this.#attempt(ip, { failed: false })) return this.#json(res, 429, { ok: false, error: 'tooManyAttempts' });
    let body;
    try {
      body = await this.#body(req);
    } catch (err) {
      return this.#json(res, err.status ?? 400, { ok: false, error: err.message });
    }
    const pending = this.#pending.get(String(body.id ?? ''));
    if (!pending || pending.expires < Date.now() || pending.tries >= CODE_TRIES) {
      this.#pending.delete(String(body.id ?? ''));
      return this.#json(res, 410, { ok: false, error: 'codeExpired' });
    }
    const code = String(body.code ?? '').replace(/\s+/g, '');
    if (!crypto.timingSafeEqual(sha256(code), pending.codeHash)) {
      pending.tries++;
      this.#attempt(ip, { failed: true });
      this.log.warn(`failed panel sign-in code for ${pending.name} from ${ip}`);
      return this.#json(res, 401, { ok: false, error: 'wrongCode' });
    }
    this.#pending.delete(String(body.id));
    this.#attempts.delete(ip);
    const role = roleFor(this.config.bot, pending);
    if (role === 'none') return this.#json(res, 403, { ok: false, error: 'notAllowed' });
    this.log.info(`panel sign-in: ${pending.name} (${pending.uid}) as ${role}`);
    const who = { via: 'ts', uid: pending.uid, name: pending.name, groups: pending.groups };
    return this.#json(res, 200, { ok: true }, { 'Set-Cookie': this.#sessionCookie(req, TS_SESSION_MS, who) });
  }

  #events(req, res, user) {
    this.#headers(res, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.writeHead(200);
    res.write(`event: state\ndata: ${JSON.stringify(this.state())}\n\n`);
    this.#clients.set(res, user);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      this.#clients.delete(res);
    });
  }

  #static(req, res, file) {
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    // Revalidated every time (cheap 304s), so an update never leaves a stale page around.
    fs.stat(file, (statErr, stat) => {
      if (statErr) return this.#json(res, 404, { error: 'notFound' });
      const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
      this.#headers(res, { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag });
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        return res.end();
      }
      fs.readFile(file, (err, data) => {
        if (err) return this.#json(res, 404, { error: 'notFound' });
        res.writeHead(200);
        res.end(data);
      });
    });
  }
}
