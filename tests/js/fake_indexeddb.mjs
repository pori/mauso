// Minimal in-memory stand-in for the browser's IndexedDB, just enough
// surface for app/static/crypto.js's openDB/tx/reqToPromise helpers (single
// version, no transactions spanning multiple stores, no cursors). Not a
// general IndexedDB polyfill -- scoped to what this one module needs so a
// real (if small) test can exercise the actual crypto.js file under Node's
// built-in test runner, without pulling in a new dependency.

class FakeRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.result = undefined;
    this.error = undefined;
  }
}

function schedule(req, action) {
  queueMicrotask(() => {
    try {
      req.result = action();
      if (req.onsuccess) req.onsuccess();
    } catch (e) {
      req.error = e;
      if (req.onerror) req.onerror();
    }
  });
  return req;
}

class FakeObjectStore {
  constructor(map, keyPath) {
    this.map = map;
    this.keyPath = keyPath;
  }
  get(key) {
    return schedule(new FakeRequest(), () => this.map.get(key));
  }
  put(record) {
    return schedule(new FakeRequest(), () => {
      this.map.set(record[this.keyPath], record);
      return record[this.keyPath];
    });
  }
  delete(key) {
    return schedule(new FakeRequest(), () => {
      this.map.delete(key);
    });
  }
  getAll() {
    return schedule(new FakeRequest(), () => Array.from(this.map.values()));
  }
}

// Creates one fresh, isolated fake IndexedDB "database" -- assign to
// globalThis.indexedDB before exercising crypto.js, one fresh instance per
// test so vaults don't leak between tests (mirrors tests/conftest.py's
// per-test fresh sqlite schema on the Python side).
export function makeFakeIndexedDB() {
  const stores = new Map(); // name -> { map, keyPath }
  let created = false; // onupgradeneeded only fires once, like a real first-open
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name, opts) {
      stores.set(name, { map: new Map(), keyPath: opts.keyPath });
      return null;
    },
    transaction(storeName) {
      return {
        objectStore(name) {
          const store = stores.get(name);
          return new FakeObjectStore(store.map, store.keyPath);
        },
      };
    },
  };

  return {
    open(_name, _version) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        req.result = db;
        if (!created) {
          created = true;
          if (req.onupgradeneeded) req.onupgradeneeded();
        }
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}
