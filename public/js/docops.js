// How a write is applied to a document. Shared verbatim by the Durable
// Object (which is authoritative online) and the offline harness (which is
// authoritative when playing with ?mock=1), so the two can't drift apart and
// leave the offline tests passing while the real backend misbehaves.
//
// Loaded as a plain script in the browser and imported for its side effect by
// src/server.js, which then reads globalThis.DocOps.

(function (root) {
  const SERVER_TIMESTAMP = '__serverTimestamp';
  const DELETE = '__delete';

  function isSentinel(v, kind) {
    return !!(v && typeof v === 'object' && v[kind] === true);
  }

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  // Resolve write sentinels against a server-chosen `now`, so every client
  // agrees on the timestamp rather than trusting its own clock.
  function resolve(value, now) {
    return isSentinel(value, SERVER_TIMESTAMP) ? now : value;
  }

  function stripSentinels(data, now) {
    const out = {};
    Object.entries(data).forEach(([k, v]) => {
      if (isSentinel(v, DELETE)) return;
      out[k] = resolve(v, now);
    });
    return out;
  }

  // Firestore-style dotted field paths: "huntedBy.abc" writes one map key
  // without replacing the whole map.
  function setDeep(obj, dotted, value) {
    const parts = dotted.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    if (isSentinel(value, DELETE)) delete cur[leaf];
    else cur[leaf] = value;
  }

  // Applies one op to `existing` and returns the new document, or null to
  // mean "deleted". Throws only on an update to a document that isn't there,
  // matching Firestore.
  function applyOp(existing, op, now) {
    if (op.op === 'delete') return null;

    if (op.op === 'set') {
      const incoming = stripSentinels(op.data, now);
      if (op.merge && existing) return Object.assign({}, existing, incoming);
      return clone(incoming);
    }

    if (op.op === 'update') {
      if (!existing) throw new Error('No document to update: ' + op.path);
      const next = clone(existing);
      Object.entries(op.data).forEach(([k, v]) => setDeep(next, k, resolve(v, now)));
      return next;
    }

    throw new Error('Unknown op: ' + op.op);
  }

  function getField(data, field) {
    return field.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
  }

  function matches(data, filters) {
    return filters.every(([field, op, value]) => {
      const actual = getField(data, field);
      switch (op) {
        case '==': return actual === value;
        case '!=': return actual !== value;
        case '>': return actual > value;
        case '>=': return actual >= value;
        case '<': return actual < value;
        case '<=': return actual <= value;
        case 'in': return Array.isArray(value) && value.includes(actual);
        default: return false;
      }
    });
  }

  // Direct children of a collection path: "games/X/players" matches
  // "games/X/players/p1" but not "games/X/players/p1/notes/n1".
  function isChildOf(collectionPath, docPath) {
    if (!docPath.startsWith(collectionPath + '/')) return false;
    return docPath.split('/').length === collectionPath.split('/').length + 1;
  }

  root.DocOps = { applyOp, matches, isChildOf, clone, stripSentinels, setDeep, getField };
})(typeof globalThis !== 'undefined' ? globalThis : self);
