import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { IcyStripper, findStation, firstPlaylistEntry, openStation, parseIcyTitle, parseStations } from '../src/radio.js';

test('RADIO_STATIONS: name=url pairs, URLs may contain "=", junk is ignored', () => {
  assert.deepEqual(parseStations('Groove Salad=https://ice1.somafm.com/groovesalad-128-mp3, paradise=https://x.example/s?a=1&b=2,bad,=https://y,ftp=ftp://z,groove salad=https://dup'), [
    { name: 'Groove Salad', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
    { name: 'paradise', url: 'https://x.example/s?a=1&b=2' },
  ]);
  assert.deepEqual(parseStations(''), []);
});

test('stations are found by name (any case) or made from a web address', () => {
  const stations = parseStations('Groove Salad=https://a.example/gs');
  assert.equal(findStation(stations, 'groove salad'), stations[0]);
  assert.equal(findStation(stations, 'https://a.example/gs'), stations[0]);
  assert.deepEqual(findStation(stations, 'https://www.radio.example/live.mp3'), { name: 'radio.example', url: 'https://www.radio.example/live.mp3' });
  assert.equal(findStation(stations, 'jazz'), null);
  assert.equal(findStation(stations, 'file:///etc/passwd'), null);
});

test('ICY titles: UTF-8, Latin-1 and empty ones', () => {
  assert.equal(parseIcyTitle(Buffer.from("StreamTitle='Fontaines D.C. - Mimesis';StreamUrl='';\0\0")), 'Fontaines D.C. - Mimesis');
  assert.equal(parseIcyTitle(Buffer.from("StreamTitle='Barış Manço - Dönence';", 'utf8')), 'Barış Manço - Dönence');
  assert.equal(parseIcyTitle(Buffer.from("StreamTitle='Café';", 'latin1')), 'Café');
  assert.equal(parseIcyTitle(Buffer.from("StreamTitle='';")), null);
});

/** An ICY stream: `metaint` bytes of audio, then a metadata block, repeated. */
function icyBytes(metaint, titles) {
  const parts = [];
  for (const title of titles) {
    parts.push(Buffer.alloc(metaint, 0x41));
    if (title === null) {
      parts.push(Buffer.from([0]));
    } else {
      const text = Buffer.from(`StreamTitle='${title}';`);
      const blocks = Math.ceil(text.length / 16);
      const meta = Buffer.alloc(blocks * 16);
      text.copy(meta);
      parts.push(Buffer.from([blocks]), meta);
    }
  }
  return Buffer.concat(parts);
}

test('the ICY stripper passes the audio through and reports title changes, across any chunking', async () => {
  const data = icyBytes(10, ['A - One', null, 'A - One', 'B - Two']);
  for (const size of [1, 3, 7, 1000]) {
    const titles = [];
    const stripper = new IcyStripper(10, (t) => titles.push(t));
    const out = [];
    stripper.on('data', (c) => out.push(c));
    for (let i = 0; i < data.length; i += size) stripper.write(data.subarray(i, i + size));
    stripper.end();
    await new Promise((r) => stripper.on('end', r));
    const audio = Buffer.concat(out);
    assert.equal(audio.length, 40, `chunk ${size}`);
    assert.ok(audio.every((b) => b === 0x41), `chunk ${size}`);
    assert.deepEqual(titles, ['A - One', 'B - Two'], `chunk ${size}`);
  }
});

test('.pls / .m3u playlists point to the stream', () => {
  assert.equal(firstPlaylistEntry('[playlist]\nnumberofentries=2\nFile1=https://ice2.somafm.com/gs-128-mp3\nTitle1=x'), 'https://ice2.somafm.com/gs-128-mp3');
  assert.equal(firstPlaylistEntry('#EXTM3U\n#EXTINF:-1,Radio\nhttp://stream.example/live\n'), 'http://stream.example/live');
  assert.equal(firstPlaylistEntry('nothing here'), null);
});

const response = (url, { status = 200, type = 'audio/mpeg', headers = {}, body = '' } = {}) => ({
  ok: status < 400, status, url,
  headers: new Headers({ 'content-type': type, ...headers }),
  body: typeof body === 'string' ? Readable.toWeb(Readable.from([Buffer.from(body)])) : Readable.toWeb(Readable.from([body])),
  text: async () => String(body),
});

test('openStation follows a .pls to an ICY stream and strips the metadata', async () => {
  const fetchImpl = async (url) => (url.endsWith('.pls')
    ? response(url, { type: 'audio/x-scpls', body: '[playlist]\nFile1=https://stream.example/live\n' })
    : response(url, { headers: { 'icy-metaint': '10' }, body: icyBytes(10, ['X - Y']) }));
  const titles = [];
  const { audio } = await openStation('https://radio.example/listen.pls', { fetchImpl, onTitle: (t) => titles.push(t) });
  const chunks = [];
  for await (const c of audio) chunks.push(c);
  assert.equal(Buffer.concat(chunks).length, 10);
  assert.deepEqual(titles, ['X - Y']);
});

test('openStation hands HLS to ffmpeg and reports HTTP errors', async () => {
  const hls = async (url) => response(url, { type: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-VERSION:3\nseg1.ts\n' });
  assert.deepEqual(await openStation('https://radio.example/live.m3u8', { fetchImpl: hls }), { url: 'https://radio.example/live.m3u8' });
  await assert.rejects(openStation('https://radio.example/x', { fetchImpl: async (url) => response(url, { status: 404 }) }), /answered 404/);
});

test('the connect time limit does not cut the audio off later', async () => {
  // A body that keeps sending well past the connect limit.
  const body = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 6; i++) {
        controller.enqueue(new Uint8Array(4).fill(i));
        await new Promise((r) => setTimeout(r, 30));
      }
      controller.close();
    },
  });
  const fetchImpl = async (url, { signal }) => {
    signal.addEventListener('abort', () => body.cancel().catch(() => {}));
    return { ok: true, status: 200, url, headers: new Headers({ 'content-type': 'audio/mpeg' }), body };
  };
  const { audio } = await openStation('https://radio.example/live', { fetchImpl, connectTimeoutMs: 40 });
  let bytes = 0;
  for await (const c of audio) bytes += c.length;
  assert.equal(bytes, 24);
});
