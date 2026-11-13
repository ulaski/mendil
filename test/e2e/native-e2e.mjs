// End-to-end test of the native engine against a real TeamSpeak 3 or 6 server.
//
//   TS_HOST=127.0.0.1 TS_PORT=9987 node test/e2e/native-e2e.mjs
//
// Starts Mendil (VOICE_BACKEND=native) and a test client in the server's default channel,
// serves a generated tone over local HTTP (no YouTube needed), and checks that chat
// commands are answered and that Mendil's voice actually arrives. Needs ffmpeg and yt-dlp.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client, generateIdentity } from '@honeybbq/teamspeak/client';
import { sendPrivateMessage, updateClient } from '@honeybbq/teamspeak';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const host = process.env.TS_HOST || '127.0.0.1';
const port = Number(process.env.TS_PORT || 9987);
const nickname = `MendilE2E${process.pid % 1000}`;
const deadline = Date.now() + Number(process.env.E2E_TIMEOUT_MS || 180_000);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendil-e2e-'));
const log = (...a) => console.log(`[e2e] ${a.join(' ')}`);
let mendil;
let failed = false;

function fail(message) {
  failed = true;
  throw new Error(message);
}

async function until(what, predicate, ms = 30_000) {
  const end = Math.min(Date.now() + ms, deadline);
  while (!(await predicate())) {
    if (Date.now() > end) fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// 1. A 30 s tone, served over HTTP like any media file on the web.
const tone = path.join(dir, 'tone.mp3');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
  '-c:a', 'libmp3lame', '-b:a', '128k', tone]);
