import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { AUDIO_FORMAT } from './prefetch.js';
import { baseArgs, isGlobalError, summarizeError, ytdlpEvents } from './ytdlp.js';

const execFileAsync = promisify(execFile);
const STDERR_TAIL = 4096;
const KILL_GRACE_MS = 2_000;
const DEFAULT_TIMING = {
  watchIntervalMs: 1_000,
  stallMs: 20_000, // no audio progress for this long (while not paused) = stalled
  startTimeoutMs: { file: 20_000, stream: 90_000 },
};
const TRUNCATION_SLACK_S = 10; // ended this much before its known duration = cut short
const MAX_RETRIES = 1; // per track, for cut-short or stalled playback
const LIVE_FORMAT = 'bestaudio/best[height<=360]/worst'; // live streams are usually muxed only
const LIMITER = 'alimiter=limit=0.89:level=false'; // about -1 dBFS, no auto-gain
const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';
const METRICS_KEPT = 100;

/** After this many tracks in a row fail before producing audio, stop instead of draining the queue. */
export const MAX_CONSECUTIVE_FAILURES = 3;

export const LOOP_MODES = ['off', 'one', 'all'];

// startAt: where a restored track resumes (seconds); only set on queued tracks.
const TRACK_FIELDS = ['title', 'url', 'duration', 'isLive', 'requestedBy', 'startAt'];
/** The persistent part of a track (no runtime fields like position or retries). */
export const plainTrack = (t) => Object.fromEntries(TRACK_FIELDS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));

