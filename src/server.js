// One Durable Object per game, holding that game's whole document tree.
//
// This replaces Firestore. The game logic still runs in each player's
// browser exactly as before — the Agent is a shared, authoritative document
// store with a push channel, which is all Firestore ever was here.
//
// Two things it does that Firestore did not:
//   - deltas, not whole-state sync, so a position update costs a few hundred
//     bytes rather than the entire game
//   - real serialisation. A Durable Object handles one message at a time, so
//     the compare-and-set below is genuinely atomic rather than hopeful.

import { Agent, routeAgentRequest } from 'agents';
import '../public/js/docops.js';

const { applyOp } = globalThis.DocOps;

export class GameAgent extends Agent {
  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS docs (
      path TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      v    INTEGER NOT NULL
    )`;
  }

  // ---------- storage ----------

  allDocs() {
    const out = {};
    for (const r of this.sql`SELECT path, json, v FROM docs`) {
      out[r.path] = { d: JSON.parse(r.json), v: r.v };
    }
    return out;
  }

  readDoc(path) {
    const rows = this.sql`SELECT json, v FROM docs WHERE path = ${path}`;
    return rows.length ? { d: JSON.parse(rows[0].json), v: rows[0].v } : null;
  }

  writeDoc(path, doc, v) {
    this.sql`INSERT INTO docs (path, json, v) VALUES (${path}, ${JSON.stringify(doc)}, ${v})
             ON CONFLICT(path) DO UPDATE SET json = excluded.json, v = excluded.v`;
  }

  removeDoc(path) {
    this.sql`DELETE FROM docs WHERE path = ${path}`;
  }

  // ---------- connections ----------

  onConnect(connection) {
    connection.send(JSON.stringify({ t: 'snapshot', docs: this.allDocs() }));
  }

  onMessage(connection, message) {
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || msg.t !== 'ops' || !Array.isArray(msg.ops)) return;

    const reply = (body) => connection.send(JSON.stringify(body));

    // A transaction names the versions of every document it read. If any of
    // them moved since, the whole batch is refused and the client retries
    // against fresh state. This is what stops two hiders' clients each
    // crediting the same second of sabotage progress.
    if (msg.expect) {
      for (const [path, expected] of Object.entries(msg.expect)) {
        const cur = this.readDoc(path);
        if ((cur ? cur.v : 0) !== expected) {
          reply({ t: 'nack', id: msg.id, reason: 'conflict' });
          return;
        }
      }
    }

    // One server clock for every write, so clients don't disagree about
    // "now" and drift the timers the game is built on.
    const now = Date.now();
    const changes = [];

    try {
      for (const op of msg.ops) {
        const cur = this.readDoc(op.path);
        const next = applyOp(cur ? cur.d : undefined, op, now);
        const v = (cur ? cur.v : 0) + 1;
        if (next === null) {
          this.removeDoc(op.path);
          changes.push({ path: op.path, d: null, v });
        } else {
          this.writeDoc(op.path, next, v);
          changes.push({ path: op.path, d: next, v });
        }
      }
    } catch (e) {
      // Applied writes stay applied, matching a partially-applied batch in
      // the old client-side code. Nothing here batches across documents in a
      // way that would leave the game inconsistent.
      reply({ t: 'nack', id: msg.id, reason: String((e && e.message) || e) });
      return;
    }

    // Everyone gets the delta, including the sender, before the sender's ack
    // — so awaiting a write guarantees your own view already reflects it.
    this.broadcast(JSON.stringify({ t: 'delta', changes }));
    reply({ t: 'ack', id: msg.id, now });
  }
}

export default {
  async fetch(request, env) {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;
    return env.ASSETS.fetch(request);
  },
};
