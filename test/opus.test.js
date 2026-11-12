import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { OggOpusDemuxer, OpusStream, opusOutputArgs, MAX_FRAME_BYTES } from '../src/voice/opus.js';

/** Builds one Ogg page holding the given packets (no CRC; the demuxer doesn't check it). */
function oggPage(packets) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'latin1');
  header[26] = lacing.length;
  return Buffer.concat([header, Buffer.from(lacing), ...packets]);
}
const frame = (i, size = 40) => Buffer.alloc(size, i % 256);
const opusFile = (frames) => Buffer.concat([oggPage([Buffer.from('OpusHead')]), oggPage([Buffer.from('OpusTags')]), ...frames.map((f) => oggPage([f]))]);

test('ffmpeg is asked for 20 ms CBR Opus frames that fit a voice packet', () => {
  const args = opusOutputArgs(128);
  assert.deepEqual(args.slice(args.indexOf('-vbr'), args.indexOf('-vbr') + 2), ['-vbr', 'off']);
  assert.ok(args.includes('libopus') && args.includes('128k'));
  assert.ok((192_000 / 8) * 0.02 <= MAX_FRAME_BYTES, 'the highest allowed bitrate still fits');
});

test('the demuxer skips the two header packets and handles packets split across chunks and pages', () => {
  const got = [];
  const d = new OggOpusDemuxer((p) => got.push(p));
  const big = Buffer.alloc(300, 7); // needs two lacing values (255 + 45)
  const data = opusFile([frame(1), big, frame(3)]);
  for (let i = 0; i < data.length; i += 13) d.push(data.subarray(i, i + 13)); // awkward chunk sizes
  assert.deepEqual(got.map((p) => p.length), [40, 300, 40]);
  assert.equal(got[1][0], 7);
});

function streamOf(frames, opts = {}) {
  const stdout = new PassThrough();
  const sent = [];
  let speechEnds = 0;
  const stream = new OpusStream(stdout, {
    send: opts.send ?? ((f) => (sent.push(f), true)),
    endSpeech: () => speechEnds++,
    log: { warn() {} },
  });
  stdout.write(opusFile(frames));
  if (opts.end !== false) stdout.end();
  return { stream, stdout, sent, speechEnds: () => speechEnds };
}

test('frames go out every 20 ms, and drained resolves after the last one', async () => {
  const { stream, sent, speechEnds } = streamOf(Array.from({ length: 10 }, (_, i) => frame(i)));
  const t0 = Date.now();
  await stream.drained;
  const took = Date.now() - t0;
  assert.equal(sent.length, 10);
  assert.ok(took >= 150 && took < 600, `10 frames took ${took} ms`);
  assert.equal(speechEnds(), 1, 'end of speech is signalled once');
});

test('pause stops sending and ends speech; resume carries on', async () => {
  const { stream, sent, speechEnds } = streamOf(Array.from({ length: 20 }, (_, i) => frame(i)));
  await sleep(70);
  stream.pause();
  const atPause = sent.length;
  assert.ok(atPause > 0 && atPause < 20);
  await sleep(120);
  assert.equal(sent.length, atPause, 'nothing sent while paused');
  assert.equal(speechEnds(), 1);
  stream.resume();
  await stream.drained;
  assert.equal(sent.length, 20);
});

test('while the connection is down frames are held, not lost', async () => {
  let up = false;
  const sent = [];
  const { stream } = streamOf(Array.from({ length: 5 }, (_, i) => frame(i)), { send: (f) => (up ? (sent.push(f), true) : false) });
  await sleep(150);
  assert.equal(sent.length, 0);
  up = true;
  await stream.drained;
  assert.deepEqual(sent.map((f) => f[0]), [0, 1, 2, 3, 4]);
});

test('stop() drops the buffer and resolves drained right away', async () => {
  const { stream, sent } = streamOf(Array.from({ length: 50 }, (_, i) => frame(i)), { end: false });
  await sleep(30);
  stream.stop();
  await stream.drained;
  const n = sent.length;
  await sleep(60);
  assert.equal(sent.length, n);
  assert.ok(n < 50);
});

test('a frame too big for a voice packet is dropped instead of sent', async () => {
  const { stream, sent } = streamOf([frame(1), Buffer.alloc(MAX_FRAME_BYTES + 1), frame(2)]);
  await stream.drained;
  assert.deepEqual(sent.map((f) => f.length), [40, 40]);
  assert.equal(stream.stats.oversized, 1);
});
