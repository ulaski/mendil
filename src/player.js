import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { baseArgs } from './ytdlp.js';

const execFileAsync = promisify(execFile);
const STDERR_TAIL = 4096;
const KILL_GRACE_MS = 2_000;

/** After this many tracks in a row fail before producing audio, stop instead of draining the queue. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Failures that will hit every track the same way (YouTube blocking us, no audio output…).
 * One of these halts playback right away.
 */
const GLOBAL_ERRORS = [
  /confirm you.?re not a bot/i,
  /sign in to confirm/i,
  /HTTP Error 429/i,
  /HTTP Error 403/i,
  /pa_simple_new|pulse.*connection refused/i,
  /Temporary failure in name resolution|Network is unreachable/i,
];

export const LOOP_MODES = ['off', 'one', 'all'];

function tail(buffer, chunk) {
  const next = buffer + chunk.toString();
  return next.length > STDERR_TAIL ? next.slice(-STDERR_TAIL) : next;
}

function summarizeError(stderr) {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.reverse().find((l) => /^ERROR:/.test(l)) || lines[0];
  return (err || 'unknown error').replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '').slice(0, 200);
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Stops yt-dlp *and everything it started*. The standalone yt-dlp binary is a PyInstaller
 * bootloader whose child does the real work, and it may start ffmpeg or node itself.
 * SIGKILL on the bootloader alone orphans the child and leaves its ~85 MB /tmp/_MEI* dir
 * behind, so signal the whole process group: SIGTERM first (lets the bootloader clean
 * up), SIGKILL if anything is still around after a grace period.
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

/**
 * Queue + playback. Each track is streamed as `yt-dlp -o - URL | ffmpeg -> PulseAudio sink`;
 * the sink's monitor is the TeamSpeak client's microphone.
 *
 * Events:
 *  - 'trackStart' (track)          audio for the track started flowing
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

  #procs = null;
  #session = 0;
  #pausedAt = 0;
  #failures = 0;

  constructor({ sink, defaultVolume, normalize, cookiesFile, log, bin = {} }) {
    super();
    this.sink = sink;
    this.volume = defaultVolume;
    this.normalize = normalize;
    this.cookiesFile = cookiesFile;
    this.log = log;
    this.bin = { ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', ...bin };
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

  add(tracks, { front = false } = {}) {
    if (front) this.queue.unshift(...tracks);
    else this.queue.push(...tracks);
    if (this.halted) this.#clearHalt(); // someone asked for music: try again
    if (!this.current) this.#playNext();
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
    if (wasActive) this.emit('idle');
  }

  pause() {
    if (!this.current || this.paused || !this.#procs) return false;
    this.#procs.ff.kill('SIGSTOP');
    this.paused = true;
    this.#pausedAt = Date.now();
    return true;
  }

  /** Resumes a paused track, or restarts a queue that was halted after failures. */
  resume() {
    if (this.halted && !this.current) {
      this.#clearHalt();
      this.#playNext();
      return true;
    }
    if (!this.current || !this.paused || !this.#procs) return false;
    this.#procs.ff.kill('SIGCONT');
    this.paused = false;
    this.current.pausedMs += Date.now() - this.#pausedAt;
    return true;
  }

  /** Seconds played of the current track. */
  elapsed() {
    if (!this.current) return 0;
    const pausedNow = this.paused ? Date.now() - this.#pausedAt : 0;
    return Math.max(0, Math.floor((Date.now() - this.current.startedAt - this.current.pausedMs - pausedNow) / 1000));
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  #clearHalt() {
    this.halted = false;
    this.#failures = 0;
  }

  #playNext() {
    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.paused = false;
      this.emit('idle');
      return;
    }
    this.current = { ...next, startedAt: Date.now(), pausedMs: 0 };
    this.paused = false;
    this.#spawn(this.current);
  }

  #advance({ skipped = false, error = null, global = false } = {}) {
    const finished = this.current;
    this.current = null;
    if (finished) {
      const { startedAt, pausedMs, ...track } = finished;
      if (error) {
        this.#failures++;
        if (global || this.#failures >= MAX_CONSECUTIVE_FAILURES) {
          // Don't burn through the queue (and spam the channel) when every track fails.
          if (global) this.queue.unshift(track); // the track itself is probably fine: retry it
          this.halted = true;
          this.paused = false;
          this.log.warn(`playback halted after ${this.#failures} failure(s): ${error}`);
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

  #spawn(track) {
    const session = ++this.#session;
    const yt = spawn(
      this.bin.ytdlp,
      [
        ...baseArgs({ cookiesFile: this.cookiesFile }),
        '-f', 'bestaudio[ext=webm]/bestaudio/best',
        '--no-playlist', '--no-progress', '--quiet',
        '-o', '-',
        track.url,
      ],
      // own process group, so killProcessGroup() reaches everything yt-dlp starts
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    const filters = this.normalize ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : [];
    const ff = spawn(
      this.bin.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vn', ...filters,
        '-ac', '2', '-ar', '48000',
        '-f', 'pulse', '-device', this.sink, '-name', 'mendil',
        'music',
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    this.#procs = { yt, ff };
    this.log.info(`loading: ${track.title} <${track.url}>`);

    let ytErr = '';
    let ffErr = '';
    yt.stderr.on('data', (c) => (ytErr = tail(ytErr, c)));
    ff.stderr.on('data', (c) => (ffErr = tail(ffErr, c)));
    yt.stdout.pipe(ff.stdin);
    // EPIPE etc. when one side dies first; the 'close' handler below decides what happened.
    yt.stdout.on('error', () => {});
    ff.stdin.on('error', () => {});
    yt.on('error', (err) => (ytErr = tail(ytErr, `ERROR: yt-dlp: ${err.message}\n`)));
    ff.on('error', (err) => (ffErr = tail(ffErr, `ERROR: ffmpeg: ${err.message}\n`)));

    // Announce the track only once audio actually flows, so a track that fails to load
    // produces one error message instead of "now playing" followed by an error.
    yt.stdout.once('data', () => {
      if (session !== this.#session || this.current !== track) return;
      track.startedAt = Date.now();
      this.#failures = 0;
      this.emit('trackStart', track);
    });

    let ytCode = null;
    yt.on('close', (code) => (ytCode = code));

    ff.on('close', (code) => {
      if (session !== this.#session) return; // killed on purpose (skip/stop)
      if (isRunning(yt)) killProcessGroup(yt);
      this.#procs = null;
      // yt-dlp failing is the usual cause (unavailable video, age gate, bot check…)
      const failed = code !== 0 || (ytCode !== null && ytCode !== 0 && this.elapsed() < 5);
      if (failed) {
        const stderr = ytErr.includes('ERROR') ? ytErr : ffErr || ytErr;
        const message = summarizeError(stderr);
        const global = GLOBAL_ERRORS.some((re) => re.test(`${ytErr}\n${ffErr}`));
        this.log.warn(`playback failed (ffmpeg=${code}, yt-dlp=${ytCode}): ${message}`);
        this.#advance({ error: message, global });
      } else {
        this.#advance();
      }
    });
  }

  #killProcs() {
    this.#session++;
    const procs = this.#procs;
    this.#procs = null;
    if (!procs) return;
    if (isRunning(procs.ff)) procs.ff.kill('SIGKILL'); // works on SIGSTOP'ed (paused) ffmpeg too
    if (isRunning(procs.yt)) killProcessGroup(procs.yt);
  }
}
