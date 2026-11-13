// Keeps the documentation site in step with the code: every setting Mendil reads must be on
// the configuration page, and every chat command on the commands page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DOCS = 'site/src/content/docs/reference';

// Set by the image or the entrypoint for Mendil's own processes, not by users.
const INTERNAL = new Set([
  'DISPLAY', 'HOME', 'LD_LIBRARY_PATH', 'PULSE_PID', 'XVFB_PID', 'PULSE_SINK', 'TS3_CLIENT_DIR',
  'TS3_CONFIG_DIR', 'TS3_CLIENTQUERY_PORT', 'YTDLP_VENV', 'PREFETCH_DIR', 'MENDIL_DATA_DIR',
]);

function sourceFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('every setting the code reads is documented on the configuration page', () => {
  const names = new Set();
  for (const file of sourceFiles('src')) {
    for (const m of read(file).matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
  }
  for (const m of read('docker/entrypoint.sh').matchAll(/\$\{?([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
  const page = read(`${DOCS}/configuration.md`);
  const missing = [...names].filter((n) => !INTERNAL.has(n) && !page.includes(`\`${n}\``)).sort();
  assert.deepEqual(missing, [], `add these to ${DOCS}/configuration.md (or to INTERNAL if users never set them)`);
});

test('every chat command is on the commands page', async () => {
  const { createCommands } = await import('../src/commands.js');
  const { createI18n } = await import('../src/i18n/index.js');
  const bot = {
    i18n: createI18n('en', { prefix: '!' }),
    config: { bot: { prefix: '!' }, player: { maxQueue: 10, allowPrivateUrls: false }, radio: { stations: [] } },
    player: { queue: [], current: null },
  };
  const canonical = new Set([...createCommands(bot).values()].map((c) => c.names[0]));
  const page = read(`${DOCS}/commands.md`);
  const missing = [...canonical].filter((name) => !page.includes(`\`!${name}`)).sort();
  assert.deepEqual(missing, [], `add these commands to ${DOCS}/commands.md`);
});
