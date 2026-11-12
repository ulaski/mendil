import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { Semaphore } from '../src/ytdlp.js';
import { percentile } from '../src/stats.js';

const quietLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mendil-state-')), 'sub', 'state.json');

test('state store saves atomically, skips unchanged writes and loads it back', () => {
  const file = tmpFile();
  const store = new StateStore(file, quietLog);
  assert.equal(store.load(), null);
  const state = { queue: [{ title: 'a', url: 'u' }], current: null, loop: 'off', volume: 50, paused: false };
  assert.equal(store.save(state), true);
  assert.equal(store.save(state), false, 'nothing changed');
  assert.ok(!fs.existsSync(`${file}.tmp`));
  assert.deepEqual(new StateStore(file, quietLog).load(), state);
});

test('a corrupt state file is set aside and the bot starts empty', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"queue": [tru');
  assert.equal(new StateStore(file, quietLog).load(), null);
  assert.ok(fs.existsSync(`${file}.bad`));
  assert.ok(!fs.existsSync(file));
});

test('semaphore limits concurrency and rejects when too many are waiting', async () => {
  const sem = new Semaphore(2, 1);
  let running = 0;
  let peak = 0;
  const release = [];
  const job = () => sem.run(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => release.push(r));
    running--;
  });
  const jobs = [job(), job(), job()];
  await assert.rejects(job(), (err) => err.busy === true);
  while (release.length < 2) await new Promise((r) => setImmediate(r));
  release.shift()();
  release.shift()();
  while (release.length < 1) await new Promise((r) => setImmediate(r));
  release.shift()();
  await Promise.all(jobs);
  assert.equal(peak, 2);
});

test('percentile', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
});
