import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { baseArgs } from './ytdlp.js';

const execFileAsync = promisify(execFile);
const STDERR_TAIL = 4096;

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

/**
 * Queue + playback. Each track is streamed as `yt-dlp -o - URL | ffmpeg -> PulseAudio sink`;
 * the sink's monitor is the TeamSpeak client's microphone.
 *
 * Events: 'trackStart' (track), 'trackError' (track, message), 'idle' (queue finished/stopped)
 */
export class Player extends EventEmitter {
  queue = [];
  current = null;
  loop = 'off';
  paused = false;

  #procs = null;
  #session = 0;
  #pausedAt = 0;

  constructor({ sink, defaultVolume, normalize, cookiesFile, log }) {
    super();
    this.sink = sink;
    this.volume = defaultVolume;
    this.normalize = normalize;
    this.cookiesFile = cookiesFile;
    this.log = log;
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
    if (wasActive) this.emit('idle');
  }

  pause() {
    if (!this.current || this.paused || !this.#procs) return false;
    this.#procs.ff.kill('SIGSTOP');
    this.paused = true;
    this.#pausedAt = Date.now();
    return true;
  }

  resume() {
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
    this.emit('trackStart', this.current);
  }

  #advance({ skipped = false, error = null } = {}) {
    const finished = this.current;
    this.current = null;
    if (finished) {
      const { startedAt, pausedMs, ...track } = finished;
      if (error) {
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
      'yt-dlp',
      [
        ...baseArgs({ cookiesFile: this.cookiesFile }),
        '-f', 'bestaudio[ext=webm]/bestaudio/best',
        '--no-playlist', '--no-progress', '--quiet',
        '-o', '-',
        track.url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const filters = this.normalize ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : [];
    const ff = spawn(
      'ffmpeg',
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
    this.log.info(`playing: ${track.title} <${track.url}>`);

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

    let ytCode = null;
    yt.on('close', (code) => (ytCode = code));

    ff.on('close', (code) => {
      if (session !== this.#session) return; // killed on purpose (skip/stop)
      if (yt.exitCode === null) yt.kill('SIGKILL');
      this.#procs = null;
      // yt-dlp failing is the usual cause (unavailable video, age gate, bot check…)
      const failed = code !== 0 || (ytCode !== null && ytCode !== 0 && this.elapsed() < 5);
      if (failed) {
        const message = summarizeError(ytErr.includes('ERROR') ? ytErr : ffErr || ytErr);
        this.log.warn(`playback failed (ffmpeg=${code}, yt-dlp=${ytCode}): ${message}`);
        this.#advance({ error: message });
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
    for (const p of [procs.ff, procs.yt]) {
      if (p.exitCode !== null || p.signalCode !== null) continue;
      p.kill('SIGKILL'); // works on SIGSTOP'ed (paused) processes too
    }
  }
}
