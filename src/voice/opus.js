import { performance } from 'node:perf_hooks';

export const FRAME_MS = 20;
/** The largest audio frame a TeamSpeak voice packet carries; the server drops bigger ones. */
export const MAX_FRAME_BYTES = 484;
// Frames buffered ahead of playback. Small, so pause and skip take effect quickly; ffmpeg
// encodes far faster than real time, so a second is plenty to ride out hiccups.
const HIGH_WATER = 50;
const LOW_WATER = 25;
const STALL_REANCHOR_MS = 200;

/**
 * ffmpeg output arguments for TeamSpeak's Opus Music codec: 48 kHz stereo, 20 ms frames,
 * constant bitrate. CBR keeps every frame the same size (bitrate / 400 bytes), safely under
 * MAX_FRAME_BYTES up to 192 kbit/s; VBR overshoots on dense music and the server drops those.
 */
export function opusOutputArgs(bitrateKbps) {
  return ['-c:a', 'libopus', '-b:a', `${bitrateKbps}k`, '-vbr', 'off', '-application', 'audio',
    '-frame_duration', String(FRAME_MS), '-ac', '2', '-ar', '48000',
    '-f', 'ogg', '-page_duration', String(FRAME_MS * 1000), 'pipe:1'];
}

/** Minimal Ogg demuxer: calls onPacket for each Opus packet, skipping OpusHead/OpusTags. */
export class OggOpusDemuxer {
  #buf = Buffer.alloc(0);
  #partial = [];
  #packetIndex = 0;

  constructor(onPacket) {
    this.onPacket = onPacket;
  }

  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    for (;;) {
      if (this.#buf.length < 27) return;
      if (this.#buf.toString('latin1', 0, 4) !== 'OggS') {
        const next = this.#buf.indexOf('OggS', 1, 'latin1');
        if (next === -1) {
          this.#buf = Buffer.alloc(0);
          return;
        }
        this.#buf = this.#buf.subarray(next);
        continue;
      }
      const segments = this.#buf[26];
      if (this.#buf.length < 27 + segments) return;
      const table = this.#buf.subarray(27, 27 + segments);
      const total = 27 + segments + table.reduce((a, b) => a + b, 0);
      if (this.#buf.length < total) return;
      let offset = 27 + segments;
      for (const lacing of table) {
        this.#partial.push(this.#buf.subarray(offset, offset + lacing));
        offset += lacing;
        if (lacing < 255) {
          const packet = Buffer.concat(this.#partial);
          this.#partial = [];
          if (this.#packetIndex++ >= 2) this.onPacket(packet);
        }
      }
      this.#buf = this.#buf.subarray(total);
    }
  }
}

/**
 * Plays one ffmpeg Ogg/Opus stream into the voice connection, one frame every 20 ms.
 *
 * `send(frame)` returns false while the connection can't send; the frame is then kept and
 * retried, so playback continues where it stopped. `drained` resolves once the stream has
 * ended and every buffered frame was sent (or stop() was called).
 */
export class OpusStream {
  #queue = [];
  #ended = false;
  #done = false;
  #paused = false;
  #timer = null;
  #t0 = 0;
  #n = 0;
  #resolveDrained;
  stats = { frames: 0, late: 0, maxLateMs: 0, underruns: 0, oversized: 0 };

  constructor(stdout, { send, endSpeech, log, now = () => performance.now() }) {
    this.stdout = stdout;
    this.send = send;
    this.endSpeech = endSpeech;
    this.log = log;
    this.now = now;
    this.drained = new Promise((resolve) => (this.#resolveDrained = resolve));
    const demuxer = new OggOpusDemuxer((packet) => this.#onPacket(packet));
    stdout.on('data', (chunk) => demuxer.push(chunk));
    stdout.on('end', () => {
      this.#ended = true;
      if (!this.#timer && !this.#done) this.#tick();
    });
    stdout.on('error', () => {});
    this.#anchor();
  }

  /** Seconds of audio sent so far. */
  get playedSeconds() {
    return (this.stats.frames * FRAME_MS) / 1000;
  }

  #onPacket(packet) {
    if (packet.length > MAX_FRAME_BYTES) {
      // Would be dropped by the server anyway; CBR output never gets here.
      if (this.stats.oversized++ === 0) this.log?.warn(`dropping Opus frames over ${MAX_FRAME_BYTES} bytes (got ${packet.length})`);
      return;
    }
    this.#queue.push(packet);
    if (this.#queue.length >= HIGH_WATER) this.stdout.pause();
    if (!this.#timer && !this.#paused && !this.#done) this.#tick();
  }

  #anchor() {
    this.#t0 = this.now();
    this.#n = 0;
  }

  #schedule(ms) {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#tick();
    }, Math.max(0, ms));
  }

  #tick() {
    if (this.#done || this.#paused) return;
    const now = this.now();
    while (this.#queue.length && this.#t0 + this.#n * FRAME_MS <= now + 1) {
      const late = now - (this.#t0 + this.#n * FRAME_MS);
      if (!this.send(this.#queue[0])) {
        // Not connected: hold the position and try again shortly.
        this.#anchor();
        this.#schedule(100);
        return;
      }
      this.#queue.shift();
      this.#n++;
      this.stats.frames++;
      if (late > this.stats.maxLateMs) this.stats.maxLateMs = late;
      if (late > 2 * FRAME_MS) this.stats.late++;
      if (late > STALL_REANCHOR_MS) {
        // The event loop stalled: carry on from now instead of sending a burst.
        this.#anchor();
        break;
      }
    }
    if (this.#queue.length < LOW_WATER && this.stdout.isPaused()) this.stdout.resume();
    if (!this.#queue.length) {
      if (this.#ended) {
        this.#finish();
        return;
      }
      // Waiting for ffmpeg. The next packet is still due on the same 20 ms grid; if it
      // comes too late, the lateness check above re-anchors the clock.
      if (this.stats.frames) this.stats.underruns++;
      return;
    }
    this.#schedule(this.#t0 + this.#n * FRAME_MS - this.now());
  }

  #finish() {
    if (this.#done) return;
    this.#done = true;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.endSpeech();
    this.#resolveDrained();
  }

  pause() {
    if (this.#done || this.#paused) return;
    this.#paused = true;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.endSpeech();
  }

  resume() {
    if (this.#done || !this.#paused) return;
    this.#paused = false;
    this.#anchor();
    this.#tick();
  }

  /** Drops whatever is buffered and ends the stream now. */
  stop() {
    this.#queue = [];
    this.#finish();
  }
}
