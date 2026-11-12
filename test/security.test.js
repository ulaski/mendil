import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, UrlGuard } from '../src/netguard.js';
import { toTrack } from '../src/ytdlp.js';
import { redact } from '../src/ts3/clientquery.js';
import { trackLink } from '../src/format.js';
import { RateLimiter } from '../src/ratelimit.js';

test('toTrack only accepts http(s) URLs (a crafted feed entry cannot become a yt-dlp option)', () => {
  assert.equal(toTrack({ title: 'x', url: '--exec=touch /tmp/pwned', ie_key: 'Generic' }), null);
  assert.equal(toTrack({ title: 'x', url: '--config-locations=/tmp/a.mp3' }), null);
  assert.equal(toTrack({ title: 'x', url: 'file:///etc/passwd' }), null);
  assert.equal(toTrack({ title: 'x', webpage_url: 'https://example.com/a.mp3' }).url, 'https://example.com/a.mp3');
  // Flat YouTube playlist entries carry only an id: still turned into a watch URL.
  assert.equal(toTrack({ title: 'x', id: 'abc123', ie_key: 'Youtube' }).url, 'https://www.youtube.com/watch?v=abc123');
});

test('private, loopback, link-local and reserved addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.10', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '142.250.185.78', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('UrlGuard refuses URLs on private networks, by literal IP or by DNS, and caches lookups', async () => {
  let lookups = 0;
  const dns = { 'internal.example': ['10.0.0.7'], 'media.example': ['93.184.216.34'], 'mixed.example': ['93.184.216.34', '127.0.0.1'] };
  const guard = new UrlGuard({ lookup: async (host) => { lookups++; return (dns[host] ?? []).map((address) => ({ address })); } });
  assert.equal(await guard.isAllowed('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(await guard.isAllowed('http://[::1]:8080/'), false);
  assert.equal(await guard.isAllowed('http://internal.example/a.mp3'), false);
  assert.equal(await guard.isAllowed('http://mixed.example/a.mp3'), false);
  assert.equal(await guard.isAllowed('https://media.example/a.mp3'), true);
  assert.equal(await guard.isAllowed('https://media.example/b.mp3'), true);
  assert.equal(lookups, 3);
  assert.equal(await guard.isAllowed('ftp://media.example/a'), false);
  await assert.rejects(guard.assertAllowed('http://127.0.0.1/'), (err) => err.blockedUrl === true);
  assert.equal(await new UrlGuard({ allowPrivate: true }).isAllowed('http://192.168.1.10/a.mp3'), true);
});

test('debug log lines never contain passwords or API keys', () => {
  assert.equal(redact('auth apikey=ABCD-1234'), 'auth apikey=***');
  assert.equal(
    redact('connect address=ts.example.com:9987 password=s3cr\\set nickname=Mendil channel=Music channel_pw=pw2'),
    'connect address=ts.example.com:9987 password=*** nickname=Mendil channel=Music channel_pw=***',
  );
  assert.equal(redact('clientlist'), 'clientlist');
});

test('trackLink cannot break out of the [url] tag', () => {
  const link = trackLink({ title: 'Song [b]x[/b]', url: 'https://e.com/a]evil[url=https://bad.example]x' });
  assert.equal(link, '[url=https://e.com/a%5Devil%5Burl=https://bad.example%5Dx]Song (b)x(/b)[/url]');
  assert.equal(trackLink({ title: 'T', url: '--exec=x' }), 'T');
});

test('RateLimiter allows a burst, then one request per refill interval, per user', () => {
  let now = 0;
  const rl = new RateLimiter({ capacity: 3, refillMs: 1000, now: () => now });
  assert.deepEqual([rl.take('a'), rl.take('a'), rl.take('a'), rl.take('a')], [true, true, true, false]);
  assert.equal(rl.take('b'), true); // other users are unaffected
  now += 1000;
  assert.equal(rl.take('a'), true);
  assert.equal(rl.take('a'), false);
});
