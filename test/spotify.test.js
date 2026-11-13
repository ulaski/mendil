import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSpotifyInput, parseEmbedPage, parseSpotifyUrl, pickYoutubeMatch, resolveSpotify } from '../src/spotify.js';

const ID = '4PTG3Z6ehGkBFwjybzWkR8';
const page = (entity) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;

const TRACK = { type: 'track', name: 'Mimesis', uri: `spotify:track:${ID}`, artists: [{ name: 'Fontaines D.C.' }], duration: 232_000 };
const PLAYLIST = {
  type: 'playlist', name: 'Romance', uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
  trackList: [
    { uri: `spotify:track:${ID}`, title: 'Starburster', subtitle: 'Fontaines D.C.', duration: 265_000 },
    { uri: 'spotify:track:0dEIca2nhcxDUV8C5QkPYb', title: 'Bug', subtitle: 'Fontaines D.C., Someone', duration: 180_500 },
    { uri: 'spotify:local:x', title: 'A local file', subtitle: 'Me', duration: 1000 },
  ],
};

test('recognises Spotify links and URIs, nothing else', () => {
  for (const [input, expected] of [
    [`https://open.spotify.com/track/${ID}`, { type: 'track', id: ID }],
    [`https://open.spotify.com/intl-tr/track/${ID}?si=abc`, { type: 'track', id: ID }],
    [`https://open.spotify.com/album/${ID}`, { type: 'album', id: ID }],
    [`https://open.spotify.com/playlist/${ID}?si=x&pt=y`, { type: 'playlist', id: ID }],
    [`spotify:playlist:${ID}`, { type: 'playlist', id: ID }],
  ]) assert.deepEqual(parseSpotifyUrl(input), expected, input);
  for (const input of ['fontaines dc mimesis', `https://open.spotify.com/artist/${ID}`, `https://open.spotify.com.evil.com/track/${ID}`, 'https://www.youtube.com/watch?v=abc']) {
    assert.equal(parseSpotifyUrl(input), null, input);
  }
  assert.equal(isSpotifyInput('https://spotify.link/AbC123'), true);
  assert.equal(isSpotifyInput('https://spotify.link/../x'), false);
});

test('a song becomes one queue entry, looked up on YouTube by artist and title', () => {
  const { title, tracks } = parseEmbedPage(page(TRACK));
  assert.equal(title, null);
  assert.deepEqual(tracks, [{
    title: 'Fontaines D.C. - Mimesis', url: `https://open.spotify.com/track/${ID}`, duration: 232, isLive: false, search: 'Fontaines D.C. - Mimesis',
  }]);
});

test('an album or playlist lists its songs; entries without a Spotify song are skipped', () => {
  const { title, tracks } = parseEmbedPage(page(PLAYLIST));
  assert.equal(title, 'Romance');
  assert.deepEqual(tracks.map((t) => [t.title, t.duration]), [['Fontaines D.C. - Starburster', 265], ['Fontaines D.C., Someone - Bug', 181]]);
});

test('a page without data gives a clear error', () => {
  assert.throws(() => parseEmbedPage('<html>nothing</html>'), /Spotify changed its page/);
});

test('resolveSpotify reads the embed page, and follows spotify.link short links', async () => {
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    if (url.startsWith('https://spotify.link/')) return { ok: true, status: 200, url: `https://open.spotify.com/track/${ID}?si=1`, text: async () => '' };
    return { ok: true, status: 200, url, text: async () => page(TRACK) };
  };
  const result = await resolveSpotify('https://spotify.link/AbC123', { fetchImpl });
  assert.equal(result.tracks[0].title, 'Fontaines D.C. - Mimesis');
  assert.deepEqual(fetched, ['https://spotify.link/AbC123', `https://open.spotify.com/embed/track/${ID}`]);
  await assert.rejects(resolveSpotify(`https://open.spotify.com/track/${ID}`, { fetchImpl: async () => ({ ok: false, status: 404 }) }), /does not exist/);
});

test('the YouTube match is the result closest to the song length, within reason', () => {
  const r = (url, duration, isLive = false) => ({ url, duration, isLive });
  assert.equal(pickYoutubeMatch([r('video', 300), r('audio', 233), r('other', 240)], 232).url, 'audio');
  assert.equal(pickYoutubeMatch([r('video', 270), r('cover', 120)], 232).url, 'video', 'closest within 25%');
  assert.equal(pickYoutubeMatch([r('top', 900), r('second', 30)], 232).url, 'top', 'nothing close: trust the top result');
  assert.equal(pickYoutubeMatch([r('live', null, true), r('ok', 100)], null).url, 'ok');
  assert.equal(pickYoutubeMatch([], 100), null);
});
