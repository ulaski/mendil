import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequests } from '../src/requests.js';
import { parseSeekTime } from '../src/commands.js';
import { queueLimitApplies } from '../src/roles.js';

function fakeBot({ maxQueuePerUser = 2, queue = [] } = {}) {
  const player = { queue: [...queue], isPlaying: true, add(tracks) { this.queue.push(...tracks); } };
  return { player, config: { player: { maxQueue: 100, maxTrackDuration: 0, maxQueuePerUser } } };
}
const song = (n) => ({ title: `Song ${n}`, url: `https://example.com/${n}`, duration: 100 });

test('MAX_QUEUE_PER_USER: a playlist fills only the free places, then requests are refused', () => {
  const bot = fakeBot({ queue: [{ ...song(0), requesterUid: 'other' }] });
  const { admit } = createRequests(bot);
  const first = admit([song(1), song(2), song(3)], { requesterUid: 'me', limit: true });
  assert.equal(first.added.length, 2);
  assert.equal(first.limited, 1);
  assert.deepEqual(admit([song(4)], { requesterUid: 'me', limit: true }), { ok: false, error: 'userLimit', max: 2 });
  assert.equal(admit([song(5)], { requesterUid: 'other', limit: true }).ok, true, 'others have their own allowance');
  assert.equal(admit([song(6)], { requesterUid: 'me', limit: false }).ok, true, 'exempt');
});

test('MAX_QUEUE_PER_USER=0 means no limit', () => {
  const { admit } = createRequests(fakeBot({ maxQueuePerUser: 0 }));
  const result = admit([song(1), song(2), song(3)], { requesterUid: 'me', limit: true });
  assert.equal(result.added.length, 3);
  assert.equal(result.limited, 0);
});

test('the limit spares named admins only; without ADMIN_* it applies to everyone', () => {
  const none = { adminUids: [], adminGroups: [] };
  const named = { adminUids: ['boss'], adminGroups: [] };
  assert.equal(queueLimitApplies(none, { uid: 'a', role: 'admin' }), true);
  assert.equal(queueLimitApplies(named, { uid: 'boss', role: 'admin' }), false);
  assert.equal(queueLimitApplies(named, { uid: 'a', role: 'listener' }), true);
  assert.equal(queueLimitApplies(named, { uid: null, role: 'admin' }), false, 'the panel password has no TeamSpeak user');
});

test('seek times: absolute, relative, and junk', () => {
  assert.equal(parseSeekTime('90'), 90);
  assert.equal(parseSeekTime('1:30'), 90);
  assert.equal(parseSeekTime('1:02:03'), 3723);
  assert.equal(parseSeekTime('+30', 100), 130);
  assert.equal(parseSeekTime('-30', 20), 0);
  for (const bad of ['', 'abc', '1:75', '1:2:3:4', '--5', '1.5']) assert.equal(parseSeekTime(bad), null, bad);
});