function tail(buffer, chunk) {
  const next = buffer + chunk.toString();
  return next.length > STDERR_TAIL ? next.slice(-STDERR_TAIL) : next;
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Stops yt-dlp *and everything it started* (its own process group). SIGTERM first so it can
 * clean up, SIGKILL if anything is still around after a grace period.
 */
function killProcessGroup(child) {
  if (!child.pid) return;
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // ESRCH: the group is already gone
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref();
}

const pushMetric = (list, value) => {
  list.push(value);
  if (list.length > METRICS_KEPT) list.shift();
};

/**
 * Queue + playback into a PulseAudio sink whose monitor is the TeamSpeak client's microphone.
 *
 * Sources, best first:
 *  - file:   the track was downloaded by the Prefetcher; ffmpeg plays it with a fixed
 *            loudness gain + limiter.
 *  - stream: `yt-dlp -o - URL | ffmpeg` with realtime loudnorm (live streams, very long
 *            tracks, or when the download didn't work out).
 *
 * Events:
 *  - 'trackStart' (track)          audio for the track started flowing (once per track)
 *  - 'trackError' (track, message) a track failed and was skipped
 *  - 'halted' (track, message)     too many failures in a row; playback stopped, queue kept
 *  - 'idle'                        nothing is playing any more
 */
export class Player extends EventEmitter {
  queue = [];
  current = null;
  loop = 'off';
  paused = false;
  /** Set after repeated failures; playback waits for resume() or a newly added track. */
  halted = false;
  /** Recent timings in ms, for the stats log: load = request→audio, gap = previous end→audio. */
  metrics = { load: [], gap: [] };
  /** URL of the last track that played fine (the yt-dlp updater smoke-tests with it). */
  lastGoodUrl = null;

  #procs = null;
  #session = 0;
  #failures = 0;
  #lastEndAt = 0;

  constructor({ sink, defaultVolume, normalize, cookiesFile, cacheDir, proxy, prefetcher = null, log, bin = {}, timing = {} }) {
    super();
    this.sink = sink;
    this.volume = defaultVolume;
    this.normalize = normalize;
    this.ytOpts = { cookiesFile, cacheDir, proxy };
    this.prefetcher = prefetcher;
    this.log = log;
    this.bin = { ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', ...bin };
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  get isPlaying() {
    return this.current !== null;
  }

  async init() {
    await this.setVolume(this.volume);
  }

  async setVolume(percent) {
    this.volume = Math.max(0, Math.min(100, Math.round(percent)));
    await execFileAsync('pactl', ['set-sink-volume', this.sink, `${this.volume}%`]);
  }

  // --- queue ------------------------------------------------------------------

  add(tracks, { front = false } = {}) {
    const fresh = tracks.map(plainTrack);
    if (front) this.queue.unshift(...fresh);
    else this.queue.push(...fresh);
    if (this.halted) this.#clearHalt(); // someone asked for music: try again
    if (!this.current) this.#playNext();
    else this.#syncPrefetch();
  }

  /** Removes the n-th queued track (1-based); returns it or null. */
  remove(n) {
    const [removed] = this.queue.splice(n - 1, 1);
    this.#syncPrefetch();
    return removed ?? null;
  }

  clear() {
    const count = this.queue.length;
    this.queue = [];
    this.#syncPrefetch();
    return count;
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.#syncPrefetch();
  }

  // --- playback control ----------------------------------------------------------

  /** Starts the queue if nothing is playing (e.g. after restoring state). */
  start() {
    if (!this.current && !this.halted && this.queue.length > 0) this.#playNext();
  }

  skip() {
    if (!this.current) return false;
    this.#killProcs();
    this.#advance({ skipped: true });
    return true;
  }

  stop() {
    const wasActive = this.current !== null;
    this.queue = [];
    this.#killProcs();
    this.current = null;
    this.paused = false;
    this.#clearHalt();
    this.prefetcher?.clear();
    if (wasActive) this.emit('idle');
  }

  /** Stops all processes on shutdown, without touching the queue (it has been saved). */
  dispose() {
    this.#killProcs();
    this.prefetcher?.clear();
  }

  pause() {
    if (!this.current || this.paused || !this.#procs) return false;
    this.#procs.ff.kill('SIGSTOP');
    this.paused = true;
    return true;
  }

  /** Resumes a paused track, or starts a queue that is halted or wasn't started yet. */
  resume() {
    if (!this.current) {
      if (this.queue.length === 0) return false;
      this.#clearHalt();
      this.#playNext();
      return true;
    }
    if (!this.paused || !this.#procs) return false;
    this.#procs.ff.kill('SIGCONT');
    this.paused = false;
    this.#procs.lastProgressAt = Date.now();
    return true;
  }

  /** Seconds played of the current track. */
  elapsed() {
    return Math.floor(this.current?.position ?? 0);
  }

  // --- persistence ---------------------------------------------------------------

  snapshot() {
    return {
      queue: this.queue.map(plainTrack),
      current: this.current ? { ...plainTrack(this.current), startAt: undefined, position: this.elapsed() } : null,
      loop: this.loop,
      volume: this.volume,
      paused: this.paused || this.halted,
    };
  }

  /** Loads a snapshot without starting playback; call start() (or resume()) afterwards. */
  restore(state) {
    const resumeFrom = state.current
      ? [{ ...plainTrack(state.current), startAt: Math.max(0, Math.floor(state.current.position ?? 0) - 3) }]
      : [];
    this.queue = [...resumeFrom, ...(state.queue ?? []).map(plainTrack)];
    if (LOOP_MODES.includes(state.loop)) this.loop = state.loop;
    if (Number.isFinite(state.volume)) this.volume = Math.max(0, Math.min(100, state.volume));
    return { tracks: this.queue.length, paused: Boolean(state.paused) };
  }

  // --- internals -------------------------------------------------------------------

  #clearHalt() {
    this.halted = false;
    this.#failures = 0;
  }

  #syncPrefetch() {
    this.prefetcher?.want([this.current, this.queue[0]].filter(Boolean));
  }

  #playNext() {
    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.paused = false;
      this.#syncPrefetch();
      this.emit('idle');
      return;
    }
    const { startAt = 0, ...track } = next;
    this.current = { ...track, position: startAt, retries: 0, requestedAt: Date.now() };
    this.paused = false;
    this.#load(this.current, startAt);
  }

  async #load(track, startAt) {
    const session = ++this.#session;
    this.#syncPrefetch();
    this.log.info(`loading: ${track.title} <${track.url}>`);
    let source = null;
    if (this.prefetcher?.eligible(track)) {
      const res = await this.prefetcher.ensure(track);
      if (session !== this.#session) return;
      if (res.file) {
        source = { file: res.file, gainDb: res.gainDb };
      } else if (res.error) {
        // Same yt-dlp, same video: streaming would fail the same way.
        this.#advance({ error: res.error, global: res.global });
        return;
      } // timeout: fall back to streaming
    }
    this.#spawn(track, session, startAt, source);
  }

  #advance({ skipped = false, error = null, global = false } = {}) {
    const finished = this.current;
    this.current = null;
    this.#lastEndAt = Date.now();
    if (finished) {
      const track = plainTrack(finished);
      if (error) {
        this.#failures++;
        if (global || this.#failures >= MAX_CONSECUTIVE_FAILURES) {
          // Don't burn through the queue (and spam the channel) when every track fails.
          if (global) this.queue.unshift(track); // the track itself is probably fine: retry it
          this.halted = true;
          this.paused = false;
          this.log.warn(`playback halted after ${this.#failures} failure(s): ${error}`);
          this.#syncPrefetch();
          this.emit('halted', finished, error);
          this.emit('idle');
          return;
        }
        this.emit('trackError', finished, error);
      } else if (this.loop === 'one' && !skipped) {
        this.queue.unshift(track);
      } else if (this.loop === 'all') {
        this.queue.push(track);
      }
    }
    this.#playNext();
  }

  #spawn(track, session, startAt, source) {
    const mode = source ? 'file' : 'stream';
    const seek = startAt > 0 ? ['-ss', String(startAt)] : [];
    let filters = [];
    if (this.normalize) {
      filters = source?.gainDb != null ? ['-af', `volume=${source.gainDb}dB,${LIMITER}`] : ['-af', LOUDNORM];
    }
    const output = ['-ac', '2', '-ar', '48000', '-progress', 'pipe:3', '-stats_period', '0.5',
      '-f', 'pulse', '-device', this.sink, '-name', 'mendil', 'music'];

    let yt = null;
    let ff;
    if (source) {
      ff = spawn(this.bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...seek, '-i', source.file,
        '-vn', ...filters, ...output], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    } else {
      yt = spawn(this.bin.ytdlp, [
        ...baseArgs(this.ytOpts),
        '-f', track.isLive ? LIVE_FORMAT : AUDIO_FORMAT,
        '--no-playlist', '--no-progress', '--quiet',
        '-o', '-',
        track.url,
      ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true }); // own group: see killProcessGroup()
      // -ss after -i: input is a pipe, so decode and drop up to the offset
      ff = spawn(this.bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...seek,
        '-vn', ...filters, ...output], { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
      yt.stdout.pipe(ff.stdin);
      // EPIPE etc. when one side dies first; the close handling below decides what happened.
      yt.stdout.on('error', () => {});
      ff.stdin.on('error', () => {});
    }

    const procs = { yt, ff, mode, started: false, stalled: false, spawnedAt: Date.now(), lastProgressAt: Date.now() };
    this.#procs = procs;
    let ytErr = '';
    let ffErr = '';
    yt?.stderr.on('data', (c) => (ytErr = tail(ytErr, c)));
    yt?.on('error', (err) => (ytErr = tail(ytErr, `ERROR: yt-dlp: ${err.message}\n`)));
    ff.stderr.on('data', (c) => (ffErr = tail(ffErr, c)));
    ff.on('error', (err) => (ffErr = tail(ffErr, `ERROR: ffmpeg: ${err.message}\n`)));

    // Progress: position, "audio started" and stall detection all come from ffmpeg itself.
    let progressBuf = '';
    ff.stdio[3].on('data', (chunk) => {
      progressBuf += chunk;
      const lines = progressBuf.split('\n');
      progressBuf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (!m || session !== this.#session) continue;
        const position = startAt + Number(m[1]) / 1e6;
        if (position > (track.position ?? 0) || !procs.started) {
          if (Number(m[1]) > 0) procs.lastProgressAt = Date.now();
          track.position = position;
        }
        if (!procs.started && Number(m[1]) > 0) this.#onAudioStarted(track, procs);
      }
    });
    ff.stdio[3].on('error', () => {});

    procs.watch = setInterval(() => {
      if (session !== this.#session) return;
      const now = Date.now();
      if (this.paused) {
        procs.lastProgressAt = now;
      } else if (!procs.started && now - procs.spawnedAt > this.timing.startTimeoutMs[mode]) {
        ffErr = tail(ffErr, 'ERROR: timed out waiting for audio\n');
        procs.stalled = 'start';
        this.#killPipeline(procs);
      } else if (procs.started && now - procs.lastProgressAt > this.timing.stallMs) {
        this.log.warn(`playback stalled at ${Math.floor(track.position)}s: ${track.title}`);
        procs.stalled = 'mid';
        this.#killPipeline(procs);
      }
    }, this.timing.watchIntervalMs);
    procs.watch.unref?.();

    // Decide only after *both* processes are gone, so a yt-dlp failure isn't mistaken for
    // a track that simply ended.
    const closed = (p) => (p && isRunning(p) ? new Promise((r) => p.once('close', (code) => r(code))) : Promise.resolve(p?.exitCode ?? null));
    const ytClosed = closed(yt);
    closed(ff).then(async (ffCode) => {
      if (yt && isRunning(yt)) killProcessGroup(yt);
      const ytCode = await ytClosed;
      clearInterval(procs.watch);
      if (session !== this.#session) return; // killed on purpose (skip/stop)
      this.#procs = null;
      this.#onPlaybackEnded(track, { procs, ffCode, ytCode, ytErr, ffErr });
    });
  }

  #onAudioStarted(track, procs) {
    procs.started = true;
    this.#failures = 0;
    const now = Date.now();
    if (!track.announced) {
      track.announced = true;
      pushMetric(this.metrics.load, now - track.requestedAt);
      if (this.#lastEndAt && now - this.#lastEndAt < 60_000) pushMetric(this.metrics.gap, now - this.#lastEndAt);
      this.log.info(`playing (${procs.mode}, ${now - track.requestedAt} ms): ${track.title}`);
      this.emit('trackStart', track);
    }
    this.#syncPrefetch();
  }

  #onPlaybackEnded(track, { procs, ffCode, ytCode, ytErr, ffErr }) {
    const all = `${ytErr}\n${ffErr}`;
    if (!procs.started) {
      if (ytErr) ytdlpEvents.emit('failure', ytErr);
      const message = summarizeError(ytErr.includes('ERROR') ? ytErr : ffErr || ytErr);
      this.log.warn(`playback failed (${procs.mode}, ffmpeg=${ffCode}, yt-dlp=${ytCode}): ${message}`);
      this.#advance({ error: message, global: isGlobalError(all) });
      return;
    }
    if (ffCode !== 0 && isGlobalError(ffErr)) {
      this.#advance({ error: summarizeError(ffErr), global: true });
      return;
    }
    const cutShort = procs.stalled === 'mid'
      || ffCode !== 0
      || (ytCode !== null && ytCode !== 0)
      || (!track.isLive && Number.isFinite(track.duration) && track.position < track.duration - TRUNCATION_SLACK_S);
    if (cutShort && track.retries < MAX_RETRIES) {
      track.retries++;
      const from = Math.max(0, Math.floor(track.position) - 2);
      this.log.warn(`track ended early at ${from}s (${procs.mode}, ffmpeg=${ffCode}, yt-dlp=${ytCode}); retrying from there: ${track.title}`);
      this.#load(track, from);
      return;
    }
    if (cutShort) this.log.warn(`track ended early at ${Math.floor(track.position)}s, giving up: ${track.title}`);
    else this.lastGoodUrl = track.url;
    this.#advance();
  }

  #killPipeline(procs) {
    if (isRunning(procs.ff)) procs.ff.kill('SIGKILL'); // works on SIGSTOP'ed (paused) ffmpeg too
    if (procs.yt && isRunning(procs.yt)) killProcessGroup(procs.yt);
  }

  #killProcs() {
    this.#session++;
    const procs = this.#procs;
    this.#procs = null;
    if (!procs) return;
    clearInterval(procs.watch);
    this.#killPipeline(procs);
  }
}
