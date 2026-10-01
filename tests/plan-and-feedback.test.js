// Client side of VitaLinks Plus (what the app believes its plan is) and of the
// feedback/error-report write path.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadClient, flush } = require('./helpers/client');

const USER = { uid: 'u1', email: 'tester@example.com' };
const ts = (ms) => ({ toMillis: () => ms });

function signedIn() {
  const c = loadClient();
  c.signIn(USER);
  return c;
}

test('plan: an unexpired plus billing doc unlocks Plus', () => {
  const c = signedIn();
  const expires = Date.now() + 86400000;
  c.billingSnapshot(USER.uid, { plan: 'plus', planExpiresAt: ts(expires) });
  assert.equal(c.window._planState.plan, 'plus');
  assert.equal(c.window._planState.planExpiresAt, expires);
});

test('plan: an expired plus billing doc falls back to free', () => {
  const c = signedIn();
  c.billingSnapshot(USER.uid, { plan: 'plus', planExpiresAt: ts(Date.now() - 1000) });
  assert.equal(c.window._planState.plan, 'free');
});

test('plan: no billing doc, or plus without an expiry, is free', () => {
  const c = signedIn();
  c.billingSnapshot(USER.uid, undefined);
  assert.equal(c.window._planState.plan, 'free');
  c.billingSnapshot(USER.uid, { plan: 'plus', planExpiresAt: null });
  assert.equal(c.window._planState.plan, 'free');
});

test('plan: signing out drops Plus immediately', () => {
  const c = signedIn();
  c.billingSnapshot(USER.uid, { plan: 'plus', planExpiresAt: ts(Date.now() + 86400000) });
  c.signOut();
  assert.equal(c.window._planState.plan, 'free');
});

test('feedback: nothing is written while signed out', async () => {
  const c = loadClient();
  c.signIn(null);
  const ok = await c.window.submitFeedback({ type: 'feedback', message: 'hola' });
  assert.equal(ok, false);
  assert.equal(c.calls.addDoc.length, 0);
});

test('feedback: typed feedback carries the email, automatic error reports never do', async () => {
  const c = signedIn();
  await c.window.submitFeedback({ type: 'feedback', message: 'hola' });
  await c.window.submitFeedback({ type: 'error', message: 'TypeError: x is undefined' });
  await flush();
  const [typed, auto] = c.calls.addDoc;
  assert.equal(typed.path, 'feedback');
  assert.equal(typed.data.email, USER.email);
  assert.equal(typed.data.uid, USER.uid);
  assert.equal(auto.data.email, null, 'an automatic error report included the user email');
  assert.equal(auto.data.uid, USER.uid);
});
