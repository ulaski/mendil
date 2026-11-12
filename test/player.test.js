import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Player, MAX_CONSECUTIVE_FAILURES } from '../src/player.js';
import { Prefetcher } from '../src/prefetch.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bin');
const bin = { ytdlp: path.join(BIN, 'fake-yt-dlp.cjs'), ffmpeg: path.join(BIN, 'fake-ffmpeg.cjs') };
const quietLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const fastTiming = { watchIntervalMs: 50, stallMs: 600, startTimeoutMs: { file: 3_000, stream: 3_000 } };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mendil-test-'));

/** Player with fakes; records events and every fake yt-dlp/ffmpeg invocation. */
function setup({ prefetch = false, normalize = false } = {}) {
  const dir = tmp();
  process.env.FAKE_LOG = path.join(dir, 'calls.log');
  const prefetcher = prefetch
    ? new Prefetcher({ dir: path.join(dir, 'cache'), normalize, log: quietLog, bin })
    : null;
  const player = new Player({ sink: 'test', defaultVolume: 50, normalize, log: quietLog, bin, prefetcher, timing: fastTiming });
  const events = [];
  for (const name of ['trackStart', 'trackError', 'halted', 'idle']) {
    player.on(name, (track) => events.push([name, track?.url]));
  }
  const calls = () => (fs.existsSync(process.env.FAKE_LOG)
    ? fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : []);
  return { player, events, calls, dir };
}

const track = (url, extra = {}) => ({ title: url, url, duration: 1, ...extra });
const names = (events) => events.map(([e]) => e);

async function waitFor(predicate, timeoutMs = 6_000) {
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

// --- streaming (no prefetcher) ----------------------------------------------------

test('stream: announces a track once audio flows, then plays the queue to the end', async () => {
  const { player, events } = setup();
  player.add([track('ok://a'), track('ok://b')]);
  await waitFor(() => names(events).includes('idle'));
  assert.deepEqual(events, [['trackStart', 'ok://a'], ['trackStart', 'ok://b'], ['idle', undefined]]);
});

test('stream: a failing track gives one error message and the queue moves on', async () => {
  const { player, events } = setup();
  player.add([track('fail://gone'), track('ok://a')]);
  await waitFor(() => names(events).includes('idle'));
  assert.deepEqual(events, [['trackError', 'fail://gone'], ['trackStart', 'ok://a'], ['idle', undefined]]);
});

test(`halts after ${MAX_CONSECUTIVE_FAILURES} failures in a row and keeps the rest of the queue`, async () => {
  const { player, events } = setup();
  const failing = Array.from({ length: MAX_CONSECUTIVE_FAILURES }, () => track('fail://gone'));
  player.add([...failing, track('ok://a'), track('ok://b')]);
  await waitFor(() => player.halted);
  assert.equal(events.filter(([e]) => e === 'trackError').length, MAX_CONSECUTIVE_FAILURES - 1);
  assert.equal(events.filter(([e]) => e === 'halted').length, 1);
  assert.equal(player.queue.length, 2);

  assert.equal(player.resume(), true); // retry
  await waitFor(() => events.filter(([e]) => e === 'trackStart').length === 2);
  assert.equal(player.halted, false);
});

test('a cut-short stream is retried once from where it stopped, without a second announcement', async () => {
  const { player, events, calls } = setup();
  player.add([track('ok://truncated', { duration: 60 })]);
  await waitFor(() => names(events).includes('idle'));
  assert.deepEqual(names(events), ['trackStart', 'idle']);
  const ytRuns = calls().filter((c) => c.bin === 'yt-dlp');
  assert.equal(ytRuns.length, 2, 'one retry');
});

test('skip stops yt-dlp together with everything it started (process group)', async () => {
  const { player, events, dir } = setup();
  process.env.FAKE_CHILD_PIDFILE = path.join(dir, 'child.pid');
  player.add([track('ok://long', { duration: 30 })]);
  await waitFor(() => names(events).includes('trackStart') && fs.existsSync(process.env.FAKE_CHILD_PIDFILE));
  const childPid = Number(fs.readFileSync(process.env.FAKE_CHILD_PIDFILE, 'utf8'));
  assert.ok(alive(childPid), 'helper child should be running');
  player.skip();
  await waitFor(() => !alive(childPid), 4_000);
  assert.equal(player.isPlaying, false);
});

// --- prefetch / file playback ----------------------------------------------------------

test('prefetch: plays from a downloaded file and prepares the next track meanwhile', async () => {
  const { player, events, calls } = setup({ prefetch: true });
  player.add([track('ok://a'), track('ok://b')]);
  await waitFor(() => names(events).includes('idle'));
  assert.deepEqual(names(events), ['trackStart', 'trackStart', 'idle']);
  const ffInputs = calls().filter((c) => c.bin === 'ffmpeg').map((c) => c.args[c.args.indexOf('-i') + 1]);
  assert.ok(ffInputs.every((i) => i.endsWith('.webm')), `played from files: ${ffInputs}`);
  assert.equal(calls().filter((c) => c.bin === 'yt-dlp' && c.args.includes('-o') && c.args.at(-1) === 'ok://b').length, 1);
  assert.ok(player.metrics.gap.length === 1 && player.metrics.gap[0] < 1_500, `gap ${player.metrics.gap}`);
});

test('prefetch: normalises with a measured gain + limiter instead of realtime loudnorm', async () => {
  const { player, events, calls } = setup({ prefetch: true, normalize: true });
  player.add([track('ok://a')]);
  await waitFor(() => names(events).includes('idle'));
  const play = calls().find((c) => c.bin === 'ffmpeg' && c.args.includes('-progress'));
  const filter = play.args[play.args.indexOf('-af') + 1];
  assert.match(filter, /^volume=-6dB,alimiter=/); // -16 LUFS target, fake file measures -10
});

test('prefetch: a download failure is reported without trying to stream it again', async () => {
  const { player, events, calls } = setup({ prefetch: true });
  player.add([track('fail://bot'), track('ok://a')]);
  await waitFor(() => player.halted);
  assert.deepEqual(events, [['halted', 'fail://bot'], ['idle', undefined]]);
  assert.deepEqual(player.queue.map((t) => t.url), ['fail://bot', 'ok://a']);
  assert.equal(calls().filter((c) => c.bin === 'ffmpeg' && c.args.includes('-progress')).length, 0);
});

test('a stalled track is detected, retried once from its position, then given up', async () => {
  const { player, events, calls } = setup({ prefetch: true });
  player.add([track('ok://stall', { duration: 5 })]);
  await waitFor(() => names(events).includes('idle'), 8_000);
  assert.deepEqual(names(events), ['trackStart', 'idle']);
  assert.equal(calls().filter((c) => c.bin === 'ffmpeg' && c.args.includes('-progress')).length, 2);
});

test('prefetch: files of tracks that are no longer wanted are deleted', async () => {
  const { player, events, dir } = setup({ prefetch: true });
  player.add([track('ok://long', { duration: 30 }), track('ok://b')]);
  await waitFor(() => names(events).includes('trackStart'));
  const cache = path.join(dir, 'cache');
  await waitFor(() => fs.readdirSync(cache).length === 2); // current + next
  player.clear();
  await waitFor(() => fs.readdirSync(cache).length === 1);
  player.stop();
  await waitFor(() => fs.readdirSync(cache).length === 0);
});

// --- persistence -------------------------------------------------------------------------

test('snapshot/restore resumes the current track a few seconds before where it was', async () => {
  const { player, calls } = setup({ prefetch: true });
  player.restore({
    queue: [track('ok://b')],
    current: { ...track('ok://long', { duration: 30 }), position: 12 },
    loop: 'all',
    volume: 40,
    paused: false,
  });
  assert.deepEqual(player.queue.map((t) => [t.url, t.startAt]), [['ok://long', 9], ['ok://b', undefined]]);
  assert.equal(player.loop, 'all');
  assert.equal(player.volume, 40);

  player.start();
  await waitFor(() => calls().some((c) => c.bin === 'ffmpeg' && c.args.includes('-progress')));
  const play = calls().find((c) => c.bin === 'ffmpeg' && c.args.includes('-progress'));
  assert.equal(play.args[play.args.indexOf('-ss') + 1], '9');
  await waitFor(() => player.elapsed() >= 9);
  const snap = player.snapshot();
  assert.equal(snap.current.url, 'ok://long');
  assert.ok(snap.current.position >= 9);
  assert.deepEqual(snap.queue.map((t) => t.url), ['ok://b']);
  player.stop();
});

// --- hardening (review 2026-11) ------------------------------------------------------

test('yt-dlp gets "--" before the URL, so a URL can never be read as an option', async () => {
  const { player, calls, dir } = setup();
  player.add([track('ok://a')]);
  await waitFor(() => calls().some((c) => c.bin === 'yt-dlp'));
  const args = calls().find((c) => c.bin === 'yt-dlp').args;
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), 'ok://a');
  player.dispose();
  fs.rmSync(dir, { recursive: true, force: true });

  const p2 = setup({ prefetch: true });
  p2.player.add([track('ok://b')]);
  await waitFor(() => p2.calls().some((c) => c.bin === 'yt-dlp' && c.args.includes('--print')));
  const dl = p2.calls().find((c) => c.bin === 'yt-dlp' && c.args.includes('--print')).args;
  assert.deepEqual(dl.slice(-2), ['--', 'ok://b']);
  p2.player.dispose();
});

