// Cloud Functions: account deletion, the RevenueCat entitlement webhook, and the
// feedback pipeline's cost guards. Runs the real functions/index.js against fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { loadFunctions, mockFetch, anthropicText } = require('./helpers/functions');

const fakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
};

/* ---------------- deleteAccount ---------------- */

function seedTwoUsers(db) {
  db._seed('users/u1', { data: {} });
  db._seed('users/u1/private/billing', { plan: 'plus' });
  db._seed('users/u1/healthConnect/2026-09-30', { steps: 1 });
  db._seed('feedback/f1', { uid: 'u1', message: 'mine' });
  db._seed('users/u2', { data: {} });
  db._seed('feedback/f2', { uid: 'u2', message: 'theirs' });
}

test('deleteAccount: rejects an unauthenticated call', async () => {
  const { fns, log } = loadFunctions();
  await assert.rejects(fns.deleteAccount({ auth: null }), { code: 'unauthenticated' });
  assert.deepEqual(log, []);
});

test('deleteAccount: removes only the caller\'s data, and the Auth user last', async () => {
  const { fns, db, log } = loadFunctions();
  seedTwoUsers(db);
  const result = await fns.deleteAccount({ auth: { uid: 'u1' } });
  assert.deepEqual(result, { success: true });
  assert.deepEqual([...db._docs.keys()].sort(), ['feedback/f2', 'users/u2']);
  assert.deepEqual(log, ['recursiveDelete:users/u1', 'batchDelete:1', 'deleteUser:u1']);
});

test('deleteAccount: a Firestore failure leaves the Auth user in place so the user can retry', async () => {
  const { fns, db, log } = loadFunctions();
  seedTwoUsers(db);
  db.recursiveDelete = async () => { throw new Error('firestore unavailable'); };
  await assert.rejects(fns.deleteAccount({ auth: { uid: 'u1' } }), { code: 'internal' });
  assert.ok(!log.includes('deleteUser:u1'), 'Auth user deleted while data was left behind');
});

