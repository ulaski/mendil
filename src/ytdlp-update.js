import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { baseArgs, ytdlpEvents } from './ytdlp.js';
import { AUDIO_FORMAT } from './prefetch.js';

const execFileAsync = promisify(execFile);

const STARTUP_DELAY_MS = 2 * 60_000;
const PERIOD_MS = 24 * 60 * 60_000;
const MIN_INTERVAL_MS = 6 * 60 * 60_000; // for updates triggered by failures

// Errors that a newer yt-dlp usually fixes (YouTube changed something).
const OUTDATED_HINTS = [
  /Unable to extract/i,
  /nsig extraction failed/i,
  /Signature extraction failed/i,
  /Precondition check failed/i,
  /Requested format is not available/i,
  /Please report this issue/i,
];

/**
 * Keeps yt-dlp current without blocking startup: runs in the background after the bot is up,
 * once a day, and when extraction fails in a way an update typically fixes. A new version is
 * smoke-tested and rolled back to the previous one if it doesn't work.
 *
 * yt-dlp lives in a Python venv (see Dockerfile); without one the updater does nothing.
 */
export class YtdlpUpdater {
  #running = false;
  #lastRun = 0;
  #timers = [];

  constructor({ enabled, venv, ytOpts = {}, smokeTestUrl = () => null, log }) {
    this.enabled = enabled;
    this.pip = path.join(venv, 'bin', 'pip');
    this.ytdlp = path.join(venv, 'bin', 'yt-dlp');
    this.ytOpts = ytOpts;
    this.smokeTestUrl = smokeTestUrl;
    this.log = log;
  }

  start() {
    if (!this.enabled) return;
    if (!fs.existsSync(this.pip)) {
      this.log.debug(`no yt-dlp venv at ${path.dirname(path.dirname(this.pip))}; auto-update disabled`);
      return;
    }
    this.#timers.push(setTimeout(() => this.run('scheduled'), STARTUP_DELAY_MS));
    this.#timers.push(setInterval(() => this.run('daily'), PERIOD_MS));
    for (const t of this.#timers) t.unref?.();
    ytdlpEvents.on('failure', (stderr) => {
      if (OUTDATED_HINTS.some((re) => re.test(stderr)) && Date.now() - this.#lastRun > MIN_INTERVAL_MS) {
        this.run('extraction failed');
      }
    });
  }

  stop() {
    for (const t of this.#timers) clearTimeout(t);
  }

  async version() {
    try {
      const { stdout } = await execFileAsync(this.ytdlp, ['--version'], { timeout: 30_000 });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async run(reason) {
    if (this.#running) return;
    this.#running = true;
    this.#lastRun = Date.now();
    const before = await this.version();
    try {
      await execFileAsync(this.pip, ['install', '--upgrade', '--quiet', '--disable-pip-version-check', 'yt-dlp[default]'], { timeout: 5 * 60_000 });
      const after = await this.version();
      if (after === before) {
        this.log.debug(`yt-dlp is up to date (${after})`);
        return;
      }
      if (!after || !(await this.#smokeTest())) throw new Error(`yt-dlp ${after ?? '?'} failed its self-test`);
      this.log.info(`yt-dlp updated ${before} -> ${after} (${reason})`);
    } catch (err) {
      this.log.warn(`yt-dlp update failed: ${err.message.split('\n')[0]}`);
      if (before && (await this.version()) !== before) {
        try {
          await execFileAsync(this.pip, ['install', '--quiet', '--disable-pip-version-check', `yt-dlp[default]==${before}`], { timeout: 5 * 60_000 });
          this.log.warn(`rolled yt-dlp back to ${before}`);
        } catch (rollbackErr) {
          this.log.error(`yt-dlp rollback to ${before} failed: ${rollbackErr.message.split('\n')[0]}`);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /** Can the new version still extract a track that worked recently? */
  async #smokeTest() {
    const url = this.smokeTestUrl();
    if (!url) return true;
    try {
      await execFileAsync(this.ytdlp, [...baseArgs(this.ytOpts), '--simulate', '--no-playlist', '-f', AUDIO_FORMAT, url], { timeout: 2 * 60_000 });
      return true;
    } catch {
      return false;
    }
  }
}
