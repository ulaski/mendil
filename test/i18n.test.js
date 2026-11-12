import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, createI18n } from '../src/i18n/index.js';
import { createCommands } from '../src/commands.js';

function keys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

const IGNORED = /^(commandAliases|loopAliases)\./;
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

for (const [lang, dict] of Object.entries(LANGUAGES)) {
  if (lang === 'en') continue;

  test(`${lang}: has the same message keys as en`, () => {
    const en = keys(LANGUAGES.en).filter((k) => !IGNORED.test(k)).sort();
    const other = keys(dict).filter((k) => !IGNORED.test(k)).sort();
    assert.deepEqual(other, en);
  });

  test(`${lang}: uses the same placeholders as en`, () => {
    const en = createI18n('en');
    const tr = createI18n(lang);
    for (const key of keys(LANGUAGES.en).filter((k) => !IGNORED.test(k))) {
      const raw = (d) => key.split('.').reduce((n, p) => n[p], d);
      assert.deepEqual(placeholders(raw(dict)), placeholders(raw(LANGUAGES.en)), key);
    }
    assert.ok(en.t('volume', { volume: 5 }).includes('5'));
    assert.ok(tr.t('volume', { volume: 5 }).includes('5'));
  });
}

test('unknown language falls back to English', () => {
  const i18n = createI18n('xx', { prefix: '!' });
  assert.equal(i18n.language, 'en');
  assert.equal(i18n.t('unknownCommand'), 'Unknown command. Type !help');
});

function fakeBot(language) {
  return {
    i18n: createI18n(language, { prefix: '!' }),
    config: { bot: { prefix: '!' }, player: { maxQueue: 10 } },
    player: { queue: [], current: null, loop: 'off', volume: 50 },
  };
}

for (const lang of Object.keys(LANGUAGES)) {
  test(`${lang}: command aliases don't shadow other commands`, () => {
    const bot = fakeBot(lang);
    const commands = createCommands(bot);
    const english = createCommands(fakeBot('en'));
    // every English name must still map to the same command (by canonical name)
    for (const [name, cmd] of english) assert.equal(commands.get(name).names[0], cmd.names[0], name);
    // aliases of one command must not collide with another command's alias
    const seen = new Map();
    for (const [canonical, aliases] of Object.entries(bot.i18n.commandAliases)) {
      for (const alias of aliases) {
        assert.ok(!seen.has(alias), `"${alias}" used by ${seen.get(alias)} and ${canonical}`);
        seen.set(alias, canonical);
        assert.equal(commands.get(alias).names[0], canonical);
      }
    }
  });

  test(`${lang}: help lists every command with a description`, async () => {
    const bot = fakeBot(lang);
    let reply = '';
    await createCommands(bot).get('help').run({ reply: (m) => (reply = m) }, '');
    assert.ok(!/help\.\w+/.test(reply), reply); // no missing translation keys
    assert.ok(reply.includes('!play'));
  });
}