test('deleteAccount: revokes the Sign in with Apple token first, and a failed revoke does not block deletion', async (t) => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const { fns, db, log } = loadFunctions({ secrets: { APPLE_SIGNIN_PRIVATE_KEY: pem } });
  seedTwoUsers(db);
  db._seed('users/u1/private/appleAuth', { refreshToken: 'apple-refresh-token' });
  const requests = mockFetch(t, () => {
    log.push('appleRevoke');
    return { ok: false, status: 500, body: 'nope' };
  });
  await fns.deleteAccount({ auth: { uid: 'u1' } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://appleid.apple.com/auth/revoke');
  assert.match(requests[0].init.body, /token=apple-refresh-token/);
  assert.deepEqual(log, ['appleRevoke', 'recursiveDelete:users/u1', 'batchDelete:1', 'deleteUser:u1']);
});

/* ---------------- revenueCatWebhook ---------------- */

const AUTH = 'Bearer webhook-secret';
const webhookReq = (event, authorization = AUTH) => ({ method: 'POST', headers: { authorization }, body: { event } });
const subscriber = (expires) => ({
  body: { subscriber: { entitlements: expires === undefined ? {} : { vitalinks_pro: { expires_date: expires } } } },
});
const loadWebhook = () => loadFunctions({ secrets: { REVENUECAT_WEBHOOK_AUTH: AUTH + ' \n' } });

test('webhook: a wrong Authorization header is rejected before anything is read or written', async (t) => {
  const { fns, db } = loadWebhook();
  const requests = mockFetch(t, () => subscriber('2099-01-01T00:00:00Z'));
  const res = fakeRes();
  await fns.revenueCatWebhook(webhookReq({ id: 'e1', app_user_id: 'u1' }, 'Bearer guess'), res);
  assert.equal(res.statusCode, 401);
  assert.equal(requests.length, 0);
  assert.equal(db._docs.size, 0);
});

test('webhook: an active entitlement grants plus, taken from RevenueCat rather than the event body', async (t) => {
  const { fns, db } = loadWebhook();
  mockFetch(t, () => subscriber('2099-01-01T00:00:00Z'));
  const res = fakeRes();
  // The event itself claims a cancellation; the authoritative subscriber state wins.
  await fns.revenueCatWebhook(webhookReq({ id: 'e1', app_user_id: 'u1', type: 'CANCELLATION' }), res);
  assert.equal(res.statusCode, 200);
  const billing = db._docs.get('users/u1/private/billing');
  assert.equal(billing.plan, 'plus');
  assert.equal(billing.planExpiresAt.toMillis(), Date.parse('2099-01-01T00:00:00Z'));
  assert.equal(billing.lastEventId, 'e1');
});

test('webhook: an expired or missing entitlement writes free', async (t) => {
  const { fns, db } = loadWebhook();
  let next = subscriber('2020-01-01T00:00:00Z');
  mockFetch(t, () => next);
  await fns.revenueCatWebhook(webhookReq({ id: 'e1', app_user_id: 'u1' }), fakeRes());
  assert.equal(db._docs.get('users/u1/private/billing').plan, 'free');
  next = subscriber(undefined);
  await fns.revenueCatWebhook(webhookReq({ id: 'e2', app_user_id: 'u2' }), fakeRes());
  assert.equal(db._docs.get('users/u2/private/billing').plan, 'free');
});

test('webhook: a redelivered event is acknowledged without being reprocessed', async (t) => {
  const { fns } = loadWebhook();
  const requests = mockFetch(t, () => subscriber('2099-01-01T00:00:00Z'));
  await fns.revenueCatWebhook(webhookReq({ id: 'e1', app_user_id: 'u1' }), fakeRes());
  const res = fakeRes();
  await fns.revenueCatWebhook(webhookReq({ id: 'e1', app_user_id: 'u1' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'Already processed');
  assert.equal(requests.length, 1);
});

test('webhook: a RevenueCat outage answers 500 so the event is retried, and leaves billing untouched', async (t) => {
  const { fns, db } = loadWebhook();
  db._seed('users/u1/private/billing', { plan: 'plus', lastEventId: 'e0' });
  mockFetch(t, () => ({ ok: false, status: 503, body: 'down' }));
  const res = fakeRes();
  await fns.revenueCatWebhook(webhookReq({ id: 'e1', app_user_id: 'u1' }), res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(db._docs.get('users/u1/private/billing'), { plan: 'plus', lastEventId: 'e0' });
});

/* ---------------- feedback pipeline ---------------- */

const CLASSIFIED = '{"category":"bug","priority":4,"isNoise":false,"churnRisk":true,"summary":"Falla al renderizar"}';

async function createFeedback(ctx, id, data) {
  ctx.db._seed(`feedback/${id}`, { createdAt: ctx.Timestamp.now(), ...data });
  const ref = ctx.db.doc(`feedback/${id}`);
  await ctx.fns.classifyFeedback({ params: { docId: id }, data: { ref, data: () => ({ ...ctx.db._docs.get(`feedback/${id}`) }) } });
  return ctx.db._docs.get(`feedback/${id}`);
}

test('classifyFeedback: one widespread error costs a single Claude call', async (t) => {
  const ctx = loadFunctions();
  const requests = mockFetch(t, () => anthropicText(CLASSIFIED));
  const first = await createFeedback(ctx, 'a', { type: 'error', uid: 'u1', message: "Cannot read 'x' at line 4521" });
  const second = await createFeedback(ctx, 'b', { type: 'error', uid: 'u2', message: "Cannot read 'x' at line 88" });
  const other = await createFeedback(ctx, 'c', { type: 'error', uid: 'u3', message: 'Something else entirely' });

  assert.equal(requests.length, 2, 'a repeat of the same error was sent to Claude again');
  assert.equal(first.category, 'bug');
  assert.equal(second.category, 'bug', 'repeat did not inherit the classification');
  assert.equal(second.priority, 4);
  assert.equal(second.errorSignature, first.errorSignature);
  assert.notEqual(other.errorSignature, first.errorSignature);
  assert.equal(ctx.db._docs.get(`errorSignatures/${first.errorSignature}`).count, 2);
});

test('classifyFeedback: the daily cap stops Claude calls once reached', async (t) => {
  const ctx = loadFunctions();
  const requests = mockFetch(t, () => anthropicText(CLASSIFIED));
  const today = new Date().toISOString().slice(0, 10);
  ctx.db._seed(`ops/classifyUsage-${today}`, { count: 200 });
  const doc = await createFeedback(ctx, 'a', { type: 'feedback', uid: 'u1', message: 'La app va lenta' });
  assert.equal(requests.length, 0);
  assert.equal(doc.category, undefined);
});

test('classifyFeedback: an unusable Claude answer leaves the report unclassified instead of failing', async (t) => {
  const ctx = loadFunctions();
  mockFetch(t, () => anthropicText('I am not JSON'));
  const doc = await createFeedback(ctx, 'a', { type: 'feedback', uid: 'u1', message: 'hola' });
  assert.equal(doc.category, undefined);
});

function digestFetch(t, clusterJson) {
  return mockFetch(t, (url) => {
    if (url.startsWith('https://vitalinks.eu/')) return { ok: false, status: 404, body: '' };
    return anthropicText(clusterJson);
  });
}
const latestDigest = (db) => [...db._docs.entries()].filter(([p]) => p.startsWith('feedbackDigests/')).pop()[1];

test('digest: a flood of one error becomes one prompt line, counted by distinct users', async (t) => {
  const ctx = loadFunctions();
  for (let i = 0; i < 30; i++) {
    ctx.db._seed(`feedback/e${i}`, {
      type: 'error', uid: `user${i % 3}`, message: `render failed at ${i}`, createdAt: ctx.Timestamp.now(),
      category: 'bug', priority: 4, isNoise: false,
    });
  }
  ctx.db._seed('feedback/f1', { type: 'feedback', uid: 'user9', message: 'No puedo editar comidas', createdAt: ctx.Timestamp.now(), category: 'ux-friction', priority: 2 });
  ctx.db._seed('feedback/n1', { type: 'feedback', uid: 'user9', message: 'gracias', createdAt: ctx.Timestamp.now(), isNoise: true });
  const requests = digestFetch(t, '{"headline":"Arreglar el render","issues":[{"title":"Render falla","affectedUsers":3,"maxPriority":4,"churnRisk":true,"category":"bug","itemIndexes":[0]}]}');

  await ctx.fns.feedbackDigestWeekly();

  const prompt = JSON.parse(requests[0].init.body).messages[0].content;
  const itemLines = prompt.split('\n').filter((l) => /^\[\d+\] /.test(l));
  assert.equal(itemLines.length, 2, 'error reports were not collapsed');
  assert.match(itemLines[0], /usuarios_distintos=3 reportes=30/);
  const digest = latestDigest(ctx.db);
  assert.equal(digest.totalReports, 31);
  assert.equal(digest.noiseCount, 1);
  assert.equal(digest.omittedItems, 0);
  assert.equal(digest.issues[0].title, 'Render falla');
  assert.ok(digest.issues[0].docIds.length >= 1 && digest.issues[0].docIds.every((id) => /^e\d+$/.test(id)));
});

test('digest: the prompt is capped and what was left out is recorded', async (t) => {
  const ctx = loadFunctions();
  for (let i = 0; i < 130; i++) {
    ctx.db._seed(`feedback/f${i}`, { type: 'feedback', uid: `u${i}`, message: `reporte distinto ${i}`, createdAt: ctx.Timestamp.now(), priority: 2 });
  }
  const requests = digestFetch(t, '{"headline":"x","issues":[]}');
  await ctx.fns.feedbackDigestWeekly();
  const prompt = JSON.parse(requests[0].init.body).messages[0].content;
  assert.equal(prompt.split('\n').filter((l) => /^\[\d+\] /.test(l)).length, 120);
  assert.equal(latestDigest(ctx.db).omittedItems, 10);
  assert.equal(latestDigest(ctx.db).totalReports, 130);
});

test('digest: a truncated Claude answer still produces a digest that says so', async (t) => {
  const ctx = loadFunctions();
  ctx.db._seed('feedback/f1', { type: 'feedback', uid: 'u1', message: 'algo', createdAt: ctx.Timestamp.now() });
  digestFetch(t, '{"headline":"cortado","issues":[{"title":"a"');
  await ctx.fns.feedbackDigestWeekly();
  const digest = latestDigest(ctx.db);
  assert.match(digest.headline, /No se pudo generar/);
  assert.deepEqual(digest.issues, []);
});

/* ---------------- site counter ---------------- */

const beacon = (name, { origin = 'https://vitalinks.eu', ua = 'Mozilla/5.0', method = 'POST', body } = {}) => ({
  method,
  body: body !== undefined ? body : JSON.stringify({ e: name }),
  get: (h) => ({ origin, 'user-agent': ua })[h.toLowerCase()],
});
const fakeBeaconRes = () => {
  const res = { statusCode: null, set: () => res, status: (c) => { res.statusCode = c; return res; }, end: () => res };
  return res;
};
const statsDoc = (db) => [...db._docs.entries()].filter(([p]) => p.startsWith('siteStats/')).map(([, d]) => d)[0];

test('track: counts a known event from the real site, and stores nothing but the count', async () => {
  const { fns, db } = loadFunctions();
  const res = fakeBeaconRes();
  await fns.track(beacon('view_es'), res);
  assert.equal(res.statusCode, 204);
  const doc = statsDoc(db);
  assert.equal(doc.view_es, 1);
  assert.deepEqual(Object.keys(doc).sort(), ['updatedAt', 'view_es']);
  assert.match([...db._docs.keys()][0], /^siteStats\/\d{4}-\d{2}-\d{2}$/);
});

test('track: ignores unknown events, other origins, bots, non-POST and junk bodies', async () => {
  const { fns, db } = loadFunctions();
  for (const req of [
    beacon('made_up_event'),
    beacon('view_es', { origin: 'https://evil.example' }),
    beacon('view_es', { origin: null }),
    beacon('view_es', { ua: 'Googlebot/2.1' }),
    beacon('view_es', { method: 'GET' }),
    beacon('view_es', { body: 'not json' }),
    beacon('view_es', { body: '{"e":"__proto__"}' }),
  ]) {
    const res = fakeBeaconRes();
    await fns.track(req, res);
    assert.equal(res.statusCode, 204);
  }
  assert.equal(db._docs.size, 0);
});

test('track: a burst is written at most once a second and nothing is lost', async (t) => {
  const { fns, db } = loadFunctions();
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  let writes = 0;
  const realDoc = db.doc;
  db.doc = (p) => { const ref = realDoc(p); const set = ref.set; ref.set = async (...a) => { writes++; return set(...a); }; return ref; };

  for (let i = 0; i < 50; i++) await fns.track(beacon(i % 2 ? 'try' : 'view_en'), fakeBeaconRes());
  assert.equal(writes, 1, 'a burst caused more than one write');
  now += 1500;
  await fns.track(beacon('demo'), fakeBeaconRes());
  assert.equal(writes, 2);
  const doc = statsDoc(db);
  assert.equal(doc.view_en + doc.try + doc.demo, 51, 'events were dropped');
  assert.equal(doc.view_en, 25);
  assert.equal(doc.try, 25);
});