test('a stream that plays far past its stated length is stopped and not retried', async () => {
  const dir = tmp();
  process.env.FAKE_LOG = path.join(dir, 'calls.log');
  const player = new Player({ sink: 'test', defaultVolume: 50, normalize: false, log: quietLog, bin,
    timing: { ...fastTiming, overrunSlackS: 0.4 } });
  const starts = [];
  player.on('trackStart', (t) => starts.push(t.url));
  let idle = false;
  player.on('idle', () => (idle = true));
  player.add([track('ok://long', { duration: 0.3 })]); // the fake streams for 30 s
  const t0 = Date.now();
  await waitFor(() => idle, 8_000);
  assert.ok(Date.now() - t0 < 5_000, 'stopped well before the source ended');
  assert.deepEqual(starts, ['ok://long']); // no retry
  player.dispose();
});

test('MAX_TRACK_DURATION caps live streams too', async () => {
  const player = new Player({ sink: 'test', defaultVolume: 50, normalize: false, log: quietLog, bin,
    timing: fastTiming, maxTrackDuration: 1 });
  let idle = false;
  player.on('idle', () => (idle = true));
  player.add([track('ok://long', { duration: null, isLive: true })]);
  await waitFor(() => idle, 8_000);
  player.dispose();
});

test('restore drops queue entries whose URL looks like an option', () => {
  const { player } = setup();
  player.restore({ queue: [track('ok://a'), track('--exec=touch /tmp/x'), { title: 'x' }], current: null });
  assert.deepEqual(player.queue.map((t) => t.url), ['ok://a']);
});
