// Offline backend: the whole game in localStorage, shared between tabs of
// one browser. Used by ?mock=1 and by the test suite, so a full game can be
// driven without a Worker running.
//
// Writes are applied with the same DocOps.applyOp the Durable Object uses,
// so behaviour cannot drift between the offline path and the real one.
//
// One localStorage key per document rather than a single blob: tabs write
// concurrently here, and a shared blob means whoever saves last silently
// drops everyone else's fields.
//
// Known limit: the version check below is best-effort. localStorage offers no
// atomicity across browser processes, so two tabs racing the same document can
// both believe they won. The Durable Object is genuinely serialised and does
// not have this problem — which is why the concurrency assertion in the test
// suite runs only against a real Worker.

(function (root) {
  const { applyOp } = root.DocOps;
  const DOC_PREFIX = 'hs_store::';
  const PING_KEY = 'hs_store_ping';

  function createLocalBackend() {
    let docs = {};
    let versions = {};
    let notify = () => {};

    function load() {
      const nextDocs = {};
      const nextVersions = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key || !key.startsWith(DOC_PREFIX)) continue;
          try {
            const entry = JSON.parse(localStorage.getItem(key));
            const path = key.slice(DOC_PREFIX.length);
            nextDocs[path] = entry.d;
            nextVersions[path] = entry.v;
          } catch (e) { /* skip a corrupt entry */ }
        }
      } catch (e) { /* storage unavailable */ }
      docs = nextDocs;
      versions = nextVersions;
    }

    function persist(path) {
      try {
        if (docs[path] === undefined) localStorage.removeItem(DOC_PREFIX + path);
        else localStorage.setItem(DOC_PREFIX + path, JSON.stringify({ d: docs[path], v: versions[path] }));
        localStorage.setItem(PING_KEY, String(Date.now()) + ':' + Math.random());
      } catch (e) { /* quota — harmless offline */ }
    }

    load();

    window.addEventListener('storage', (e) => {
      if (!e.key) return;
      if (e.key !== PING_KEY && !e.key.startsWith(DOC_PREFIX)) return;
      load();
      notify();
    });

    return {
      getDocs: () => docs,
      getVersion: (path) => versions[path] || 0,
      setNotifier: (fn) => { notify = fn; },
      connect: () => Promise.resolve(),

      submit(ops, expect) {
        load(); // pick up other tabs' writes before applying our own
        if (expect) {
          for (const [path, expected] of Object.entries(expect)) {
            if ((versions[path] || 0) !== expected) {
              const err = new Error('conflict');
              err.conflict = true;
              return Promise.reject(err);
            }
          }
        }

        root.__storeStats.ops += ops.length;
        root.__storeStats.messages += 1;

        const now = Date.now();
        const touched = [];
        try {
          for (const op of ops) {
            const next = applyOp(docs[op.path], op, now);
            versions[op.path] = (versions[op.path] || 0) + 1;
            if (next === null) delete docs[op.path];
            else docs[op.path] = next;
            touched.push(op.path);
          }
        } catch (e) {
          return Promise.reject(e);
        }

        touched.forEach(persist);
        notify();
        return Promise.resolve();
      },
    };
  }

  root.createLocalBackend = createLocalBackend;
})(typeof globalThis !== 'undefined' ? globalThis : self);
