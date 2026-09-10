// Cloudflare backend: talks to one GameAgent Durable Object over a WebSocket.
//
// The Agent is authoritative. A write is sent, applied there, broadcast to
// everyone as a delta, and only then acknowledged — so `await ref.update(...)`
// resolves with this client's own view already up to date, which is what the
// game logic assumes.

(function (root) {
  function createCloudflareBackend(gameCode, opts) {
    const docs = {};        // path -> document
    const versions = {};    // path -> version
    const pending = new Map();
    let notify = () => {};
    let nextId = 1;
    let ready = null;
    let socket = null;

    const options = opts || {};

    function applyChanges(changes) {
      changes.forEach((c) => {
        if (c.d === null) { delete docs[c.path]; delete versions[c.path]; }
        else { docs[c.path] = c.d; versions[c.path] = c.v; }
      });
    }

    function onServerMessage(raw) {
      root.__storeStats.bytesReceived += (raw && raw.length) || 0;
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }

      // The Agents SDK sends its own protocol messages (identity, state) that
      // this store doesn't use.
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'snapshot') {
        Object.keys(docs).forEach((k) => delete docs[k]);
        Object.keys(versions).forEach((k) => delete versions[k]);
        Object.entries(msg.docs).forEach(([path, entry]) => {
          docs[path] = entry.d;
          versions[path] = entry.v;
        });
        gotSnapshot = true;
        if (resolveReady) resolveReady();
        notify();
        return;
      }

      if (msg.t === 'delta') {
        applyChanges(msg.changes);
        notify();
        return;
      }

      if (msg.t === 'ack' || msg.t === 'nack') {
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        if (msg.t === 'ack') waiter.resolve();
        else {
          const err = new Error(msg.reason || 'write rejected');
          // Flagged so runTransaction knows this is worth retrying.
          err.conflict = msg.reason === 'conflict';
          waiter.reject(err);
        }
      }
    }

    let resolveReady = null;
    let gotSnapshot = false;

    function connect() {
      if (ready) return ready;
      // Resolves on the first snapshot, not merely on the socket opening:
      // joining reads the game document immediately, so an empty local view
      // at that moment would look like "game code not found".
      ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        socket = new AgentsClient.AgentClient({
          agent: 'game-agent',
          name: gameCode,
          host: options.host || location.host,
        });
        socket.addEventListener('message', (event) => onServerMessage(event.data));
        socket.addEventListener('error', () => {
          if (!gotSnapshot) reject(new Error('could not reach the game server'));
        });
        setTimeout(() => {
          if (!gotSnapshot) reject(new Error('timed out reaching the game server'));
        }, 15000);
      });
      return ready;
    }

    return {
      getDocs: () => docs,
      getVersion: (path) => versions[path] || 0,
      setNotifier: (fn) => { notify = fn; },
      connect,

      submit(ops, expect) {
        return connect().then(() => new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          const frame = JSON.stringify({ t: 'ops', id, ops, expect: expect || null });
          root.__storeStats.ops += ops.length;
          root.__storeStats.messages += 1;
          root.__storeStats.bytesSent += frame.length;
          socket.send(frame);
          setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            reject(new Error('write timed out'));
          }, 15000);
        }));
      },
    };
  }

  root.createCloudflareBackend = createCloudflareBackend;
})(typeof globalThis !== 'undefined' ? globalThis : self);
