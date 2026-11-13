import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOP_MODES } from '../player.js';
import { logEvents, recentLogs } from '../log.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
};
const COOKIE = 'mendil_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const MAX_BODY = 16 * 1024;
const STATE_TICK_MS = 1_000;
const CSP = [
  "default-src 'self'", "img-src 'self' data: https://i.ytimg.com", "style-src 'self'", "script-src 'self'",
  "font-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

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
  #clients = new Set(); // SSE responses
  #lastState = '';
  #timer = null;
  #attempts = new Map(); // ip -> { count, resetAt }
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
    for (const e of ['trackStart', 'trackError', 'halted', 'idle']) this.bot.player.on(e, push);
    for (const e of ['connected', 'disconnected', 'moved']) this.bot.voice.on(e, push);
    logEvents.on('line', this.#onLog);
    this.#timer = setInterval(push, STATE_TICK_MS);
    this.#timer.unref();
  }

  async stop() {
    clearInterval(this.#timer);
    logEvents.off('line', this.#onLog);
    for (const res of this.#clients) res.end();
    await new Promise((resolve) => (this.#server ? this.#server.close(resolve) : resolve()));
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  state() {
    const { player, voice, config } = this.bot;
    const track = (t) => t && ({ title: t.title, url: t.url, duration: t.duration ?? null, isLive: Boolean(t.isLive), requestedBy: t.requestedBy ?? null });
    return {
      lang: config.bot.language,
      nickname: config.ts3.nickname,
      engine: config.voice.backend,
      connected: voice.connected,
      channel: voice.me.cid,
      channelName: voice.connected ? this.bot.channelName ?? null : null,
      disconnectedSince: voice.disconnectedSince,
      current: player.current ? { ...track(player.current), position: Math.floor(player.current.position ?? 0) } : null,
      paused: player.paused,
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
    for (const res of this.#clients) res.write(`event: state\ndata: ${json}\n\n`);
  }

  #send(event, data) {
    if (this.#clients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.#clients) res.write(payload);
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

  #session(req) {
    const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
    if (!cookie) return false;
    const [exp, sig] = cookie.slice(COOKIE.length + 1).split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const expected = this.#sign(exp);
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  /** Signs an expiry time; includes the password, so changing it logs everyone out. */
  #sign(exp) {
    return crypto.createHmac('sha256', this.secret).update(exp).update(this.passwordHash).digest('base64url');
  }

  #sessionCookie(req, maxAgeMs) {
    const exp = String(Date.now() + maxAgeMs);
    const sig = this.#sign(exp);
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
    return `${COOKIE}=${exp}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
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
      if (route === '/api/logout') {
        return this.#json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
      }
    }
    if (route === '/api/session') return this.#json(res, 200, { loggedIn: this.#session(req), lang: this.config.bot.language });
    if (!this.#session(req)) return this.#json(res, 401, { error: 'loginRequired' });

    if (req.method === 'GET') {
      if (route === '/api/state') return this.#json(res, 200, this.state());
      if (route === '/api/logs') return this.#json(res, 200, recentLogs());
      if (route === '/api/events') return this.#events(req, res);
      return this.#json(res, 404, { error: 'notFound' });
    }
    if (req.method !== 'POST') return this.#json(res, 405, { error: 'methodNotAllowed' });

    let body;
    try {
      body = await this.#body(req);
    } catch (err) {
      return this.#json(res, err.status ?? 400, { error: err.message });
    }
    const result = await this.#action(route, body);
    this.#pushState();
    return this.#json(res, result.status ?? 200, result.body);
  }

  async #action(route, body) {
    const { player, requests, i18n } = this.bot;
    const ok = (extra = {}) => ({ body: { ok: true, ...extra } });
    const fail = (error, status = 400) => ({ status, body: { ok: false, error } });
    const requestedBy = i18n.t('panelUser');

    switch (route) {
      case '/api/play': {
        const query = String(body.query ?? '').trim().slice(0, 500);
        const result = await requests.request(query, { front: Boolean(body.next), requestedBy });
        if (!result.ok) return fail(result.error, 200);
        return ok({ added: result.added.map((t) => t.title), position: result.position, playlistTitle: result.playlistTitle, tooLong: result.tooLong });
      }
      case '/api/search': {
        const query = String(body.query ?? '').trim().slice(0, 200);
        if (!query) return fail('empty');
        const result = await requests.search(query);
        if (!result.ok) return fail(result.error, 200);
        return ok({ results: result.results.map((t) => ({ title: t.title, url: t.url, duration: t.duration, isLive: t.isLive })) });
      }
      case '/api/skip':
        return player.skip() ? ok() : fail('nothingPlaying', 200);
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
      case '/api/remove': {
        // The URL guards against removing the wrong track if the queue changed meanwhile.
        const index = Number(body.index);
        if (!Number.isInteger(index) || index < 1 || index > player.queue.length) return fail('badIndex');
        if (body.url && player.queue[index - 1].url !== body.url) return fail('queueChanged', 409);
        player.remove(index);
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

  async #login(req, res) {
    const ip = this.#clientIp(req);
    const now = Date.now();
    const a = this.#attempts.get(ip);
    if (a && a.resetAt > now && a.count >= LOGIN_MAX_ATTEMPTS) return this.#json(res, 429, { ok: false, error: 'tooManyAttempts' });
    let body;
    try {
      body = await this.#body(req);
    } catch (err) {
      return this.#json(res, err.status ?? 400, { ok: false, error: err.message });
    }
    if (crypto.timingSafeEqual(sha256(body.password ?? ''), this.passwordHash)) {
      this.#attempts.delete(ip);
      return this.#json(res, 200, { ok: true }, { 'Set-Cookie': this.#sessionCookie(req, SESSION_MS) });
    }
    const entry = a && a.resetAt > now ? a : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    entry.count++;
    this.#attempts.set(ip, entry);
    this.log.warn(`failed panel login from ${ip}`);
    return this.#json(res, 401, { ok: false, error: 'wrongPassword' });
  }

  #events(req, res) {
    this.#headers(res, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.writeHead(200);
    res.write(`event: state\ndata: ${JSON.stringify(this.state())}\n\n`);
    this.#clients.add(res);
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
