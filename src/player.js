import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { AUDIO_FORMAT } from './prefetch.js';
import { MAX_FILESIZE, baseArgs, isGlobalError, summarizeError, ytdlpEvents } from './ytdlp.js';
import { OpusStream, opusOutputArgs } from './voice/opus.js';
import { openStation, USER_AGENT } from './radio.js';

const execFileAsync = promisify(execFile);
const STDERR_TAIL = 4096;
const KILL_GRACE_MS = 2_000;
const DEFAULT_TIMING = {
  watchIntervalMs: 1_000,
  stallMs: 20_000, // no audio progress for this long (while not paused) = stalled
  startTimeoutMs: { file: 20_000, stream: 90_000 },
  overrunSlackS: 120, // a track may play this much past its stated length before it is stopped
};
const TRUNCATION_SLACK_S = 10; // ended this much before its known duration = cut short
const MAX_RETRIES = 1; // per track, for cut-short or stalled playback
const LIVE_FORMAT = 'bestaudio/best[height<=360]/worst'; // live streams are usually muxed only
const LIMITER = 'alimiter=limit=0.89:level=false'; // about -1 dBFS, no auto-gain
const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';
const METRICS_KEPT = 100;
// Before reconnecting to a radio station whose stream ended: longer if it barely played.
const RADIO_RETRY_MS = { quick: 10_000, normal: 2_000 };
const RADIO_SHORT_RUN_MS = 30_000;

/** After this many tracks in a row fail before producing audio, stop instead of draining the queue. */
export const MAX_CONSECUTIVE_FAILURES = 3;

export const LOOP_MODES = ['off', 'one', 'all'];

