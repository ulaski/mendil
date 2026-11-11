import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, escape, parseRows, unescape } from '../src/ts3/protocol.js';
import { chunkMessage, formatDuration, stripBBCode } from '../src/format.js';

test('escape/unescape round-trip', () => {
  const raw = 'a b|c/d\\e\nf\tg';
  assert.equal(escape(raw), 'a\\sb\\pc\\/d\\\\e\\nf\\tg');
  assert.equal(unescape(escape(raw)), raw);
});

test('parseRows splits rows and unescapes values', () => {
  assert.deepEqual(parseRows('clid=1 client_nickname=Foo\\sBar|clid=2 client_nickname=X'), [
    { clid: '1', client_nickname: 'Foo Bar' },
    { clid: '2', client_nickname: 'X' },
  ]);
});

test('buildCommand skips empty params and adds flags', () => {
  assert.equal(
    buildCommand('connect', { address: 'ts.example.com:9987', password: '', nickname: 'Music Bot' }),
    'connect address=ts.example.com:9987 nickname=Music\\sBot',
  );
  assert.equal(buildCommand('clientlist', {}, ['uid', '-voice']), 'clientlist -uid -voice');
});

test('stripBBCode unwraps TeamSpeak links', () => {
  assert.equal(stripBBCode('play [URL]https://youtu.be/abc[/URL]'), 'play https://youtu.be/abc');
  assert.equal(stripBBCode('play [URL=https://youtu.be/abc]link[/URL]'), 'play https://youtu.be/abc');
  assert.equal(stripBBCode('[b]play[/b] daft punk'), 'play daft punk');
});

test('formatDuration', () => {
  assert.equal(formatDuration(5), '0:05');
  assert.equal(formatDuration(242), '4:02');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDuration(null), '?');
});

test('chunkMessage keeps chunks under the byte limit', () => {
  const text = Array.from({ length: 60 }, (_, i) => `${i}. şarkı adı çok uzun bir başlık`).join('\n');
  const chunks = chunkMessage(text, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(Buffer.byteLength(c) <= 200);
  assert.equal(chunks.join('\n'), text);
  for (const c of chunkMessage('x'.repeat(1000), 100)) assert.ok(Buffer.byteLength(c) <= 100);
});
