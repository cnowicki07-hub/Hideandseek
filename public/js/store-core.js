// The document-store API the game is written against: collections,
// documents, queries, live listeners, batches and transactions.
//
// This is deliberately Firestore-shaped. That shape was never Firebase-
// specific — it is "documents with listeners", which is what the game needs
// and what the Durable Object provides. Keeping it means the game logic in
// app.js / powers.js / world.js / hunt.js is backend-agnostic.
//
// A backend supplies four things:
//   getDocs()            -> { path: document }        current local view
//   getVersion(path)     -> number                     0 if absent
//   submit(ops, expect)  -> Promise                    apply writes
//   setNotifier(fn)      -> void                       call fn when docs change

(function (root) {
  const { matches, isChildOf, clone } = root.DocOps;

  function createDocStore(backend) {
    const listeners = [];

    function docs() { return backend.getDocs(); }

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

    function docsIn(collectionPath) {
      const all = docs();
      return Object.keys(all)
        .filter((p) => isChildOf(collectionPath, p))
        .map((p) => makeSnap(p, all[p]));
    }

    function emit(l) {
      if (l.isCollection) {
        let snaps = docsIn(l.path);
        if (l.filters.length) snaps = snaps.filter((s) => matches(s.data(), l.filters));
        l.cb(makeQuerySnap(snaps));
      } else {
        l.cb(makeSnap(l.path, docs()[l.path]));
      }
    }

    function notifyAll() {
      listeners.forEach((l) => {
        try { emit(l); } catch (e) { console.warn('store listener error', e); }
      });
    }
    backend.setNotifier(notifyAll);

    function subscribe(l) {
      listeners.push(l);
      emit(l);
      return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
    }

    // ---------- refs ----------

    function DocRef(path) { this.path = path; this.id = path.split('/').pop(); }

    DocRef.prototype.collection = function (name) {
      return new CollectionRef(this.path + '/' + name);
    };
    DocRef.prototype.set = function (data, opts) {
      return backend.submit([{ op: 'set', path: this.path, data, merge: !!(opts && opts.merge) }]);
    };
    DocRef.prototype.update = function (data) {
      return backend.submit([{ op: 'update', path: this.path, data }]);
    };
    DocRef.prototype.delete = function () {
      return backend.submit([{ op: 'delete', path: this.path }]);
    };
    DocRef.prototype.get = function () {
      return Promise.resolve(makeSnap(this.path, docs()[this.path]));
    };
    DocRef.prototype.onSnapshot = function (cb) {
      return subscribe({ path: this.path, isCollection: false, filters: [], cb });
    };

    function Query(path, filters) { this.path = path; this.filters = filters; }

    Query.prototype.where = function (field, op, value) {
      return new Query(this.path, this.filters.concat([[field, op, value]]));
    };
    Query.prototype.get = function () {
      return Promise.resolve(makeQuerySnap(
        docsIn(this.path).filter((s) => matches(s.data(), this.filters))));
    };
    Query.prototype.onSnapshot = function (cb) {
      return subscribe({ path: this.path, isCollection: true, filters: this.filters, cb });
    };

    function CollectionRef(path) { Query.call(this, path, []); }
    CollectionRef.prototype = Object.create(Query.prototype);
    CollectionRef.prototype.constructor = CollectionRef;
    CollectionRef.prototype.doc = function (id) {
      return new DocRef(this.path + '/' + (id || newDocId()));
    };
    CollectionRef.prototype.add = function (data) {
      const ref = this.doc();
      return ref.set(data).then(() => ref);
    };

    function newDocId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // ---------- db ----------

    const MAX_TXN_ATTEMPTS = 5;

    const db = {
      collection: (name) => new CollectionRef(name),

      batch() {
        const ops = [];
        return {
          set: (ref, data, opts) => ops.push({ op: 'set', path: ref.path, data, merge: !!(opts && opts.merge) }),
          update: (ref, data) => ops.push({ op: 'update', path: ref.path, data }),
          delete: (ref) => ops.push({ op: 'delete', path: ref.path }),
          commit: () => (ops.length ? backend.submit(ops) : Promise.resolve()),
        };
      },

      // Reads record the version they saw; the write is refused if any of
      // those documents moved in the meantime, and retried against fresh
      // state. That is what keeps two clients from both crediting the same
      // second of sabotage progress.
      runTransaction(fn) {
        const attempt = (n) => {
          const expect = {};
          const ops = [];
          const tx = {
            get: (ref) => {
              expect[ref.path] = backend.getVersion(ref.path);
              return Promise.resolve(makeSnap(ref.path, docs()[ref.path]));
            },
            set: (ref, data, opts) => ops.push({ op: 'set', path: ref.path, data, merge: !!(opts && opts.merge) }),
            update: (ref, data) => ops.push({ op: 'update', path: ref.path, data }),
            delete: (ref) => ops.push({ op: 'delete', path: ref.path }),
          };
          return Promise.resolve(fn(tx)).then((result) => {
            if (!ops.length) return result;
            return backend.submit(ops, expect).then(() => result).catch((e) => {
              if (e && e.conflict && n + 1 < MAX_TXN_ATTEMPTS) {
                return new Promise((r) => setTimeout(r, 20 * (n + 1))).then(() => attempt(n + 1));
              }
              throw e;
            });
          });
        };
        return attempt(0);
      },
    };

    return { db, notifyAll };
  }

  // Volume counters. On Cloudflare the old Firestore per-write quota is gone,
  // but bytes still cross a phone's mobile data, so this stays measurable.
  root.__storeStats = { ops: 0, messages: 0, bytesSent: 0, bytesReceived: 0 };

  // Write sentinels, resolved wherever the write is actually applied.
  root.FieldValue = {
    serverTimestamp: () => ({ __serverTimestamp: true }),
    delete: () => ({ __delete: true }),
  };

  root.createDocStore = createDocStore;
})(typeof globalThis !== 'undefined' ? globalThis : self);
