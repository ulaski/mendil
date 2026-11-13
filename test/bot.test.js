import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Bot } from '../src/bot.js';

const quietLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

/** A voice engine that records what the bot asks of it. */
class FakeVoice extends EventEmitter {
  connected = false;
  me = { clid: null, cid: null };
  disconnectedSince = null;
  banned = false;
  playsAnyCodec = false;
  audio = { kind: 'opus', bitrate: 128, send: () => true, endSpeech() {} };
  sent = [];
  transmitting = [];
  channel = { codec: 5, quality: 10, neededTalkPower: 0, talkPower: 0, isTalker: false };
  groups = { 7: ['6', '8'] };
  async start() {}
  async tick() {}
  async stop() {}
  async sendText(target, chunk) { this.sent.push({ ...target, chunk }); return true; }
  async setTransmitting(on) { this.transmitting.push(on); }
  async moveToClientChannel() { return { moved: true }; }
  async clientInfo(clid) { return { uid: `uid-${clid}`, name: `user${clid}`, groups: this.groups[clid] ?? [] }; }
  async channelSettings() { return this.channel; }
  connect(cid = '1') {
    this.connected = true;
    this.me = { clid: '1', cid };
    this.emit('connected', { ...this.me });
  }
  say(text, { mode = 'channel', clid = '7' } = {}) {
    this.emit('text', { mode, invokerId: clid, invokerName: `user${clid}`, invokerUid: `uid-${clid}`, text });
  }
}

