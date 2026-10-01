// Sample-data mode (/app/?demo=1). The one thing it must never do is let sample data
// reach the visitor's real browser storage or a real account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadClient, flush } = require('./helpers/client');

const html = fs.readFileSync(process.env.VL_INDEX_HTML || path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

function demoBlock() {
  const begin = html.indexOf('/* ================= demo mode (begin) ================= */');
  const end = html.indexOf('/* ================= demo mode (end) ================= */');
  assert.ok(begin !== -1 && end > begin, 'demo block markers not found');
  return html.slice(begin, end);
}

/** Runs the demo block the way the page does, with a spy standing in for real storage. */
function boot(search, { native = false } = {}) {
  const realWrites = [];
  const real = {
    length: 0, key: () => null, getItem: () => null,
    setItem: (k) => realWrites.push(k), removeItem: (k) => realWrites.push(k), clear: () => realWrites.push('*'),
  };
  const window = { localStorage: real };
  if (native) window.Capacitor = { isNativePlatform: () => true };
  vm.runInNewContext(demoBlock(), { window, location: { search }, URLSearchParams, Map, Object, String, Math, Date, JSON });
  return { window, real, realWrites };
}
const dayKeys = (store) => {
  const keys = [];
  for (let i = 0; i < store.length; i++) if (store.key(i).startsWith('vl:day:')) keys.push(store.key(i));
  return keys;
};
const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

test('without ?demo the app runs on real storage, untouched', () => {
  const { window, real, realWrites } = boot('');
  assert.equal(window.__vlDemo, false);
  assert.equal(window.localStorage, real);
  assert.deepEqual(realWrites, []);
});

test('the native apps never enter the demo', () => {
  const { window, real } = boot('?demo=1', { native: true });
  assert.equal(window.__vlDemo, false);
  assert.equal(window.localStorage, real);
});

test('?demo=1 swaps storage for an in-memory one and never writes the real one', () => {
  const { window, real, realWrites } = boot('?demo=1');
  assert.equal(window.__vlDemo, true);
  assert.notEqual(window.localStorage, real);
  // What the app does next (every save goes through localStorage.setItem) lands in memory.
  window.localStorage.setItem('vl:day:2099-01-01', '{}');
  window.localStorage.removeItem('vl:goals');
  assert.deepEqual(realWrites, [], 'sample data reached real browser storage');
});

test('the sample covers the last 30 days, ending today, in the requested language', () => {
  const es = boot('?demo=1').window.localStorage;
  const keys = dayKeys(es);
  assert.equal(keys.length, 30);
  assert.ok(keys.includes(`vl:day:${todayISO()}`), 'today is missing from the sample');
  const today = JSON.parse(es.getItem(`vl:day:${todayISO()}`));
  assert.ok(today.meals.length >= 2 && today.weight > 0 && today.exercises.length === 1);
  assert.equal(JSON.parse(es.getItem('vl:lang')), 'es');

  const en = boot('?demo=1&lang=en').window.localStorage;
  assert.equal(JSON.parse(en.getItem('vl:lang')), 'en');
  const names = dayKeys(en).flatMap((k) => JSON.parse(en.getItem(k)).meals.map((m) => m.name)).join(' ');
  assert.ok(!/[áéíóúñ]/i.test(names), 'Spanish meal names in the English sample');
});

test('sample values stay in unremarkable ranges', () => {
  const store = boot('?demo=1').window.localStorage;
  for (const k of dayKeys(store)) {
    const d = JSON.parse(store.getItem(k));
    for (const r of d.bp) assert.ok(r.systolic < 120 && r.diastolic < 80, `${k}: sample blood pressure reads as elevated`);
    assert.ok(d.weight > 79 && d.weight < 84 && d.sleepHours >= 6 && d.sleepHours <= 8.5);
  }
});

test('first-run prompts are switched off in the demo', () => {
  const store = boot('?demo=1').window.localStorage;
  for (const k of ['vl:welcome-shown', 'vl:tour-nudge-shown', 'vl:_lastChangeAt']) assert.ok(store.getItem(k), `${k} not set`);
});

test('in the demo the sync layer stays signed out: no listener, no push, even for a signed-in browser', async () => {
  const c = loadClient({ demo: true, localStorage: { 'vl:day:2026-10-01': '{}', 'vl:_lastChangeAt': '999' } });
  c.signIn({ uid: 'u1', email: 'real.user@example.com' });
  await flush();
  assert.equal(c.window._syncState.user, null);
  assert.equal(c.listenerCount(), 0, 'the demo subscribed to a real account');
  c.window._scheduleCloudPush();
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(c.calls.setDoc.length, 0, 'the demo pushed to the cloud');
  assert.equal(await c.window.submitFeedback({ type: 'feedback', message: 'x' }), false);
  assert.equal(c.calls.addDoc.length, 0);
});
