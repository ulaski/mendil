import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectPolicy, ATTEMPT_TIMEOUT_MS, MAX_QUERY_ATTEMPTS, KICK_DELAY_MS, BAN_DEFAULT_MS } from '../src/reconnect.js';

const policy = () => new ReconnectPolicy({ random: () => 0.5 }); // deterministic jitter

/** Advances the clock until next() asks for something other than waiting. */
function runUntilAction(p, now, limitMs = 30 * 60_000) {
  for (let t = now; t < now + limitMs; t += 100) {
    const step = p.next(t);
    if (step.action !== 'wait') return { ...step, at: t };
  }
  return { action: 'wait', at: now + limitMs };
}

test('a lost connection is retried within seconds, then with growing backoff', () => {
  const p = policy();
  p.onStatus('connection_established', 0);
  p.onDisconnected(1_000);
  const first = runUntilAction(p, 1_000);
  assert.equal(first.action, 'connect');
  assert.ok(first.at - 1_000 >= 2_000 && first.at - 1_000 <= 5_000, `first retry after ${first.at - 1_000} ms`);

  // the attempt fails normally (the client reports status changes)
  p.onStatus('connecting', first.at + 100);
  p.onDisconnected(first.at + 500);
  const second = runUntilAction(p, first.at + 500);
  assert.equal(second.action, 'connect');
  assert.ok(second.at - (first.at + 500) >= 4_000, 'backs off');
});

test('the client is restarted only after repeated failed connects', () => {
  const p = policy();
  p.onStatus('connection_established', 0);
  let now = 0;
  p.onDisconnected(now);
  for (let i = 0; i < MAX_QUERY_ATTEMPTS; i++) {
    const step = runUntilAction(p, now);
    assert.equal(step.action, 'connect', `attempt ${i + 1}`);
    now = step.at;
    p.onStatus('connecting', now + 10);
    p.onDisconnected(now + 20);
    now += 20;
  }
  assert.equal(runUntilAction(p, now).action, 'restart');
});

test('a connect the client never reacts to means it is wedged: restart', () => {
  const p = policy();
  p.onStatus('connection_established', 0);
  p.onDisconnected(0);
  const step = runUntilAction(p, 0);
  assert.equal(step.action, 'connect');
  assert.equal(p.next(step.at + ATTEMPT_TIMEOUT_MS - 1).action, 'wait');
  assert.equal(p.next(step.at + ATTEMPT_TIMEOUT_MS).action, 'restart');
});

test('a startup connect that times out falls back to a cheap connect, not a restart', () => {
  const p = policy();
  p.onClientStarted(0);
  assert.equal(p.next(ATTEMPT_TIMEOUT_MS - 1).action, 'wait');
  assert.equal(runUntilAction(p, ATTEMPT_TIMEOUT_MS).action, 'connect');
});

test('after a kick it waits before reconnecting; a ban waits it out', () => {
  const kicked = policy();
  kicked.onStatus('connection_established', 0);
  kicked.onDisconnected(0, { kicked: true });
  assert.ok(runUntilAction(kicked, 0).at >= KICK_DELAY_MS);

  const banned = policy();
  banned.onStatus('connection_established', 0);
  banned.onDisconnected(0, { banSeconds: 120 });
  assert.ok(banned.isBanned(60_000));
  assert.ok(runUntilAction(banned, 0).at >= 120_000);

  const permanent = policy();
  permanent.onStatus('connection_established', 0);
  permanent.onDisconnected(0, { banSeconds: 0 });
  assert.ok(runUntilAction(permanent, 0).at >= BAN_DEFAULT_MS);
});

test('connecting resets the backoff and the disconnected timer', () => {
  const p = policy();
  p.onStatus('connection_established', 0);
  p.onDisconnected(1_000);
  assert.equal(p.disconnectedSince, 1_000);
  runUntilAction(p, 1_000);
  p.onStatus('connection_established', 10_000);
  assert.equal(p.connected, true);
  assert.equal(p.attempts, 0);
  assert.equal(p.disconnectedSince, null);
  assert.equal(p.next(20_000).action, 'wait');
});
