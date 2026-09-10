// Dev harness: an in-memory Firestore stand-in plus simulated GPS.
//
// This exists so the game can be driven and tested before real Firebase
// credentials exist. It is NOT a backend and never runs in a real game:
// firebase-config.js only swaps it in while the config is still
// REPLACE_ME (or when ?mock=1 is passed explicitly).
//
// State is mirrored into localStorage and changes are propagated via the
// `storage` event, so several browser tabs on the same origin act as
// several players sharing one world.

(function () {
  // One localStorage key per document, not one blob for the whole database.
  // Several tabs write concurrently here, and a single blob means whoever
  // saves last silently drops everyone else's fields — which looks exactly
  // like a game bug. Per-document keys confine that to concurrent writes of
  // the same document, which real Firestore merges server-side anyway.
  const DOC_PREFIX = 'hs_mockdb::';
  const PING_KEY = 'hs_mockdb_ping';

  let store = {};            // path -> plain object
  const listeners = [];      // { path, isCollection, filters, cb }

  function loadStore() {
    const next = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(DOC_PREFIX)) continue;
        try { next[key.slice(DOC_PREFIX.length)] = JSON.parse(localStorage.getItem(key)); }
        catch (e) { /* skip a corrupt entry */ }
      }
    } catch (e) { /* storage unavailable */ }
    store = next;
  }

  function persistDoc(path) {
    try {
      if (store[path] === undefined) localStorage.removeItem(DOC_PREFIX + path);
      else localStorage.setItem(DOC_PREFIX + path, JSON.stringify(store[path]));
      localStorage.setItem(PING_KEY, String(Date.now()) + ':' + Math.random());
    } catch (e) { /* quota — harmless for a dev harness */ }
  }

  loadStore();

  window.addEventListener('storage', (e) => {
    if (!e.key) return;
    if (e.key !== PING_KEY && !e.key.startsWith(DOC_PREFIX)) return;
    loadStore();
    notifyAll();
  });

  // ---------- helpers ----------

  const stats = { writes: 0, listenerEmits: 0, docReads: 0 };

  const DELETE_SENTINEL = { __delete: true };

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function parentPath(path) { return path.split('/').slice(0, -1).join('/'); }

  function setDeep(obj, dotted, value) {
    const parts = dotted.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    if (value && value.__delete) delete cur[leaf];
    else cur[leaf] = value;
  }

  function stripSentinels(data) {
    const out = {};
    Object.entries(data).forEach(([k, v]) => {
      if (v && v.__serverTimestamp) out[k] = Date.now();
      else if (v && v.__delete) { /* omit */ }
      else out[k] = v;
    });
    return out;
  }

  function writeDoc(path, data, merge) {
    stats.writes++;
    loadStore(); // pick up other tabs' writes before doing our own
    const incoming = stripSentinels(data);
    if (merge && store[path]) store[path] = Object.assign({}, store[path], incoming);
    else store[path] = clone(incoming);
    persistDoc(path);
  }

  function updateDoc(path, data) {
    stats.writes++;
    loadStore();
    const existing = store[path];
    if (!existing) throw new Error('No document to update: ' + path);
    const next = clone(existing);
    Object.entries(data).forEach(([k, v]) => {
      const val = (v && v.__serverTimestamp) ? Date.now() : v;
      setDeep(next, k, val);
    });
    store[path] = next;
    persistDoc(path);
  }

  function deleteDoc(path) { loadStore(); delete store[path]; persistDoc(path); }

  function docsIn(collectionPath) {
    const depth = collectionPath.split('/').length + 1;
    return Object.keys(store)
      .filter((p) => p.startsWith(collectionPath + '/') && p.split('/').length === depth)
      .map((p) => makeSnap(p, store[p]));
  }

  function matches(data, filters) {
    return filters.every(([field, op, value]) => {
      const actual = field.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
      if (op === '==') return actual === value;
      if (op === '!=') return actual !== value;
      if (op === '>') return actual > value;
      if (op === '>=') return actual >= value;
      if (op === '<') return actual < value;
      if (op === '<=') return actual <= value;
      if (op === 'in') return Array.isArray(value) && value.includes(actual);
      return false;
    });
  }

  function makeSnap(path, data) {
    return {
      id: path.split('/').pop(),
      exists: data !== undefined,
      data: () => clone(data),
      ref: new DocRef(path),
    };
  }

  function makeQuerySnap(snaps) {
    return {
      empty: snaps.length === 0,
      size: snaps.length,
      docs: snaps,
      forEach: (fn) => snaps.forEach(fn),
    };
  }

  function notifyAll() {
    listeners.forEach((l) => {
      try { emit(l); } catch (e) { console.warn('mock listener error', e); }
    });
  }

  function emit(l) {
    stats.listenerEmits++;
    if (l.isCollection) {
      let snaps = docsIn(l.path);
      if (l.filters.length) snaps = snaps.filter((s) => matches(s.data(), l.filters));
      stats.docReads += snaps.length;
      l.cb(makeQuerySnap(snaps));
    } else {
      stats.docReads += store[l.path] === undefined ? 0 : 1;
      l.cb(makeSnap(l.path, store[l.path]));
    }
  }

  // ---------- refs ----------

  function DocRef(path) { this.path = path; this.id = path.split('/').pop(); }
  DocRef.prototype.collection = function (name) { return new CollectionRef(this.path + '/' + name); };
  DocRef.prototype.set = function (data, opts) {
    writeDoc(this.path, data, !!(opts && opts.merge)); notifyAll(); return Promise.resolve();
  };
  DocRef.prototype.update = function (data) {
    try { updateDoc(this.path, data); } catch (e) { return Promise.reject(e); }
    notifyAll(); return Promise.resolve();
  };
  DocRef.prototype.delete = function () { deleteDoc(this.path); notifyAll(); return Promise.resolve(); };
  DocRef.prototype.get = function () { return Promise.resolve(makeSnap(this.path, store[this.path])); };
  DocRef.prototype.onSnapshot = function (cb) {
    const l = { path: this.path, isCollection: false, filters: [], cb };
    listeners.push(l); emit(l);
    return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
  };

  function Query(path, filters) { this.path = path; this.filters = filters; }
  Query.prototype.where = function (f, op, v) { return new Query(this.path, this.filters.concat([[f, op, v]])); };
  Query.prototype.get = function () {
    const snaps = docsIn(this.path).filter((s) => matches(s.data(), this.filters));
    return Promise.resolve(makeQuerySnap(snaps));
  };
  Query.prototype.onSnapshot = function (cb) {
    const l = { path: this.path, isCollection: true, filters: this.filters, cb };
    listeners.push(l); emit(l);
    return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
  };

  function CollectionRef(path) { Query.call(this, path, []); }
  CollectionRef.prototype = Object.create(Query.prototype);
  CollectionRef.prototype.constructor = CollectionRef;
  CollectionRef.prototype.doc = function (id) {
    return new DocRef(this.path + '/' + (id || 'auto_' + Math.random().toString(36).slice(2, 10)));
  };
  CollectionRef.prototype.add = function (data) {
    const ref = this.doc();
    return ref.set(data).then(() => ref);
  };

  // ---------- db ----------

  const db = {
    collection: (name) => new CollectionRef(name),
    batch() {
      const ops = [];
      return {
        set: (ref, data, opts) => ops.push(() => writeDoc(ref.path, data, !!(opts && opts.merge))),
        update: (ref, data) => ops.push(() => updateDoc(ref.path, data)),
        delete: (ref) => ops.push(() => deleteDoc(ref.path)),
        commit: () => { ops.forEach((op) => op()); notifyAll(); return Promise.resolve(); },
      };
    },
    // Single-threaded per tab, and cross-tab races on the same doc are not a
    // realistic concern for a five-player dev harness, so this just runs the
    // body against current state.
    runTransaction(fn) {
      const tx = {
        get: (ref) => Promise.resolve(makeSnap(ref.path, store[ref.path])),
        set: (ref, data, opts) => writeDoc(ref.path, data, !!(opts && opts.merge)),
        update: (ref, data) => updateDoc(ref.path, data),
        delete: (ref) => deleteDoc(ref.path),
      };
      return Promise.resolve(fn(tx)).then((r) => { notifyAll(); return r; });
    },
  };

  // stats (declared above) is exposed so the harness can answer "how many
  // Firestore reads/writes would a real game cost", which decides whether
  // the free Spark quota survives an evening.
  window.__dbStats = stats;

  window.__mockFirebase = {
    initializeApp: () => {},
    firestore: Object.assign(() => db, {
      FieldValue: {
        serverTimestamp: () => ({ __serverTimestamp: true }),
        delete: () => DELETE_SENTINEL,
      },
    }),
    __reset: () => {
      Object.keys(store).forEach((p) => { delete store[p]; persistDoc(p); });
      notifyAll();
    },
  };

  // ---------- simulated GPS ----------
  //
  // Enabled with ?sim=<lat>,<lng>. Replaces the geolocation watch with a
  // position this tab controls, so a player can be "walked" around a map
  // from the console or from a test driver.

  const simParam = new URLSearchParams(location.search).get('sim');
  if (simParam) {
    const [lat, lng] = simParam.split(',').map(Number);
    const pos = { lat: lat || 51.5, lng: lng || -0.1 };
    const watchers = [];

    function push() {
      const payload = { coords: { latitude: pos.lat, longitude: pos.lng, accuracy: 5 }, timestamp: Date.now() };
      watchers.forEach((cb) => cb(payload));
    }

    navigator.geolocation.watchPosition = function (cb) {
      watchers.push(cb);
      setTimeout(push, 0);
      return watchers.length;
    };
    navigator.geolocation.getCurrentPosition = function (cb) {
      cb({ coords: { latitude: pos.lat, longitude: pos.lng, accuracy: 5 }, timestamp: Date.now() });
    };

    window.__sim = {
      pos,
      setPos(newLat, newLng) { pos.lat = newLat; pos.lng = newLng; push(); },
      // Move by metres east/north — convenient for driving distance-based rules.
      moveBy(eastM, northM) {
        pos.lat += northM / 111320;
        pos.lng += eastM / (111320 * Math.cos(pos.lat * Math.PI / 180));
        push();
      },
      push,
    };
    setInterval(push, 1000);
  }
})();
