import dns from 'node:dns/promises';
import net from 'node:net';

// Addresses a chat user must not be able to make Mendil fetch: loopback, private networks,
// link-local (incl. cloud metadata at 169.254.169.254), carrier-grade NAT, multicast, reserved.
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
]) blocked.addSubnet(addr, prefix, 'ipv6');

/** True for loopback, private, link-local, multicast and other non-public addresses. */
export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family !== 6) return true; // not an address at all: refuse
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // IPv4-mapped IPv6
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(ip, 'ipv6');
}

export class BlockedUrlError extends Error {
  constructor(url) {
    super(`refusing to open an address on a private network: ${url}`);
    this.blockedUrl = true;
  }
}

const CACHE_MS = 60_000;

/**
 * Checks that URLs point to public hosts. Results are cached per host name, so the
 * entries of a playlist (usually all on one host) cost one DNS lookup.
 *
 * Residual risk: yt-dlp follows HTTP redirects and resolves names again itself, so a public
 * host that redirects to (or re-resolves to) a private address is not caught here.
 */
export class UrlGuard {
  #cache = new Map(); // host -> { ok, at }

  constructor({ allowPrivate = false, lookup = (host) => dns.lookup(host, { all: true }) } = {}) {
    this.allowPrivate = allowPrivate;
    this.lookup = lookup;
  }

  async isAllowed(url) {
    if (this.allowPrivate) return true;
    let host;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      host = u.hostname.replace(/^\[|\]$/g, ''); // [::1] -> ::1
    } catch {
      return false;
    }
    if (net.isIP(host)) return !isPrivateAddress(host);
    const cached = this.#cache.get(host);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.ok;
    let ok;
    try {
      const addresses = await this.lookup(host);
      ok = addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address));
    } catch {
      ok = true; // unresolvable: yt-dlp will fail on its own, and we leak nothing by trying
    }
    this.#cache.set(host, { ok, at: Date.now() });
    return ok;
  }

  async assertAllowed(url) {
    if (!(await this.isAllowed(url))) throw new BlockedUrlError(url);
  }
}
