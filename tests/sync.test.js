// Cross-device sync: the decisions applyRemoteSnapshot/pushToCloud make about when to
// pull, push, or do nothing. This layer has caused real data-loss and stuck-device
// incidents, so each scenario below pins one of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadClient, flush } = require('./helpers/client');

const USER = { uid: 'u1', email: 'tester@example.com' };
const day = (iso, marker) => [`vl:day:${iso}`, JSON.stringify({ meals: [{ name: marker }] })];

function boot(localEntries, lastChangeAt) {
  const ls = Object.fromEntries(localEntries);
  if (lastChangeAt !== undefined) ls['vl:_lastChangeAt'] = String(lastChangeAt);
  const c = loadClient({ localStorage: ls });
  c.signIn(USER);
  return c;
}

test('never pushes before the first cloud snapshot has been seen', async () => {
  const c = boot([day('2026-09-30', 'local')], 500);
  // An edit right after sign-in schedules a push; fire the same code path directly.
  c.window._scheduleCloudPush();
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(c.calls.setDoc.length, 0, 'pushed blind, before knowing what the cloud holds');
});

test('brand-new account (no cloud doc): pushes local data, without the API key', async () => {
  const c = boot([day('2026-09-30', 'local'), ['vl:apikey', 'sk-secret'], ['vl:goals', '{"water":2}']], 500);
  c.userDocSnapshot(USER.uid, undefined);
  await flush();
  assert.equal(c.calls.setDoc.length, 1);
  const pushed = c.calls.setDoc[0];
  assert.equal(pushed.path, 'users/u1');
  assert.deepEqual(Object.keys(pushed.data.data).sort(), ['vl:day:2026-09-30', 'vl:goals']);
  assert.ok(!JSON.stringify(pushed.data).includes('sk-secret'), 'personal API key left the device');
  assert.equal(c.window._syncState.error, null);
});

test('cloud is newer: pulls it and adopts its timestamp', async () => {
  const c = boot([day('2026-09-30', 'local')], 500);
  c.userDocSnapshot(USER.uid, { updatedAt: 900, data: Object.fromEntries([day('2026-09-30', 'cloud')]) });
  await flush();
  assert.match(c.localStorage.getItem('vl:day:2026-09-30'), /cloud/);
  assert.equal(c.localStorage.getItem('vl:_lastChangeAt'), '900');
  assert.equal(c.calls.setDoc.length, 0);
});

test('local is newer with the same number of days: pushes', async () => {
  const c = boot([day('2026-09-30', 'local')], 900);
  c.userDocSnapshot(USER.uid, { updatedAt: 500, data: Object.fromEntries([day('2026-09-30', 'cloud')]) });
  await flush();
  assert.equal(c.calls.setDoc.length, 1);
  assert.match(c.calls.setDoc[0].data.data['vl:day:2026-09-30'], /local/);
  assert.match(c.localStorage.getItem('vl:day:2026-09-30'), /local/);
});

test('thin device with a newer timestamp pulls instead of getting stuck (sync-deadlock regression)', async () => {
  // One fresh local edit made before sign-in, against weeks of real history in the cloud.
  const c = boot([day('2026-10-01', 'local')], 9999);
  const cloud = Object.fromEntries([day('2026-09-28', 'cloud'), day('2026-09-29', 'cloud'), day('2026-09-30', 'cloud')]);
  c.userDocSnapshot(USER.uid, { updatedAt: 500, data: cloud });
  await flush();
  assert.equal(c.calls.setDoc.length, 0, 'a thin device overwrote richer cloud history');
  assert.equal(c.window._syncState.error, null, 'device left in the "Sync blocked" state');
  for (const iso of ['2026-09-28', '2026-09-29', '2026-09-30']) {
    assert.match(c.localStorage.getItem(`vl:day:${iso}`), /cloud/);
  }
});

test('push guard: refuses to overwrite the cloud with fewer days', async () => {
  const cloud = Object.fromEntries([day('2026-09-29', 'cloud'), day('2026-09-30', 'cloud')]);
  const c = boot([day('2026-09-29', 'x'), day('2026-09-30', 'x')], 100);
  c.userDocSnapshot(USER.uid, { updatedAt: 500, data: cloud });
  await flush();
  // Local loses a day after reconciling (not possible through the UI, but the guard
  // exists precisely for whatever future caller makes it possible).
  c.localStorage.removeItem('vl:day:2026-09-29');
  c.window._scheduleCloudPush();
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(c.calls.setDoc.length, 0);
  assert.match(c.window._syncState.error, /Sync blocked/);
});

test('echo of our own push is ignored', async () => {
  const c = boot([day('2026-09-30', 'local')], 500);
  c.userDocSnapshot(USER.uid, undefined);
  await flush();
  const pushed = c.calls.setDoc[0].data;
  c.localStorage.setItem('vl:day:2026-09-30', JSON.stringify({ meals: [{ name: 'edited-since' }] }));
  c.userDocSnapshot(USER.uid, pushed);
  await flush();
  assert.equal(c.calls.setDoc.length, 1, 'echo triggered another push');
  assert.match(c.localStorage.getItem('vl:day:2026-09-30'), /edited-since/, 'echo overwrote a newer local edit');
});
