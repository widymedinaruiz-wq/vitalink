// Loads the real functions/index.js with firebase-admin / firebase-functions replaced by
// in-memory fakes, so the exported Cloud Functions can be called directly as plain
// handlers. No emulator, no network, no credentials.
const Module = require('module');
const path = require('path');

// VL_FUNCTIONS_INDEX lets a deliberately broken copy be loaded to check the tests catch it.
const FUNCTIONS_INDEX = process.env.VL_FUNCTIONS_INDEX || path.join(__dirname, '..', '..', 'functions', 'index.js');

class Timestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  static now() { return new Timestamp(Date.now()); }
  static fromMillis(ms) { return new Timestamp(ms); }
  static fromDate(d) { return new Timestamp(d.getTime()); }
}
const FieldValue = {
  serverTimestamp: () => ({ __op: 'serverTimestamp' }),
  increment: (n) => ({ __op: 'increment', n }),
};

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function makeFirestore(log) {
  const docs = new Map(); // path -> plain object

  const resolve = (existing, patch) => {
    const out = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
      if (v && v.__op === 'serverTimestamp') out[k] = Timestamp.now();
      else if (v && v.__op === 'increment') out[k] = (typeof existing[k] === 'number' ? existing[k] : 0) + v.n;
      else out[k] = v;
    }
    return out;
  };
  const snapOf = (p) => ({
    id: p.split('/').pop(),
    ref: docRef(p),
    exists: docs.has(p),
    data: () => (docs.has(p) ? { ...docs.get(p) } : undefined),
  });
  const write = {
    set: (p, data, opts) => docs.set(p, resolve(opts && opts.merge && docs.has(p) ? docs.get(p) : {}, data)),
    update: (p, data) => {
      if (!docs.has(p)) throw new Error('update on missing doc ' + p);
      docs.set(p, resolve(docs.get(p), data));
    },
  };
  function docRef(p) {
    return {
      path: p,
      id: p.split('/').pop(),
      get: async () => snapOf(p),
      set: async (data, opts) => write.set(p, data, opts),
      update: async (data) => write.update(p, data),
    };
  }
  function query(name, filters, limitN) {
    return {
      where: (field, op, value) => query(name, [...filters, { field, op, value }], limitN),
      orderBy: () => query(name, filters, limitN),
      limit: (n) => query(name, filters, n),
      add: async (data) => {
        const p = `${name}/auto${docs.size + 1}`;
        write.set(p, data);
        return docRef(p);
      },
      get: async () => {
        const cmp = (a) => (a instanceof Timestamp ? a.toMillis() : a);
        let matched = [...docs.keys()]
          .filter((p) => p.startsWith(name + '/') && p.split('/').length === name.split('/').length + 1)
          .filter((p) => filters.every((f) => {
            const v = cmp(docs.get(p)[f.field]);
            if (f.op === '==') return v === cmp(f.value);
            if (f.op === '>=') return v >= cmp(f.value);
            throw new Error('fake firestore: unsupported operator ' + f.op);
          }));
        if (limitN) matched = matched.slice(0, limitN);
        const snaps = matched.map(snapOf);
        return { size: snaps.length, empty: snaps.length === 0, forEach: (fn) => snaps.forEach(fn) };
      },
    };
  }
  return {
    _docs: docs,
    _seed: (p, data) => docs.set(p, data),
    doc: docRef,
    collection: (name) => query(name, [], null),
    runTransaction: async (fn) => fn({
      get: (ref) => ref.get(),
      set: (ref, data, opts) => write.set(ref.path, data, opts),
      update: (ref, data) => write.update(ref.path, data),
    }),
    recursiveDelete: async (ref) => {
      log.push('recursiveDelete:' + ref.path);
      for (const p of [...docs.keys()]) if (p === ref.path || p.startsWith(ref.path + '/')) docs.delete(p);
    },
    batch: () => {
      const ops = [];
      return {
        delete: (ref) => ops.push(ref.path),
        commit: async () => { log.push('batchDelete:' + ops.length); ops.forEach((p) => docs.delete(p)); },
      };
    },
  };
}

/**
 * Returns the module's exports (each Cloud Function is its bare handler) plus the fake
 * Firestore, an ordered log of destructive calls, and a controllable Auth fake.
 */
function loadFunctions({ secrets = {} } = {}) {
  const log = [];
  const db = makeFirestore(log);
  const auth = {
    deleteUserError: null,
    deleteUser: async (uid) => {
      if (auth.deleteUserError) throw auth.deleteUserError;
      log.push('deleteUser:' + uid);
    },
  };
  const handlerOf = (...args) => args[args.length - 1];
  const fakes = {
    'firebase-functions/v2/https': { onCall: handlerOf, onRequest: handlerOf, HttpsError },
    'firebase-functions/v2/firestore': { onDocumentCreated: handlerOf },
    'firebase-functions/v2/scheduler': { onSchedule: handlerOf },
    'firebase-functions/v2': { setGlobalOptions: () => {} },
    'firebase-functions/params': { defineSecret: (name) => ({ value: () => secrets[name] ?? `fake-${name}` }) },
    'firebase-functions/logger': { info() {}, warn() {}, error() {} },
    'firebase-admin': { initializeApp: () => {} },
    'firebase-admin/firestore': { getFirestore: () => db, Timestamp, FieldValue },
    'firebase-admin/auth': { getAuth: () => auth },
  };

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return originalLoad.call(this, request, ...rest);
  };
  delete require.cache[require.resolve(FUNCTIONS_INDEX)];
  let fns;
  try {
    fns = require(FUNCTIONS_INDEX);
  } finally {
    Module._load = originalLoad;
  }
  return { fns, db, auth, log, Timestamp, HttpsError };
}

/** Replaces global fetch for one test; returns the list of requested URLs. */
function mockFetch(t, responder) {
  const requests = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const r = await responder(String(url), init);
    const body = r.body;
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  t.after(() => { global.fetch = original; });
  return requests;
}

/** An Anthropic Messages API response carrying `text` as its only content block. */
const anthropicText = (text) => ({ body: { content: [{ type: 'text', text }] } });

module.exports = { loadFunctions, mockFetch, anthropicText };