const server = http.createServer((req, res) => {
  if (req.url === '/radio') {
    // A radio station: the tone on repeat, with an ICY title every 8 KB.
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'icy-metaint': '8192' });
    const audio = fs.readFileSync(tone);
    const meta = Buffer.alloc(32);
    Buffer.from("StreamTitle='E2E - Tone';").copy(meta);
    let offset = 0;
    const timer = setInterval(() => {
      const chunk = Buffer.alloc(8192);
      for (let i = 0; i < chunk.length; i++) chunk[i] = audio[(offset + i) % audio.length];
      offset += chunk.length;
      res.write(Buffer.concat([chunk, Buffer.from([2]), meta]));
    }, 400); // 8 KB per 0.4 s is a bit faster than 128 kbit/s
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (req.url !== '/tone.mp3') return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': fs.statSync(tone).size });
  fs.createReadStream(tone).pipe(res);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const toneUrl = `http://127.0.0.1:${server.address().port}/tone.mp3`;

// 2. Mendil with the native engine, and its web panel on a free port.
const panelPort = await new Promise((resolve) => {
  const probe = http.createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
const output = [];
mendil = spawn(process.execPath, [path.join(ROOT, 'src/index.js')], {
  env: {
    ...process.env,
    TS3_HOST: host,
    TS3_PORT: String(port),
    VOICE_BACKEND: 'native',
    BOT_NICKNAME: nickname,
    BOT_LANGUAGE: 'en',
    MENDIL_DATA_DIR: path.join(dir, 'data'),
    PREFETCH_DIR: path.join(dir, 'cache'),
    ALLOW_PRIVATE_URLS: 'true',
    YTDLP_AUTO_UPDATE: 'false',
    CHANNEL_HINTS: 'false',
    LOG_LEVEL: 'debug',
    PANEL_PORT: String(panelPort),
    PANEL_HOST: '127.0.0.1',
    PANEL_PASSWORD: 'e2e-password',
    RADIO_STATIONS: `E2E FM=http://127.0.0.1:${server.address().port}/radio`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const s of [mendil.stdout, mendil.stderr]) s.on('data', (c) => output.push(c.toString()));
mendil.on('exit', (code) => {
  if (!failed && code !== null && code !== 0) log(`Mendil exited early with ${code}`);
});

// 3. A test client: sends commands, collects replies and counts Mendil's voice frames.
const client = new Client(await generateIdentity(8), `${host}:${port}`, 'E2ETester');
const replies = [];
let frames = 0;
let lastFrameAt = 0;
let mendilClid = null;
client.on('textMessage', (m) => {
  if (m.invokerName === nickname) replies.push(m.message);
});

/** A JSON call to the panel; returns { status, json, cookie }. */
async function panel(route, body, cookie) {
  const res = await fetch(`http://127.0.0.1:${panelPort}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-mendil': '1', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
client.on('voiceData', (v) => {
  if (mendilClid !== null && Number(v.clientID) === mendilClid && v.data.length) {
    frames++;
    lastFrameAt = Date.now();
  }
});

async function ask(text, expect) {
  const before = replies.length;
  await sendPrivateMessage(client, mendilClid, text);
  await until(`a reply to "${text}"`, () => replies.length > before);
  // Long replies come in several messages, 300 ms apart: wait until they stop.
  let count = -1;
  while (count !== replies.length) {
    count = replies.length;
    await sleep(700);
  }
  const reply = replies.slice(before).join('\n');
  if (expect && !expect.test(reply)) fail(`unexpected reply to "${text}": ${reply}`);
  log(`${text} -> ${reply.slice(0, 100).replace(/\n/g, ' | ')}`);
  return reply;
}

try {
  await client.connect({ signal: AbortSignal.timeout(30_000) });
  await updateClient(client, { hasOutputHardware: true, isOutputMuted: false });
  log(`test client connected (clid ${client.clientID})`);

  await until('Mendil to join', () => {
    for (const [id, c] of client.view.clients) {
      if (c.nickname === nickname) mendilClid = id;
    }
    return mendilClid !== null;
  }, 90_000);
  log(`Mendil is here (clid ${mendilClid})`);

  await ask('!help', /!play/);
  await ask('!vol 80', /80%/);
  await ask(`!play ${toneUrl}`);
  await until('voice from Mendil', () => frames >= 100, 60_000); // 2 s of audio
  log(`receiving voice: ${frames} frames`);
  await ask('!np', /tone/i);
  await ask('!pause', /Paused/);
  const pausedAt = frames;
  await sleep(1_500);
  if (frames - pausedAt > 60) fail(`still sending while paused (${frames - pausedAt} frames)`);
  await ask('!resume', /Resumed/);
  await until('voice after resume', () => frames > pausedAt + 50, 15_000);
  await ask('!stop', /Stopped/);
  await sleep(1_500);
  if (Date.now() - lastFrameAt < 1_000) fail('still sending after !stop');

  // Radio: plays while the queue is empty, with the station's song title.
  await ask('!radio e2e fm', /Radio on: E2E FM/);
  const radioFrom = frames;
  await until('voice from the radio', () => frames >= radioFrom + 100, 30_000);
  await ask('!np', /E2E FM.*: E2E - Tone/);
  await ask('!radio off', /Radio turned off/);
  log(`radio: ${frames - radioFrom} frames`);

  // Web panel: sign in as the test client with a code sent by private message.
  const before = replies.length;
  const sent = await panel('/api/login/code', { nickname: 'e2etester' });
  if (sent.status !== 200) fail(`panel code request failed: ${JSON.stringify(sent.json)}`);
  await until('the panel code by private message', () => replies.length > before);
  const code = replies.at(-1).match(/\d{6}/)?.[0];
  if (!code) fail(`no code in "${replies.at(-1)}"`);
  const verified = await panel('/api/login/verify', { id: sent.json.id, code });
  if (verified.status !== 200 || !verified.cookie) fail(`panel sign-in failed: ${JSON.stringify(verified.json)}`);
  const session = await panel('/api/session', null, verified.cookie);
  if (session.json.user?.name !== 'E2ETester' || session.json.user?.role !== 'admin') fail(`unexpected session ${JSON.stringify(session.json)}`);
  log(`panel sign-in through TeamSpeak: ${session.json.user.name} (${session.json.user.role})`);
  log(`PASS: ${frames} frames received`);
} catch (err) {
  failed = true;
  console.error(`[e2e] FAIL: ${err.message}`);
  console.error('--- Mendil output ---');
  console.error(output.join('').split('\n').slice(-60).join('\n'));
} finally {
  await client.disconnect().catch(() => {});
  mendil.kill('SIGTERM');
  server.close();
  await sleep(500);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
