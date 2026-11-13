import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayManage, needsGroups, roleFor } from '../src/roles.js';

const cfg = (o = {}) => ({ allowedUids: [], allowedGroups: [], adminUids: [], adminGroups: [], ...o });

test('without ADMIN_* everyone allowed is an admin (the behaviour before roles)', () => {
  assert.equal(roleFor(cfg(), { uid: 'a' }), 'admin');
  assert.equal(roleFor(cfg({ allowedGroups: ['9'] }), { uid: 'a', groups: ['9'] }), 'admin');
  assert.equal(roleFor(cfg({ allowedGroups: ['9'] }), { uid: 'a', groups: ['8'] }), 'none');
});

test('with ADMIN_* set, the others are listeners', () => {
  const c = cfg({ adminUids: ['boss'], adminGroups: ['6'] });
  assert.equal(roleFor(c, { uid: 'boss' }), 'admin');
  assert.equal(roleFor(c, { uid: 'x', groups: ['6'] }), 'admin');
  assert.equal(roleFor(c, { uid: 'x', groups: ['8'] }), 'listener');
});

test('admins are allowed even when ALLOWED_* leaves them out', () => {
  const c = cfg({ adminUids: ['boss'], allowedUids: ['friend'] });
  assert.equal(roleFor(c, { uid: 'boss' }), 'admin');
  assert.equal(roleFor(c, { uid: 'friend' }), 'listener');
  assert.equal(roleFor(c, { uid: 'stranger' }), 'none');
});

test('server groups are only looked up when they matter', () => {
  assert.equal(needsGroups(cfg(), 'a'), false);
  assert.equal(needsGroups(cfg({ adminUids: ['a'] }), 'b'), false);
  assert.equal(needsGroups(cfg({ adminGroups: ['6'] }), 'a'), true);
  assert.equal(needsGroups(cfg({ allowedGroups: ['9'], allowedUids: ['a'] }), 'a'), false);
});

test('listeners may manage only their own requests', () => {
  const mine = { requesterUid: 'me' };
  assert.equal(mayManage({ role: 'listener', uid: 'me' }, mine), true);
  assert.equal(mayManage({ role: 'listener', uid: 'you' }, mine), false);
  assert.equal(mayManage({ role: 'listener', uid: 'me' }, { requesterUid: null }), false, 'unattributed tracks are admin-only');
  assert.equal(mayManage({ role: 'admin', uid: 'you' }, mine), true);
});
