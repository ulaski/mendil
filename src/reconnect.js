// Reconnect policy, kept free of I/O so it can be unit-tested with a fake clock.
//
//  - A lost connection is retried quickly (2–5 s), then with backoff 5 → 10 → 20 → 40 → 60 s.
//  - Retries are cheap ClientQuery `connect`s. The TS client is only restarted when it looks
//    wedged (a connect gets no status change at all within 30 s) or after 5 failed connects.
//  - After a kick the bot waits ~45 s; after a ban it waits out the ban (10 min if permanent).

const FIRST_DELAY_MS = [2_000, 5_000];
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
export const ATTEMPT_TIMEOUT_MS = 30_000;
export const MAX_QUERY_ATTEMPTS = 5;
export const KICK_DELAY_MS = 45_000;
export const BAN_DEFAULT_MS = 10 * 60_000;

const IN_PROGRESS = new Set(['connecting', 'connected', 'connection_establishing']);

export class ReconnectPolicy {
  connected = false;
  /** Failed ClientQuery connects since the last successful connection. */
  attempts = 0;
  nextAt = null;
  /** The attempt currently running: { kind: 'startup' | 'query' | 'restart', at, sawStatus }. */
  inFlight = null;
  blockedUntil = 0;
  blockReason = null;
  disconnectedSince = null;

  constructor({ random = Math.random } = {}) {
    this.random = random;
  }

  /** The TS client was (re)started with a ts3server:// URL, i.e. it is connecting by itself. */
  onClientStarted(now) {
    this.connected = false;
    this.disconnectedSince ??= now;
    this.inFlight = { kind: 'startup', at: now, sawStatus: false };
    this.nextAt = null;
  }

  onStatus(status, now) {
    if (status === 'connection_established') {
      this.connected = true;
      this.attempts = 0;
      this.inFlight = null;
      this.nextAt = null;
      this.blockedUntil = 0;
      this.blockReason = null;
      this.disconnectedSince = null;
    } else if (IN_PROGRESS.has(status)) {
      this.connected = false;
      if (this.inFlight) this.inFlight.sawStatus = true;
    } else if (status === 'disconnected') {
      this.onDisconnected(now);
    }
  }

  /** @param {{kicked?: boolean, banSeconds?: number|null}} info from notifyclientleftview */
  onDisconnected(now, { kicked = false, banSeconds = null } = {}) {
    this.connected = false;
    this.disconnectedSince ??= now;
    this.inFlight = null;
    if (banSeconds !== null) {
      this.blockedUntil = Math.max(this.blockedUntil, now + (banSeconds > 0 ? banSeconds * 1000 : BAN_DEFAULT_MS));
      this.blockReason = 'banned';
    } else if (kicked) {
      this.blockedUntil = Math.max(this.blockedUntil, now + KICK_DELAY_MS);
      this.blockReason = 'kicked';
    }
    this.nextAt = Math.max(now + this.#delay(), this.blockedUntil);
  }

  isBanned(now) {
    return this.blockReason === 'banned' && now < this.blockedUntil;
  }

  /** Delay until next() should be asked again (for scheduling a timer), or null. */
  dueIn(now) {
    if (this.connected) return null;
    const at = this.inFlight ? this.inFlight.at + ATTEMPT_TIMEOUT_MS : this.nextAt;
    return at === null ? null : Math.max(0, at - now);
  }

  /** @returns {{action: 'wait'} | {action: 'connect'} | {action: 'restart', reason: string}} */
  next(now) {
    if (this.connected) return { action: 'wait' };
    if (this.inFlight) {
      if (now - this.inFlight.at < ATTEMPT_TIMEOUT_MS) return { action: 'wait' };
      const { kind, sawStatus } = this.inFlight;
      this.inFlight = null;
      // A connect the client never even reacted to: it is stuck, restarting is the only cure.
      if (kind === 'query' && !sawStatus) return this.#restart('the client did not react to connect');
      this.nextAt = Math.max(now, this.blockedUntil); // other attempt kinds: just try again
    }
    if (now < this.blockedUntil) return { action: 'wait' };
    if (this.nextAt === null) this.nextAt = now + this.#delay();
    if (now < this.nextAt) return { action: 'wait' };
    if (this.attempts >= MAX_QUERY_ATTEMPTS) return this.#restart(`${this.attempts} reconnect attempts failed`);
    this.attempts++;
    this.inFlight = { kind: 'query', at: now, sawStatus: false };
    this.nextAt = null;
    return { action: 'connect' };
  }

  #restart(reason) {
    this.attempts = 0;
    this.nextAt = null;
    // onClientStarted() takes over once the client is running again
    this.inFlight = null;
    return { action: 'restart', reason };
  }

  #delay() {
    const jitter = (ms) => Math.round(ms * (0.8 + 0.4 * this.random()));
    if (this.attempts === 0) return FIRST_DELAY_MS[0] + Math.round((FIRST_DELAY_MS[1] - FIRST_DELAY_MS[0]) * this.random());
    return jitter(BACKOFF_MS[Math.min(this.attempts - 1, BACKOFF_MS.length - 1)]);
  }
}
