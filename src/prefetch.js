import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { baseArgs, isGlobalError, summarizeError, ytdlpEvents } from './ytdlp.js';

export const AUDIO_FORMAT = 'bestaudio[ext=webm]/bestaudio/best';
const DOWNLOAD_TIMEOUT_MS = 3 * 60_000;
const MAX_FILESIZE = '200M';
const STDERR_TAIL = 4096;

const keyOf = (track) => crypto.createHash('sha1').update(track.url).digest('hex').slice(0, 16);

function killGroup(child, signal = 'SIGTERM') {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

/** Integrated loudness of a file in LUFS (ffmpeg ebur128), or null. */
export function measureLoudness(ffmpegBin, file) {
  return new Promise((resolve) => {
    const ff = spawn(ffmpegBin, ['-hide_banner', '-nostats', '-nostdin', '-i', file, '-vn',
      '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let out = '';
    ff.stderr.on('data', (c) => (out = (out + c).slice(-STDERR_TAIL)));
    ff.on('error', () => resolve(null));
    ff.on('close', (code) => {
      const m = [...out.matchAll(/^\s+I:\s+(-?[\d.]+) LUFS/gm)].pop();
      resolve(code === 0 && m ? Number(m[1]) : null);
    });
  });
}

/**
 * Downloads upcoming tracks to local files, so playback starts almost instantly, doesn't
 * depend on the network mid-track, can seek, and pauses safely. Also measures loudness
 * once per file, which is far cheaper than normalising in real time.
 *
 * Only finite, non-live tracks up to `maxDuration` seconds are fetched. At most the
 * current and the next track are kept on disk; everything else is deleted.
 */
export class Prefetcher {
  #jobs = new Map(); // key -> job
  #wanted = [];

  constructor({ dir, cookiesFile, cacheDir, maxDuration = 30 * 60, normalize, targetLufs = -16, log, bin = {} }) {
    this.dir = dir;
    this.opts = { cookiesFile, cacheDir };
    this.maxDuration = maxDuration;
    this.normalize = normalize;
    this.targetLufs = targetLufs;
    this.log = log;
    this.bin = { ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', ...bin };
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  eligible(track) {
    return Boolean(track) && !track.isLive && Number.isFinite(track.duration) && track.duration > 0
      && track.duration <= this.maxDuration;
  }

  /** Declares which tracks should be on disk, in priority order (current first). */
  want(tracks) {
    const wanted = [];
    for (const track of tracks) {
      if (!this.eligible(track)) continue;
      const key = keyOf(track);
      if (!wanted.some((w) => w.key === key)) wanted.push({ key, track });
    }
    this.#wanted = wanted.slice(0, 2);
    for (const key of [...this.#jobs.keys()]) {
      if (!this.#wanted.some((w) => w.key === key)) this.#drop(key);
    }
    this.#pump();
  }

  /**
   * Resolves once `track` is downloaded: { file, gainDb } on success, { error, global } when
   * yt-dlp failed, or { timeout: true }. The track must be the first one passed to want().
   */
  async ensure(track) {
    const key = keyOf(track);
    if (!this.#jobs.has(key)) this.#start(key, track);
    return this.#jobs.get(key).promise;
  }

  /** Stops everything and deletes all files. */
  clear() {
    this.want([]);
  }

  // Run the first wanted track right away (it is about to play); prefetch the rest one at a time.
  #pump() {
    const [first, ...rest] = this.#wanted;
    if (first && !this.#jobs.has(first.key)) this.#start(first.key, first.track);
    if ([...this.#jobs.values()].some((j) => j.state === 'running')) return;
    const next = rest.find((w) => !this.#jobs.has(w.key));
    if (next) this.#start(next.key, next.track);
  }

  #start(key, track) {
    const job = { key, state: 'running', child: null, analyzer: null };
    this.#jobs.set(key, job);
    const started = Date.now();
    job.promise = this.#download(job, track).then((result) => {
      job.state = result.file ? 'done' : 'failed';
      job.result = result;
      if (result.file) {
        this.log.debug(`prefetched in ${Date.now() - started} ms (gain ${result.gainDb ?? 'n/a'} dB): ${track.title}`);
      } else {
        this.log.debug(`prefetch failed for ${track.title}: ${result.error ?? 'timeout'}`);
      }
      if (this.#jobs.get(key) === job) this.#pump();
      return result;
    });
  }

  async #download(job, track) {
    const template = path.join(this.dir, `${job.key}.%(ext)s`);
    const result = await new Promise((resolve) => {
      const yt = spawn(this.bin.ytdlp, [
        ...baseArgs(this.opts),
        '-f', AUDIO_FORMAT,
        '--no-playlist', '--no-progress', '--quiet', '--no-part', '--no-mtime',
        '--max-filesize', MAX_FILESIZE,
        '-o', template,
        '--print', 'after_move:filepath', '--no-simulate',
        track.url,
      ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      job.child = yt;
      let stdout = '';
      let stderr = '';
      yt.stdout.on('data', (c) => (stdout += c));
      yt.stderr.on('data', (c) => (stderr = (stderr + c).slice(-STDERR_TAIL)));
      const timer = setTimeout(() => {
        job.timedOut = true;
        killGroup(yt, 'SIGKILL');
      }, DOWNLOAD_TIMEOUT_MS);
      yt.on('error', (err) => (stderr += `\nERROR: ${err.message}`));
      yt.on('close', (code) => {
        clearTimeout(timer);
        job.child = null;
        if (job.cancelled) return resolve({ cancelled: true });
        if (job.timedOut) return resolve({ timeout: true });
        const file = stdout.trim().split('\n').pop();
        if (code === 0 && file && fs.existsSync(file)) return resolve({ file });
        ytdlpEvents.emit('failure', stderr);
        resolve({ error: summarizeError(stderr), global: isGlobalError(stderr) });
      });
    });
    if (!result.file || !this.normalize || job.cancelled) return result;

    const lufs = await measureLoudness(this.bin.ffmpeg, result.file);
    if (job.cancelled) return { cancelled: true };
    // Very quiet/silent tracks get no boost beyond +15 dB; the limiter catches peaks.
    const gainDb = lufs === null || lufs < -70 ? null : Math.max(-20, Math.min(15, this.targetLufs - lufs));
    return { file: result.file, gainDb: gainDb === null ? null : Math.round(gainDb * 10) / 10 };
  }

  #drop(key) {
    const job = this.#jobs.get(key);
    this.#jobs.delete(key);
    if (job) {
      job.cancelled = true;
      if (job.child) killGroup(job.child);
    }
    try {
      for (const f of fs.readdirSync(this.dir)) if (f.startsWith(key)) fs.rmSync(path.join(this.dir, f), { force: true });
    } catch {
      // directory gone
    }
  }
}
