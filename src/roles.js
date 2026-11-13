/**
 * Who may do what. Three roles:
 *   admin    – everything
 *   listener – request and search songs, see the queue, skip or remove their own songs
 *   none     – nothing except !help and !whoami
 *
 * ADMIN_UIDS / ADMIN_GROUPS name the admins. When neither is set, everyone who may use the
 * bot is an admin, which is how Mendil behaved before roles existed.
 * ALLOWED_UIDS / ALLOWED_GROUPS name who may use the bot at all; both empty means everyone.
 * Admins are always allowed.
 */
export const ROLE_RANK = { none: 0, listener: 1, admin: 2 };

const has = (list, value) => value != null && value !== '' && list.includes(String(value));

/** Whether roleFor() needs the user's server groups to decide (so callers can skip a lookup). */
export function needsGroups(bot, uid) {
  const { adminUids = [], adminGroups = [], allowedUids = [], allowedGroups = [] } = bot;
  if (has(adminUids, uid)) return false;
  if (adminGroups.length > 0) return true;
  return allowedGroups.length > 0 && !has(allowedUids, uid);
}

/** The role of a user, from their unique ID and server group ids. `bot` is config.bot. */
export function roleFor(bot, { uid, groups = [] }) {
  const { adminUids = [], adminGroups = [], allowedUids = [], allowedGroups = [] } = bot;
  const inGroup = (list) => groups.some((g) => has(list, g));
  if (has(adminUids, uid) || inGroup(adminGroups)) return 'admin';
  const allowed = (allowedUids.length === 0 && allowedGroups.length === 0) || has(allowedUids, uid) || inGroup(allowedGroups);
  if (!allowed) return 'none';
  return adminUids.length === 0 && adminGroups.length === 0 ? 'admin' : 'listener';
}

/**
 * Whether MAX_QUEUE_PER_USER applies to `user`. Named admins are exempt; without ADMIN_*
 * everyone counts as an admin, so then the limit applies to everyone.
 */
export function queueLimitApplies(bot, user) {
  const named = (bot.adminUids?.length ?? 0) > 0 || (bot.adminGroups?.length ?? 0) > 0;
  return Boolean(user?.uid) && !(named && user.role === 'admin');
}

/** Whether `user` may skip or remove `track`: admins always, listeners only their own requests. */
export function mayManage(user, track) {
  if (user.role === 'admin') return true;
  return user.role === 'listener' && Boolean(track?.requesterUid) && track.requesterUid === user.uid;
}