// startAt: where a restored track resumes (seconds); only set on queued tracks.
// search: YouTube search terms of a Spotify song not looked up yet (its url is the Spotify link).
const TRACK_FIELDS = ['title', 'url', 'duration', 'isLive', 'requestedBy', 'requesterUid', 'search', 'startAt'];
const MAX_LOOKUPS = 200;
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
 * Queue + playback. Where the audio goes depends on the voice engine (`output`):
 *  - {kind: 'pulse', sink}: a PulseAudio sink whose monitor is the TeamSpeak client's
 *    microphone (Classic). Volume is the sink volume, so it changes instantly.
 *  - {kind: 'opus', bitrate, send, endSpeech}: ffmpeg encodes Opus and an OpusStream paces
 *    the frames into the voice connection (Native). Volume is an ffmpeg filter, so changing
 *    it restarts the current track from where it is.
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
  #lookups = new Map(); // Spotify song -> YouTube lookup (promise)
  #radioTimer = null;
  #pendingAbort = null;
  /** The radio station ({ name, url }) that plays whenever the queue is empty, or null. */
  radio = null;
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

  constructor({ sink, output, defaultVolume, normalize, cookiesFile, cacheDir, proxy, maxTrackDuration = 0, prefetcher = null, resolver = null, log, bin = {}, timing = {} }) {
    super();
    this.output = output ?? { kind: 'pulse', sink };
    this.volume = defaultVolume;
    this.normalize = normalize;
    this.ytOpts = { cookiesFile, cacheDir, proxy };
    this.maxTrackDuration = maxTrackDuration;
    this.prefetcher = prefetcher;
    this.resolver = resolver; // async (track with `search`) -> { url, duration }
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
    const volume = Math.max(0, Math.min(100, Math.round(percent)));
    const changed = volume !== this.volume;
    this.volume = volume;
    if (this.output.kind === 'pulse') {
      await execFileAsync('pactl', ['set-sink-volume', this.output.sink, `${this.volume}%`]);
    } else if (changed && this.current && this.#procs && !this.paused) {
      // The volume is part of ffmpeg's filter chain: pick up where we are with the new one.
      const from = Math.max(0, Math.floor(this.current.position ?? 0));
      this.#killProcs();
      this.#load(this.current, from);
    }
  }

  // --- queue ------------------------------------------------------------------

  add(tracks, { front = false } = {}) {
    const fresh = tracks.map(plainTrack);
    if (front) this.queue.unshift(...fresh);
    else this.queue.push(...fresh);
    if (this.halted) this.#clearHalt(); // someone asked for music: try again
    if (this.current?.radio) {
      // Requests win over the radio, which comes back once the queue is empty.
      this.#killProcs();
      this.current = null;
    }
    if (!this.current) this.#playNext();
    else this.#syncPrefetch();
  }

  /**
   * Sets the radio station that plays whenever the queue is empty (null turns it off).
   * Starts it now if nothing else is playing, or switches stations if the radio is on.
   */
  setRadio(station) {
    this.radio = station ? { name: station.name, url: station.url } : null;
    if (this.current?.radio) {
      this.#killProcs();
      this.current = null;
      this.paused = false;
      if (!this.radio && this.queue.length === 0) {
        this.#cancelRadioRetry();
        this.emit('idle');
        return;
      }
    }
    if (!this.current && this.radio) {
      this.#clearHalt();
      this.#playNext();
    }
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
    if (!this.current && !this.halted && (this.queue.length > 0 || this.radio)) this.#playNext();
  }

  skip() {
    if (!this.current) return false;
    if (this.current.radio && this.queue.length === 0) return false; // nothing to skip to
    this.#killProcs();
    this.#advance({ skipped: true });
    return true;
  }

  stop() {
    const wasActive = this.current !== null;
    this.queue = [];
    this.radio = null; // "stop" means silence, radio included
    this.#cancelRadioRetry();
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
    if (this.current.radio) {
      // A live stream can't wait: hang up, and reconnect on resume.
      this.#killProcs();
      this.paused = true;
      return true;
    }
    this.#procs.ff.kill('SIGSTOP');
    this.#procs.stream?.pause();
    this.paused = true;
    return true;
  }

  /** Resumes a paused track, or starts a queue that is halted or wasn't started yet. */
  resume() {
    if (!this.current) {
      if (this.queue.length === 0 && !this.radio) return false;
      this.#clearHalt();
      this.#playNext();
      return true;
    }
    if (this.current.radio && this.paused) {
      this.paused = false;
      this.#load(this.current, 0);
      return true;
    }
    if (!this.paused || !this.#procs) return false;
    this.#procs.ff.kill('SIGCONT');
    this.#procs.stream?.resume();
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
      // The radio isn't a queue entry: it comes back through `radio`.
      current: this.current && !this.current.radio ? { ...plainTrack(this.current), startAt: undefined, position: this.elapsed() } : null,
      radio: this.radio,
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
    // A state file is data from disk: only keep entries that look like tracks.
    const valid = (t) => typeof t?.url === 'string' && t.url !== '' && !t.url.startsWith('-');
    this.queue = [...resumeFrom, ...(state.queue ?? []).map(plainTrack)].filter(valid);
    if (LOOP_MODES.includes(state.loop)) this.loop = state.loop;
    if (Number.isFinite(state.volume)) this.volume = Math.max(0, Math.min(100, state.volume));
    const radio = state.radio;
    if (radio && typeof radio.name === 'string' && typeof radio.url === 'string' && /^https?:\/\//i.test(radio.url)) {
      this.radio = { name: radio.name, url: radio.url };
    }
    return { tracks: this.queue.length, paused: Boolean(state.paused), radio: Boolean(this.radio) };
  }

  // --- internals -------------------------------------------------------------------

  #clearHalt() {
    this.halted = false;
    this.#failures = 0;
  }

  #syncPrefetch() {
    // Look up the next Spotify song while this one plays, so it can be prefetched too.
    if (this.queue[0]?.search) this.#resolveAhead(this.queue[0]);
    this.prefetcher?.want([this.current, this.queue[0]].filter(Boolean));
  }

  /** One lookup per song, shared by the look-ahead and #load; failures are retried later. */
  #lookup(track) {
    const key = `${track.search}|${track.url}`;
    if (!this.#lookups.has(key)) {
      if (this.#lookups.size >= MAX_LOOKUPS) this.#lookups.delete(this.#lookups.keys().next().value);
      const promise = Promise.resolve().then(() => {
        if (!this.resolver) throw new Error('cannot look up songs');
        return this.resolver(track);
      });
      promise.catch(() => this.#lookups.delete(key));
      this.#lookups.set(key, promise);
    }
    return this.#lookups.get(key);
  }

  #resolveAhead(track) {
    this.#lookup(track).then((found) => {
      if (!track.search) return;
      Object.assign(track, found, { search: undefined });
      if (this.queue[0] === track) this.#syncPrefetch();
    }, () => {}); // tried again, and reported, when it is its turn
  }

  #playNext() {
    this.#cancelRadioRetry();
    if (this.queue.length === 0 && this.radio && !this.halted) {
      const { name, url } = this.radio;
      this.current = { title: name, url, duration: null, isLive: true, radio: true, position: 0, retries: 0, requestedAt: Date.now() };
      this.paused = false;
      this.#load(this.current, 0);
      return;
    }
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
    if (track.radio) {
      const abort = new AbortController();
      this.#pendingAbort = abort;
      let input;
      try {
        input = await openStation(track.url, {
          signal: abort.signal,
          onTitle: (title) => {
            track.streamTitle = title;
            this.log.debug(`radio title: ${title}`);
            this.emit('streamTitle', track, title);
          },
        });
      } catch (err) {
        if (session === this.#session) this.#advance({ error: err.message });
        return;
      } finally {
        if (this.#pendingAbort === abort) this.#pendingAbort = null;
      }
      if (session !== this.#session) {
        abort.abort();
        return;
      }
      this.#spawn(track, session, 0, null, { ...input, abort });
      return;
    }
    if (track.search) {
      let found;
      try {
        found = await this.#lookup(track);
      } catch (err) {
        if (session === this.#session) this.#advance({ error: err.message, global: isGlobalError(err.message) });
        return;
      }
      if (session !== this.#session) return;
      Object.assign(track, found, { search: undefined });
      this.log.info(`found on YouTube: <${track.url}>`);
      this.#syncPrefetch();
    }
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
    if (finished?.radio) {
      if (error) {
        this.#failures++;
        if (global || this.#failures >= MAX_CONSECUTIVE_FAILURES) {
          this.halted = true;
          this.paused = false;
          this.log.warn(`radio halted after ${this.#failures} failure(s): ${error}`);
          this.emit('halted', finished, error);
          this.emit('idle');
          return;
        }
        this.emit('trackError', finished, error);
      }
      if (this.queue.length === 0 && this.radio) {
        // The stream ended or dropped: reconnect after a moment, longer if it barely played.
        const quick = error || Date.now() - finished.requestedAt < RADIO_SHORT_RUN_MS;
        this.#radioTimer = setTimeout(() => {
          this.#radioTimer = null;
          if (!this.current && !this.halted) this.#playNext();
        }, quick ? RADIO_RETRY_MS.quick : RADIO_RETRY_MS.normal);
        this.#radioTimer.unref?.();
        return;
      }
      this.#playNext();
      return;
    }
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

  #spawn(track, session, startAt, source, station = null) {
    const mode = source ? 'file' : 'stream';
    const seek = startAt > 0 ? ['-ss', String(startAt)] : [];
    const opus = this.output.kind === 'opus';
    const chain = [];
    if (this.normalize) chain.push(...(source?.gainDb != null ? [`volume=${source.gainDb}dB`, LIMITER] : [LOUDNORM]));
    if (opus && this.volume !== 100) chain.push(`volume=${(this.volume / 100).toFixed(2)}`);
    const filters = chain.length ? ['-af', chain.join(',')] : [];
    const progress = ['-progress', 'pipe:3', '-stats_period', '0.5'];
    const output = opus
      ? [...progress, ...opusOutputArgs(this.output.bitrate)]
      : ['-ac', '2', '-ar', '48000', ...progress, '-f', 'pulse', '-device', this.output.sink, '-name', 'mendil', 'music'];
    const ffOut = opus ? 'pipe' : 'ignore';

    let yt = null;
    let ff;
    if (source) {
      ff = spawn(this.bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...seek, '-i', source.file,
        '-vn', ...filters, ...output], { stdio: ['ignore', ffOut, 'pipe', 'pipe'] });
    } else if (station) {
      // Radio: our own connection (for the song titles) piped in, or ffmpeg reads the address.
      const input = station.audio ? ['-i', 'pipe:0']
        : ['-user_agent', USER_AGENT, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', station.url];
      ff = spawn(this.bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...input, '-vn', ...filters, ...output],
        { stdio: [station.audio ? 'pipe' : 'ignore', ffOut, 'pipe', 'pipe'] });
      if (station.audio) {
        // A dropped connection ends ffmpeg's input, so the track ends and the radio reconnects.
        station.audio.on('error', () => ff.stdin.end());
        ff.stdin.on('error', () => {});
        station.audio.pipe(ff.stdin);
      }
    } else {
      yt = spawn(this.bin.ytdlp, [
        ...baseArgs(this.ytOpts),
        '-f', track.isLive ? LIVE_FORMAT : AUDIO_FORMAT,
        '--no-playlist', '--no-progress', '--quiet',
        ...(track.isLive ? [] : ['--max-filesize', MAX_FILESIZE]),
        '-o', '-',
        '--', track.url, // "--": the URL can never be read as an option
      ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true }); // own group: see killProcessGroup()
      // -ss after -i: input is a pipe, so decode and drop up to the offset
      ff = spawn(this.bin.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...seek,
        '-vn', ...filters, ...output], { stdio: ['pipe', ffOut, 'pipe', 'pipe'] });
      yt.stdout.pipe(ff.stdin);
      // EPIPE etc. when one side dies first; the close handling below decides what happened.
      yt.stdout.on('error', () => {});
      ff.stdin.on('error', () => {});
    }

    const procs = { yt, ff, mode, station, started: false, stalled: false, spawnedAt: Date.now(), lastProgressAt: Date.now() };
    if (opus) procs.stream = new OpusStream(ff.stdout, { ...this.output, log: this.log });
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
        // With Opus output ffmpeg runs ahead of what has been heard (pipe and frame buffer),
        // so the position comes from the frames actually sent instead.
        const position = procs.stream ? startAt + procs.stream.playedSeconds : startAt + Number(m[1]) / 1e6;
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
      const ceiling = this.#maxPosition(track);
      if (procs.stream && procs.started && !this.paused) {
        // ffmpeg reports progress only while it can write; the frames keep going meanwhile.
        const position = startAt + procs.stream.playedSeconds;
        if (position > track.position) {
          track.position = position;
          procs.lastProgressAt = now;
        }
      }
      if (this.paused) {
        procs.lastProgressAt = now;
      } else if (procs.started && track.position > ceiling) {
        // A source that keeps sending audio far past its stated length (or past
        // MAX_TRACK_DURATION) would otherwise play forever.
        this.log.warn(`stopping ${track.title} at ${Math.floor(track.position)}s: longer than ${Math.floor(ceiling)}s`);
        procs.overrun = true;
        this.#killPipeline(procs);
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
      // ffmpeg is done encoding, but the last second is still being sent.
      if (procs.stream && session === this.#session) {
        await procs.stream.drained;
        if (procs.started) track.position = startAt + procs.stream.playedSeconds;
      }
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
    if (procs.overrun) {
      this.#advance();
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

  /** How far a track may play before it is stopped: its length plus slack, capped by MAX_TRACK_DURATION. */
  #maxPosition(track) {
    const limits = [];
    if (track.radio) return Infinity; // the radio is meant to play on
    if (!track.isLive && Number.isFinite(track.duration) && track.duration > 0) limits.push(track.duration + this.timing.overrunSlackS);
    if (this.maxTrackDuration > 0) limits.push(this.maxTrackDuration);
    return limits.length ? Math.min(...limits) : Infinity;
  }

  #killPipeline(procs) {
    procs.stream?.stop();
    procs.station?.abort.abort(); // hang up on the radio station
    procs.station?.audio?.destroy();
    if (isRunning(procs.ff)) procs.ff.kill('SIGKILL'); // works on SIGSTOP'ed (paused) ffmpeg too
    if (procs.yt && isRunning(procs.yt)) killProcessGroup(procs.yt);
  }

  #cancelRadioRetry() {
    clearTimeout(this.#radioTimer);
    this.#radioTimer = null;
  }

  #killProcs() {
    this.#session++;
    this.#pendingAbort?.abort(); // a radio station still being connected to
    this.#pendingAbort = null;
    const procs = this.#procs;
    this.#procs = null;
    if (!procs) return;
    clearInterval(procs.watch);
    this.#killPipeline(procs);
  }
}