function makeBot({ bot: botOpts = {}, voice = new FakeVoice() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mendil-bot-'));
  const config = {
    dataDir: dir,
    voice: { backend: 'native', bitrate: 128 },
    ts3: { host: 'ts.example', port: 9987, nickname: 'Mendil', channel: '', serverPassword: '', channelPassword: '' },
    bot: { language: 'en', prefix: '!', allowedUids: [], allowedGroups: [], adminUids: [], adminGroups: [], channelHints: true, announceTracks: true, ...botOpts },
    player: { sink: 'x', defaultVolume: 70, normalize: false, maxQueue: 100, maxPlaylistItems: 50, maxTrackDuration: 0,
      cookiesFile: '', proxy: '', cacheDir: dir, prefetch: false, prefetchDir: path.join(dir, 'cache'), prefetchMaxDuration: 1800, allowPrivateUrls: false },
    ytdlp: { autoUpdate: false, venv: dir },
  };
  const bot = new Bot(config, quietLog, { backend: voice });
  return { bot, voice };
}

const settle = () => sleep(50);

/** Waits until the fake engine has sent `n` messages (they go out 300 ms apart). */
async function sentCount(voice, n, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (voice.sent.length < n) {
    if (Date.now() > deadline) throw new Error(`only ${voice.sent.length} of ${n} messages: ${JSON.stringify(voice.sent)}`);
    await sleep(20);
  }
}

test('answers private messages privately, with or without the prefix', async () => {
  const { voice } = makeBot();
  voice.connect();
  voice.say('help', { mode: 'private' });
  await sentCount(voice, 1);
  assert.equal(voice.sent.at(-1).mode, 'private');
  assert.equal(voice.sent.at(-1).clid, '7');
  assert.match(voice.sent.at(-1).chunk, /!play/);
});

test('ignores channel chat without the prefix, answers it with the prefix', async () => {
  const { voice } = makeBot();
  voice.connect();
  voice.say('hello everyone');
  await settle();
  assert.equal(voice.sent.length, 0);
  voice.say('!vol');
  await sentCount(voice, 1);
  assert.deepEqual(voice.sent.map((m) => [m.mode, m.chunk]), [['channel', 'Volume: 70%']]);
});

test('ALLOWED_GROUPS: others are refused, but !whoami and !help still work', async () => {
  const { voice } = makeBot({ bot: { allowedGroups: ['9'] } });
  voice.connect();
  voice.say('!skip');
  await sentCount(voice, 1);
  assert.match(voice.sent[0].chunk, /not allowed/);
  voice.say('!whoami');
  await sentCount(voice, 2);
  assert.match(voice.sent[1].chunk, /uid-7/);
  voice.groups[7] = ['9'];
  voice.say('!vol');
  await sentCount(voice, 3);
  assert.equal(voice.sent[2].chunk, 'Volume: 70%');
});

test('roles in chat: listeners request and manage their own songs only', async () => {
  const { bot, voice } = makeBot({ bot: { adminUids: ['uid-9'] } });
  voice.connect();
  bot.player.skip = () => true; // no real playback in this test
  voice.say('!stop');
  await sentCount(voice, 1);
  assert.match(voice.sent[0].chunk, /Only admins/);
  voice.say('!vol');
  await sentCount(voice, 2);
  assert.equal(voice.sent[1].chunk, 'Volume: 70%', 'listeners may look');
  voice.say('!vol 20');
  await sentCount(voice, 3);
  assert.match(voice.sent[2].chunk, /Only admins/);

  bot.player.current = { title: 'Theirs', url: 'https://t', requesterUid: 'uid-8' };
  voice.say('!skip');
  await sentCount(voice, 4);
  assert.match(voice.sent[3].chunk, /songs you requested/);
  bot.player.current = { title: 'Mine', url: 'https://m', requesterUid: 'uid-7' };
  voice.say('!skip');
  await sentCount(voice, 5);
  assert.match(voice.sent[4].chunk, /Mine/);

  voice.say('!help');
  await sentCount(voice, 6);
  assert.ok(!voice.sent[5].chunk.includes('!stop'), 'help leaves out admin commands');
  voice.say('!whoami');
  await sentCount(voice, 7);
  assert.match(voice.sent[6].chunk, /role: listener/);

  voice.say('!stop', { clid: '9' });
  await sentCount(voice, 8);
  assert.match(voice.sent[7].chunk, /Stopped/);
  bot.player.current = null;
});

test('each user gets a few lookups at once, then is asked to slow down', async () => {
  const { bot, voice } = makeBot();
  bot.commands.get('search').run = async (ctx) => ctx.reply('ok');
  voice.connect();
  for (let i = 0; i < 6; i++) voice.say('!search x');
  voice.say('!search x', { clid: '8' }); // someone else is unaffected
  await sentCount(voice, 7);
  const replies = voice.sent.map((m) => m.chunk);
  assert.equal(replies.filter((r) => r === 'ok').length, 6);
  assert.equal(replies.filter((r) => /Slow down/.test(r)).length, 1);
});

test('channel hints: codec advice only for Classic, talk power for both', async () => {
  const classic = makeBot();
  classic.voice.channel = { codec: 4, quality: 6, neededTalkPower: 50, talkPower: 0, isTalker: false };
  classic.voice.connect();
  await sentCount(classic.voice, 2);
  const classicHints = classic.voice.sent.map((m) => m.chunk);
  assert.ok(classicHints.some((h) => /Opus Voice/.test(h)));
  assert.ok(classicHints.some((h) => /talk power/i.test(h)));

  const voice = new FakeVoice();
  voice.playsAnyCodec = true;
  voice.channel = { codec: 4, quality: 6, neededTalkPower: 50, talkPower: 0, isTalker: false };
  makeBot({ voice });
  voice.connect();
  await sentCount(voice, 1);
  await sleep(400); // no second hint follows
  const nativeHints = voice.sent.map((m) => m.chunk);
  assert.ok(!nativeHints.some((h) => /Opus Voice/.test(h)), 'native plays Opus Music in any channel');
  assert.ok(nativeHints.some((h) => /talk power/i.test(h)));
});

test('a lost connection pauses playback, and reconnecting resumes it', async () => {
  const { bot, voice } = makeBot();
  voice.connect();
  const calls = [];
  bot.player.current = { title: 't' };
  bot.player.pause = () => (calls.push('pause'), (bot.player.paused = true));
  bot.player.resume = () => (calls.push('resume'), !(bot.player.paused = false));
  voice.connected = false;
  voice.emit('disconnected');
  voice.connect();
  await settle();
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('messages are not sent while disconnected', async () => {
  const { bot, voice } = makeBot();
  await bot.sendChannel('nobody hears this');
  assert.equal(voice.sent.length, 0);
});
