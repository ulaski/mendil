import fs from 'node:fs';
import path from 'node:path';

/**
 * Persists the player state (queue, current track + position, loop, volume) as JSON, so a
 * restart, crash or deploy picks up where it left off. Writes are atomic (tmp + rename) and
 * skipped when nothing changed.
 */
export class StateStore {
  #last = null;

  constructor(file, log) {
    this.file = file;
    this.log = log;
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`could not read ${this.file}: ${err.message}`);
      return null;
    }
    try {
      const state = JSON.parse(raw);
      if (!state || typeof state !== 'object' || !Array.isArray(state.queue)) throw new Error('unexpected shape');
      this.#last = raw;
      return state;
    } catch (err) {
      const bad = `${this.file}.bad`;
      this.log.warn(`state file is corrupt (${err.message}); moved it to ${bad} and starting empty`);
      try {
        fs.renameSync(this.file, bad);
      } catch {
        // ignore
      }
      return null;
    }
  }

  save(state) {
    const json = JSON.stringify(state);
    if (json === this.#last) return false;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, this.file);
      this.#last = json;
      return true;
    } catch (err) {
      this.log.warn(`could not save state: ${err.message}`);
      return false;
    }
  }
}
