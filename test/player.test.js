import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Player, MAX_CONSECUTIVE_FAILURES } from '../src/player.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bin');
const quietLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function createPlayer() {
  const player = new Player({
    sink: 'test',
    defaultVolume: 50,
    normalize: false,
    log: quietLog,
    bin: { ytdlp: path.join(BIN, 'yt-dlp'), ffmpeg: path.join(BIN, 'ffmpeg') },
  });
  const events = [];
  for (const name of ['trackStart', 'trackError', 'halted', 'idle']) {
    player.on(name, (track) => events.push([name, track?.url]));
  }
  return { player, events };
}

const track = (url) => ({ title: url, url, duration: 1 });

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(20);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('announces a track only once audio flows, then plays the queue to the end', async () => {
  const { player, events } = createPlayer();
  player.add([track('ok://quick'), track('ok://quick')]);
  await waitFor(() => events.some(([e]) => e === 'idle'));
  assert.deepEqual(events.map(([e]) => e), ['trackStart', 'trackStart', 'idle']);
});

test('a failing track gives one error message (no "now playing") and the queue moves on', async () => {
  const { player, events } = createPlayer();
  player.add([track('fail://gone'), track('ok://quick')]);
  await waitFor(() => events.some(([e]) => e === 'idle'));
  assert.deepEqual(events, [
    ['trackError', 'fail://gone'],
    ['trackStart', 'ok://quick'],
    ['idle', undefined],
  ]);
});

test(`halts after ${MAX_CONSECUTIVE_FAILURES} failures in a row and keeps the rest of the queue`, async () => {
  const { player, events } = createPlayer();
  const failing = Array.from({ length: MAX_CONSECUTIVE_FAILURES }, () => track('fail://gone'));
  player.add([...failing, track('ok://quick'), track('ok://quick')]);
  await waitFor(() => player.halted);
  assert.equal(events.filter(([e]) => e === 'trackError').length, MAX_CONSECUTIVE_FAILURES - 1);
  assert.equal(events.filter(([e]) => e === 'halted').length, 1);
  assert.equal(events.filter(([e]) => e === 'trackStart').length, 0);
  assert.equal(player.queue.length, 2);

  assert.equal(player.resume(), true); // retry
  await waitFor(() => events.filter(([e]) => e === 'trackStart').length === 2);
  assert.equal(player.halted, false);
});

test('a global error (YouTube bot check) halts right away and keeps the track for a retry', async () => {
  const { player, events } = createPlayer();
  player.add([track('fail://bot'), track('ok://quick')]);
  await waitFor(() => player.halted);
  assert.deepEqual(events, [
    ['halted', 'fail://bot'],
    ['idle', undefined],
  ]);
  assert.deepEqual(player.queue.map((t) => t.url), ['fail://bot', 'ok://quick']);
});

test('adding a track after a halt starts playback again', async () => {
  const { player, events } = createPlayer();
  player.add([track('fail://bot')]);
  await waitFor(() => player.halted);
  player.queue = [];
  player.add([track('ok://quick')]);
  await waitFor(() => events.some(([e, url]) => e === 'trackStart' && url === 'ok://quick'));
  assert.equal(player.halted, false);
});

test('skip stops yt-dlp together with everything it started (process group)', async () => {
  const pidfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mendil-test-')), 'child.pid');
  process.env.FAKE_CHILD_PIDFILE = pidfile;
  const { player, events } = createPlayer();
  player.add([track('ok://long')]);
  await waitFor(() => events.some(([e]) => e === 'trackStart') && fs.existsSync(pidfile));
  const childPid = Number(fs.readFileSync(pidfile, 'utf8'));
  assert.ok(alive(childPid), 'helper child should be running');

  player.skip();
  await waitFor(() => !alive(childPid), 4_000);
  assert.equal(player.isPlaying, false);
});
