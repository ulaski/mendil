import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PanelServer } from '../src/panel/server.js';

const quietLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

// A bot with just what the panel reads and calls.
const player = Object.assign(new EventEmitter(), {
  current: { title: 'Song', url: 'https://www.youtube.com/watch?v=abc', duration: 200, position: 42, requestedBy: 'Ali' },
  queue: [{ title: 'Next', url: 'https://example.com/next.mp3', duration: 100 }],
  paused: false, halted: false, loop: 'off', volume: 70,
  skip() { this.skipped = true; return true; },
  stop() { this.queue = []; },
  pause() { return true; }, resume() { return true; },
  clear() { const n = this.queue.length; this.queue = []; return n; },
  shuffle() {}, remove(i) { return this.queue.splice(i - 1, 1)[0]; },
  async setVolume(v) { this.volume = v; },
});
const voice = Object.assign(new EventEmitter(), { connected: true, me: { clid: '1', cid: '4' }, disconnectedSince: null });
const requested = [];
const bot = {
  player, voice, channelName: 'Music',
  config: { bot: { language: 'en' }, ts3: { nickname: 'Mendil' }, voice: { backend: 'native' } },
  i18n: { t: () => 'the web panel' },
  setTransmitting() {},
  requests: {
    async request(query, opts) { requested.push({ query, ...opts }); return { ok: true, added: [{ title: query }], position: 2, playlistTitle: null, tooLong: 0 }; },
    async search() { return { ok: true, results: [{ title: 'R', url: 'https://www.youtube.com/watch?v=r', duration: 60, isLive: false }] }; },
  },
};

let panel;
let base;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendil-panel-'));

before(async () => {
  panel = new PanelServer({ bot, log: quietLog, config: { dataDir: dir, bot: { language: 'en' }, panel: { port: 0, host: '127.0.0.1', password: 'secret-pw' } } });
  // port 0: let the OS pick
  await panel.start();
});
after(() => panel.stop());

function call(method, route, { body, cookie, csrf = true, raw } = {}) {
  const port = panel.port;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(csrf && method === 'POST' ? { 'x-mendil': '1' } : {}),
      ...(cookie ? { cookie } : {}),
    } }, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
        if (raw && data.includes('\n\n')) res.destroy(); // SSE: first event is enough
      });
      res.on('close', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login() {
  const res = await call('POST', '/api/login', { body: { password: 'secret-pw' } });
  assert.equal(res.status, 200);
  return res.headers['set-cookie'][0].split(';')[0];
}

test('serves the page with a strict content security policy', async () => {
  const res = await call('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<title>Mendil<\/title>/);
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(res.headers['x-frame-options'], 'DENY');
});

test('only files inside public/ are served', async () => {
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/fonts/../../server.js', '/etc/passwd']) {
    const res = await call('GET', p);
    assert.notEqual(res.status, 200, p);
    assert.ok(!res.text.includes('PanelServer'), p);
  }
});

test('the API needs a login, and a wrong password is refused', async () => {
  assert.equal((await call('GET', '/api/state')).status, 401);
  assert.equal((await call('POST', '/api/skip')).status, 401);
  const wrong = await call('POST', '/api/login', { body: { password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, 'wrongPassword');
  assert.equal((await call('GET', '/api/session')).json.loggedIn, false);
});

test('the session cookie is HttpOnly and SameSite=Strict, and works', async () => {
  const res = await call('POST', '/api/login', { body: { password: 'secret-pw' } });
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const state = await call('GET', '/api/state', { cookie: cookie.split(';')[0] });
  assert.equal(state.status, 200);
  assert.equal(state.json.current.title, 'Song');
  assert.equal(state.json.channelName, 'Music');
  assert.equal(state.json.queue.length, 1);
});

test('a forged session cookie is refused', async () => {
  const exp = Date.now() + 60_000;
  assert.equal((await call('GET', '/api/state', { cookie: `mendil_session=${exp}.forged` })).status, 401);
});

test('POSTs without the X-Mendil header are refused (CSRF)', async () => {
  const cookie = await login();
  const res = await call('POST', '/api/skip', { cookie, csrf: false });
  assert.equal(res.status, 403);
});

test('actions go through: play, skip, volume, loop, remove', async () => {
  const cookie = await login();
  const play = await call('POST', '/api/play', { cookie, body: { query: 'fontaines dc', next: true } });
  assert.deepEqual(play.json, { ok: true, added: ['fontaines dc'], position: 2, playlistTitle: null, tooLong: 0 });
  assert.deepEqual(requested.at(-1), { query: 'fontaines dc', front: true, requestedBy: 'the web panel' });
  assert.equal((await call('POST', '/api/skip', { cookie })).json.ok, true);
  assert.equal(player.skipped, true);
  assert.equal((await call('POST', '/api/volume', { cookie, body: { volume: 55 } })).json.volume, 55);
  assert.equal((await call('POST', '/api/volume', { cookie, body: { volume: 500 } })).status, 400);
  assert.equal((await call('POST', '/api/loop', { cookie, body: { mode: 'all' } })).json.ok, true);
  assert.equal(player.loop, 'all');
  assert.equal((await call('POST', '/api/loop', { cookie, body: { mode: 'forever' } })).status, 400);
  player.queue = [{ title: 'A', url: 'https://a' }, { title: 'B', url: 'https://b' }];
  assert.equal((await call('POST', '/api/remove', { cookie, body: { index: 1, url: 'https://b' } })).status, 409, 'stale index');
  assert.equal((await call('POST', '/api/remove', { cookie, body: { index: 2, url: 'https://b' } })).json.ok, true);
  assert.deepEqual(player.queue.map((q) => q.title), ['A']);
});

test('the event stream starts with the current state', async () => {
  const cookie = await login();
  const res = await call('GET', '/api/events', { cookie, raw: true });
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.match(res.text, /^event: state\ndata: \{/);
});

test('too many wrong passwords are rate limited', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await call('POST', '/api/login', { body: { password: `x${i}` } });
  assert.equal(last.status, 429);
});
