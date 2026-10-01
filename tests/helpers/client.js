// Loads the real <script type="module"> block from index.html (the Firebase sync layer)
// into a Node vm, with the Firebase SDK imports replaced by in-memory fakes. Nothing in
// index.html is modified or extracted into separate files for this: the tests always
// exercise exactly the code that ships.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// VL_INDEX_HTML lets a deliberately broken copy be loaded to check the tests catch it.
const INDEX_HTML = process.env.VL_INDEX_HTML || path.join(__dirname, '..', '..', 'index.html');

function readModuleScript() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const open = '<script type="module">';
  const start = html.indexOf(open);
  if (start === -1) throw new Error('index.html: <script type="module"> block not found');
  const end = html.indexOf('</script>', start);
  const body = html.slice(start + open.length, end);
  // Drop the CDN imports; the same names are provided as globals by the fakes below.
  const withoutImports = body.replace(/^\s*import\s+\{[^}]*\}\s+from\s+"[^"]+";\s*$/gm, '');
  if (/^\s*import\s/m.test(withoutImports)) throw new Error('index.html: unhandled import in module script');
  return withoutImports;
}

function makeLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _dump: () => Object.fromEntries(map),
  };
}

function fakeSnap(data) {
  return { exists: () => data !== undefined && data !== null, data: () => data };
}

/**
 * Boots the sync layer. Returns handles to drive it the way Firebase would:
 * signIn(user) fires onAuthStateChanged, and the captured onSnapshot listeners are
 * invoked directly with fake snapshots.
 */
function loadClient({ localStorage: initialLS = {}, capacitor = undefined } = {}) {
  const localStorage = makeLocalStorage(initialLS);
  const calls = { setDoc: [], addDoc: [], getDoc: [] };
  const listeners = []; // { path, onNext, onError }
  let authCallback = null;

  const window = {
    Capacitor: capacitor,
    _syncState: { ready: false, user: null, syncing: false, error: null, lastSyncAt: null },
    _planState: { plan: 'free', planExpiresAt: null },
    syncDailyReminder: () => {},
    addEventListener: () => {},
  };

  const context = {
    window,
    localStorage,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, JSON, Object, Number, String, Promise, Math,
    confirm: () => true,
    location: { href: 'http://localhost/' },
    navigator: { userAgent: 'node-test' },
    // --- classic-script globals the sync layer calls into ---
    tr: (k) => k,
    getHCMeta: () => ({ connected: false, grantedScopes: [] }),
    setHCMeta: () => {},
    // --- firebase-app / auth ---
    initializeApp: () => ({}),
    getAuth: () => ({}),
    initializeAuth: () => ({}),
    indexedDBLocalPersistence: {},
    GoogleAuthProvider: class { static credential() { return {}; } },
    OAuthProvider: class { addScope() {} credential() { return {}; } },
    signInWithPopup: async () => ({}),
    signInWithCredential: async () => ({}),
    signOut: async () => {},
    onAuthStateChanged: (_auth, cb) => { authCallback = cb; },
    // --- firestore ---
    getFirestore: () => ({}),
    doc: (_db, ...segments) => ({ path: segments.join('/') }),
    collection: (_db, ...segments) => ({ path: segments.join('/') }),
    setDoc: async (ref, data) => { calls.setDoc.push({ path: ref.path, data }); },
    addDoc: async (ref, data) => { calls.addDoc.push({ path: ref.path, data }); return { id: 'fake' }; },
    getDoc: async (ref) => { calls.getDoc.push(ref.path); return fakeSnap(undefined); },
    onSnapshot: (ref, onNext, onError) => {
      const entry = { path: ref.path, onNext, onError, active: true };
      listeners.push(entry);
      return () => { entry.active = false; };
    },
    serverTimestamp: () => ({ __serverTimestamp: true }),
    // --- functions ---
    getFunctions: () => ({}),
    httpsCallable: (_f, name) => async () => { throw new Error('callable not faked: ' + name); },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`(function(){\n${readModuleScript()}\n})();`, context, { filename: 'index.html#module' });

  if (!authCallback) throw new Error('module script never registered onAuthStateChanged');

  const activeListener = (p) => {
    const l = listeners.filter((x) => x.active && x.path === p).pop();
    if (!l) throw new Error('no active onSnapshot listener for ' + p);
    return l;
  };

  return {
    window,
    localStorage,
    calls,
    signIn: (user) => authCallback(user),
    signOut: () => authCallback(null),
    /** Deliver a users/{uid} snapshot; pass undefined for "document does not exist". */
    userDocSnapshot: (uid, docData) => activeListener(`users/${uid}`).onNext(fakeSnap(docData)),
    billingSnapshot: (uid, docData) => {
      const snap = fakeSnap(docData);
      activeListener(`users/${uid}/private/billing`).onNext(snap);
    },
  };
}

/** Lets pending promise callbacks (the async pushToCloud) run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

module.exports = { loadClient, flush };
