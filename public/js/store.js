// Picks the backend and exposes `db` to the game.
//
// Online, each game is one Cloudflare Durable Object addressed by its game
// code, so the store can only be built once the code is known — hence
// initStore(code) rather than a module-level connection.

let db = null;
let storeBackend = null;
let storeGameCode = null;

function usingLocalStore() {
  return new URLSearchParams(location.search).has('mock');
}

function initStore(code) {
  if (db && storeGameCode === code) return Promise.resolve(db);

  storeGameCode = code;
  storeBackend = usingLocalStore()
    ? createLocalBackend()
    : createCloudflareBackend(code);

  db = createDocStore(storeBackend).db;

  if (usingLocalStore()) {
    console.info('[hide&seek] Offline store — this browser only, no server.');
  }
  return storeBackend.connect().then(() => db);
}

// The connection is the game. If it can't be established there is nothing
// useful to show, and silently dead buttons are worse than an explanation.
function storeConnectionFailed(err) {
  console.error('store connection failed', err);
  document.body.innerHTML =
    '<div style="padding:24px;font:16px/1.5 -apple-system,system-ui,sans-serif;color:#ecf0f1">' +
    '<h1 style="font-size:22px">Can\'t reach the game server</h1>' +
    '<p>Usually this means no internet, or a wifi login page waiting to be accepted.</p>' +
    '<p>Check your connection and reload.</p>' +
    '</div>';
}
