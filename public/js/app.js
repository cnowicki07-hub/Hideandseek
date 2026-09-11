// Core engine: host/join, roles, true-position sync, the ping economy
// (nothing shows on a map until someone spends charge on it), capture,
// elimination, and the local rules tick.
//
// There is no server, so each client is responsible for enforcing rules
// against *itself* (design brief Section 1: no anti-cheat). Effects other
// players impose on you land as fields on your own player doc, which your
// client reads and obeys.

let gameCode = null;
let playerId = null;
let playerRole = null;
let map, markersLayer;
let watchId = null;
let M = 0; // sqrt(boundary area), set from game config on join
let lastRealPing = null; // { lat, lng, at } — last position actually broadcast
let gameStartAt = null;
let gameLengthMs = 0;

// Live mirrors of Firestore, kept current by the subscriptions below.
let gameState = null;
let playersState = {};
let totemsState = {};
let tripwiresState = {};
let signpostsState = {};

let myPos = null;              // latest real GPS fix for this device
let recentFixes = [];          // for movement-state detection
let tickTimer = null;

function newPlayerId() {
  const key = 'h_playerId';
  // ?pid= lets several tabs on one machine act as separate players, which is
  // how the dev harness drives a full game.
  const forced = new URLSearchParams(location.search).get('pid');
  if (forced) return forced;
  let id = sessionStorage.getItem(key) || localStorage.getItem(key);
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    localStorage.setItem(key, id);
  }
  sessionStorage.setItem(key, id);
  return id;
}

function randomCode(len, alphabet) {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// Excludes vowels and I/O/L per design doc Section 10 — reduces misreads.
const CAPTURE_ALPHABET = 'BCDFGHJKMNPQRSTVWXYZ23456789'.replace(/[O0IL1]/g, '');
function newCaptureCode() { return randomCode(4, CAPTURE_ALPHABET); }
function newGameCode() { return randomCode(5, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'); }

function gameRef() { return db.collection('games').doc(gameCode); }
function playerRef(id) { return gameRef().collection('players').doc(id || playerId); }
function me() { return playersState[playerId]; }

// ---------- Host: create game ----------

async function hostCreateGame(opts) {
  // A rematch reserves its code on the old game before switching, so the code
  // can be passed in rather than generated here.
  gameCode = opts.code || newGameCode();
  // Each game is its own Durable Object, so the store can't be opened until
  // there is a code to address.
  await initStore(gameCode);
  const boundary = opts.boundary || null;
  const areaM2 = boundary ? polygonAreaM2(boundary) : opts.areaM2;
  M = computeM(areaM2);
  const lengthMin = opts.gameLengthMin || CONFIG.gameLengthMin;

  if (opts.mode === 'livingroom') applyGameMode('livingroom');

  let headstartMs = opts.mode === 'livingroom'
    ? LIVING_ROOM.hidingSeconds * 1000
    : 0;
  if (opts.mode !== 'livingroom' && boundary && boundary.length >= 3) {
    const diag = polygonLongestDiagonalM(boundary);
    const paceMs = (CONFIG.headstart.walkingPaceKmh * 1000) / 3600000; // m per ms
    headstartMs = Math.round((CONFIG.headstart.diagonalFraction * diag) / paceMs);
  }

  await gameRef().set({
    status: 'lobby',
    mode: opts.mode || 'outdoor',
    areaM2, M,
    boundary,
    gameLengthMin: lengthMin,
    endConditionMode: opts.endConditionMode || CONFIG.endConditionMode,
    headstartMs: opts.headstartMs != null ? opts.headstartMs : headstartMs,
    createdAt: FieldValue.serverTimestamp(),
    lastCaptureAt: null, // drives the global Hunt no-capture timer
    pausedAt: null,
    pausedTotalMs: 0,
  });
  await joinGame(gameCode, currentPlayerName, true);
}

// ---------- Join ----------

async function joinGame(code, name, isHost) {
  gameCode = code.toUpperCase();
  playerId = newPlayerId();
  await initStore(gameCode);
  const gameSnap = await gameRef().get();
  if (!gameSnap.exists) { alert('Game code not found.'); return false; }
  const gameData = gameSnap.data();
  M = gameData.M;

  rememberName(name);

  const existing = await playerRef().get();
  if (existing.exists && existing.data().status === 'kicked') {
    // Rejoining with the same code is otherwise trivial, which would make the
    // kick pointless. It only holds against this browser, but that is the
    // same thing the game code is worth — enough for an uninvited stranger.
    alert('The host removed you from this game.');
    return false;
  }
  if (existing.exists) {
    // Reconnect: keep role, charge, marks, survival timer (design doc 2.2).
    await playerRef().update({ name, lastContactAt: Date.now() });
  } else {
    await playerRef().set({
      name,
      isHost: !!isHost,
      role: null, // assigned in lobby
      status: 'active',
      captureCode: newCaptureCode(),
      chargeCheckpoint: CONFIG.charge.cap,
      chargeCheckpointAt: Date.now(),
      cooldownUntil: 0,
      activePower: null,
      activePowerExpiresAt: 0,
      realLat: null, realLng: null, realUpdatedAt: null,
      pings: [],
      goQuietUntil: 0,
      decoy: null,
      lockedOutUntil: 0,
      huntedBy: {},
      activeHunt: null,
      snitchUsedAt: 0,
      outOfBoundsReadings: 0,
      breachStartedAt: 0,
      declaredHiddenAt: null,
      closedAt: 0,
      pingDebt: 0,
      nextDebtPingAt: 0,
      awayTotalMs: 0,
      survivalMs: null,
      endedAt: null,
      lastContactAt: Date.now(),
      joinedAt: Date.now(),
    });
  }

  subscribeToGame();
  subscribeToPlayers();
  subscribeToWorld();
  startTick();
  return true;
}

// ---------- Charge economy ----------

function currentCharge(p) {
  if (!p) return 0;
  const elapsedMs = Date.now() - p.chargeCheckpointAt;
  const regen = elapsedMs * CONFIG.charge.regenPerMs;
  return Math.min(CONFIG.charge.cap, p.chargeCheckpoint + regen);
}

function onCooldown(p) {
  return !!(p && p.cooldownUntil && Date.now() < p.cooldownUntil);
}

function inGrace(p) {
  return !!(p && p.graceUntil && Date.now() < p.graceUntil);
}

async function spendCharge(amount) {
  const snap = await playerRef().get();
  const p = snap.data();
  const have = currentCharge(p);
  if (have < amount) return false;
  if (onCooldown(p)) return false;
  await playerRef().update({
    chargeCheckpoint: have - amount,
    chargeCheckpointAt: Date.now(),
    cooldownUntil: Date.now() + CONFIG.charge.globalCooldownMs,
  });
  return true;
}

// ---------- Position tracking ----------

let locationState = 'unknown';   // unknown | ok | denied | unavailable

function geoErrorText(err) {
  if (!err) return 'Location unavailable.';
  if (err.code === 1) {
    return 'Location permission was refused. The game cannot work without it — ' +
      'allow location for this site in your browser settings, then tap Retry.';
  }
  if (err.code === 2) return 'Your phone could not get a fix. Step outside and try again.';
  if (err.code === 3) return 'Locating timed out. Try again with a clear view of the sky.';
  return err.message || 'Location unavailable.';
}

// Must be called from inside a tap. iOS Safari only shows the permission
// prompt in response to a user gesture, so asking for it later — from a
// websocket callback, say — silently does nothing and the game looks broken.
function requestLocation() {
  return new Promise((resolve) => {
    if (usingTravelMode()) { locationState = 'ok'; resolve({ ok: true }); return; }
    if (!navigator.geolocation) {
      locationState = 'unavailable';
      resolve({ ok: false, reason: 'This browser has no location support.' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        locationState = 'ok';
        startTracking();
        resolve({ ok: true });
      },
      (err) => {
        locationState = err && err.code === 1 ? 'denied' : 'unavailable';
        resolve({ ok: false, reason: geoErrorText(err) });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

function startTracking() {
  if (watchId) return;
  // Living-room mode has no GPS to watch — the token is driven by taps.
  if (usingTravelMode()) {
    const p = me();
    const origin = (p && p.startLat != null)
      ? { lat: p.startLat, lng: p.startLng }
      : (gameState && gameState.boundary && gameState.boundary.length >= 3
        ? polygonCentroid(gameState.boundary)
        : null);
    if (origin) { startTravel(origin); watchId = -1; }
    return;
  }
  if (!navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onPosition, (err) => {
    console.warn('geo error', err);
    if (err && err.code === 1) locationState = 'denied';
    toast(geoErrorText(err));
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 });
}

let lastPositionWrite = { lat: null, lng: null, at: 0 };
let lastContactWrite = 0;

// GPS fires far more often than the game needs. Write when the player has
// actually moved, and otherwise only often enough to keep them marked as
// in contact.
function shouldWritePosition(here, now) {
  const c = CONFIG.sync;
  if (!lastPositionWrite.at) return true;
  const since = now - lastPositionWrite.at;
  if (since >= c.keepaliveMs) return true;
  if (since < c.minWriteIntervalMs) return false;
  return distanceM(lastPositionWrite, here) >= c.movementThresholdM;
}

function onPosition(pos) {
  const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  myPos = here;
  const now = Date.now();

  recentFixes.push({ ...here, at: now });
  if (recentFixes.length > 10) recentFixes.shift();

  const p = me();
  if (!p || p.status !== 'active') return;
  if (isPaused()) return;

  // True position is synced so the physical rules (tripwires, sabotage,
  // capture range, boundary, probe geometry) have something to work with. It
  // is never displayed to anyone — only paid-for pings are.
  if (shouldWritePosition(here, now)) {
    playerRef().update({
      realLat: here.lat, realLng: here.lng, realUpdatedAt: now, lastContactAt: now,
    });
    lastPositionWrite = { lat: here.lat, lng: here.lng, at: now };
  }
}

// ---------- Pings ----------
//
// Nothing reports its position automatically. Every dot on the map was paid
// for by somebody spending charge, which makes each one worth reading.
//
// A ping is stored on the player it describes, as a short list of dots. The
// stored coordinates are already the *displayed* ones — jitter is applied
// once, here, and never recomputed. The true position stays in realLat /
// realLng and is what every physical rule uses.

// Displace a reported position by up to jitterRadiusM, uniformly over the
// disc. This is why a player who has not moved can appear to wander, and why
// the trail drawn between their dots can point somewhere they never went.
function jitterPoint(point) {
  const r = CONFIG.ping.jitterRadiusM;
  if (!r) return { lat: point.lat, lng: point.lng };
  return randomPointInRadius(point, r);
}

// `exact` skips the jitter — tripwires, totems and revealed seekers all
// report the truth.
async function emitPing(targetId, position, opts) {
  opts = opts || {};
  const target = playersState[targetId];
  if (!target || target.status !== 'active') return false;

  const now = Date.now();

  // Go Quiet eats the next ping aimed at you and is spent doing it.
  if (!opts.ignoreCounters && target.goQuietUntil && now < target.goQuietUntil) {
    await playerRef(targetId).update({ goQuietUntil: 0, activePower: null, activePowerExpiresAt: 0 });
    await pushEvent({ type: 'go_quiet_used', to: targetId });
    return false;
  }

  // A decoy takes the hit instead, so the dot lands where the decoy is.
  let point = position;
  if (!opts.ignoreCounters && target.decoy && now < target.decoy.expiresAt) {
    point = decoyPositionAt(target.decoy, now);
  }

  const shown = opts.exact ? { lat: point.lat, lng: point.lng } : jitterPoint(point);
  // A dot made while its owner's phone was closed is not where they are, it
  // is where they were when the phone went dark. Recorded on the dot so it
  // can be rung in yellow, and so it stays honest for the rest of its life.
  const stale = playerUnavailable(target, now);
  const pings = (target.pings || [])
    .concat([{ lat: shown.lat, lng: shown.lng, at: now, exact: !!opts.exact, stale }])
    .slice(-CONFIG.ping.maxStored);

  await playerRef(targetId).update({ pings });
  if (opts.notify !== false) await pushEvent({ type: 'pinged', to: targetId });
  return true;
}

// Where a decoy has walked to by `now` — it leaves from where you cast it and
// keeps going on the bearing you chose, at a walking pace, until it expires.
function decoyPositionAt(decoy, now) {
  const paceMPerMs = (CONFIG.hiderPowers.decoy.paceKmh * 1000) / 3600000;
  const travelled = ((now || Date.now()) - decoy.startedAt) * paceMPerMs;
  return destinationPoint(
    { lat: decoy.originLat, lng: decoy.originLng }, decoy.bearing, travelled);
}

function livePings(p, now) {
  now = now || Date.now();
  return (p.pings || []).filter((d) => now - d.at < CONFIG.ping.lifetimeMs);
}

// White at birth, red by the halfway mark, then fading out entirely.
function pingAppearance(dot, now) {
  const age = (now || Date.now()) - dot.at;
  const { lifetimeMs, fadeStartMs } = CONFIG.ping;
  if (age >= lifetimeMs) return null;

  if (age < fadeStartMs) {
    const t = age / fadeStartMs;            // 0 = white, 1 = red
    const g = Math.round(255 * (1 - t));
    const b = Math.round(255 * (1 - t));
    return { color: `rgb(255,${g},${b})`, opacity: 1 };
  }
  const t = (age - fadeStartMs) / (lifetimeMs - fadeStartMs);
  return { color: 'rgb(255,0,0)', opacity: 1 - t };
}

// Breaching the boundary reports you continuously until you are back inside.
let lastBreachPingAt = 0;
function tickBreachExposure(p, now) {
  if (!p.breachStartedAt || !myPos) return;
  if (now - lastBreachPingAt < CONFIG.sync.minWriteIntervalMs) return;
  lastBreachPingAt = now;
  emitPing(playerId, myPos, { ignoreCounters: true, notify: false });
}

// ---------- Capture ----------
// No target selection in the UI — capture in real life happens because
// the seeker can already see/identify the hider. The app's only job is
// to verify the 4-letter code they're handed and convert that player.

async function lookupCaptureTarget(enteredCode) {
  const snap = await gameRef().collection('players')
    .where('captureCode', '==', enteredCode.toUpperCase())
    .where('role', '==', 'hider')
    .where('status', '==', 'active')
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function confirmCapture(targetId) {
  if (isHiding()) { toast('Not yet — the hiders are still hiding.'); return { ok: false }; }
  const now = Date.now();
  const target = playersState[targetId];
  await playerRef(targetId).update({
    role: 'seeker',
    status: 'active',
    convertedAt: now,
    graceUntil: now + CONFIG.charge.conversionGraceMs,
    chargeCheckpoint: CONFIG.charge.conversionStartingCharge,
    chargeCheckpointAt: now,
    pings: [],
    survivalMs: survivalMsFor(target, now),
    // A converted hider drops every hider-side state.
    huntedBy: {},
    declaredHiddenAt: null,
    activePower: null,
    activePowerExpiresAt: 0,
    decoy: null,
    goQuietUntil: 0,
    lockedOutUntil: 0,
  });
  await clearHuntsOn(targetId);
  await gameRef().update({ lastCaptureAt: now });
  return { ok: true, name: target ? target.name : 'player' };
}

// Time spent with the phone closed does not count as surviving — you were
// not in the game, and without this a reinstated player would be credited
// for the fifteen minutes they spent greyed out.
function survivalMsFor(p, now) {
  if (!gameStartAt) return 0;
  const releasedAt = gameStartAt;
  const capped = gameLengthMs ? Math.min(now, releasedAt + gameLengthMs) : now;
  const away = (p && p.awayTotalMs) || 0;
  const closedSoFar = p && p.closedAt ? Math.max(0, now - p.closedAt) : 0;
  return Math.max(0, capped - releasedAt - away - closedSoFar);
}

// ---------- Elimination / withdrawal ----------

async function endPlayer(id, status) {
  const now = Date.now();
  const p = playersState[id];
  if (!p || p.status !== 'active') return;
  await playerRef(id).update({
    status,
    endedAt: now,
    survivalMs: survivalMsFor(p, now),
    activePower: null, activePowerExpiresAt: 0, decoy: null, huntedBy: {},
  });
  await clearHuntsOn(id);
  // Removing a hider re-arms the Hunt timer exactly as a capture does.
  if (p.role === 'hider') await gameRef().update({ lastCaptureAt: now });
}

// ---------- Host: lobby actions ----------

// The host can set one player's role directly, which is the only way to run
// a game where who seeks is not down to chance — someone new who should hide,
// someone who has seeked twice in a row.
async function setPlayerRole(id, role) {
  await playerRef(id).update({ role: role || null });
}

// Anyone who has the code is in, so a game played in public can pick up a
// stranger — it did, outdoors. The host can remove them. A kicked player is
// told what happened rather than silently losing their game, and every rule
// already keys off status === 'active', so removing them mid-game drops them
// out of pings, sabotage, hunts and scoring the same way quitting does.
async function kickPlayer(id) {
  if (id === playerId) return false;
  const target = playersState[id];
  if (!target || target.status === 'kicked') return false;

  const now = Date.now();
  await playerRef(id).update({
    status: 'kicked',
    endedAt: now,
    survivalMs: target.role === 'hider' ? survivalMsFor(target, now) : null,
    activePower: null, activePowerExpiresAt: 0, decoy: null, huntedBy: {},
  });
  await clearHuntsOn(id);
  await pushEvent({ type: 'kicked', to: id });
  return true;
}

async function assignRolesRandom(numSeekers) {
  const snap = await gameRef().collection('players').get();
  // A removed player is not in the deal.
  const ids = snap.docs.filter((d) => d.data().status !== 'kicked').map((d) => d.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const batch = db.batch();
  ids.forEach((id, i) => {
    batch.update(playerRef(id), { role: i < numSeekers ? 'seeker' : 'hider' });
  });
  await batch.commit();
}

// Starting begins the hiding phase, not the hunt. Hiders scatter; seekers are
// held until the clock runs out or every hider says they are hidden.
async function startGame() {
  const now = Date.now();
  const g = gameState || {};

  // Indoors nobody has a real position, so hand everyone a starting point.
  if (g.mode === 'livingroom' && g.boundary && g.boundary.length >= 3) {
    const starts = scatterStartPositions(g.boundary, playersState);
    const batch = db.batch();
    Object.entries(starts).forEach(([id, pos]) => {
      batch.update(playerRef(id), {
        realLat: pos.lat, realLng: pos.lng, realUpdatedAt: now, lastContactAt: now,
        startLat: pos.lat, startLng: pos.lng,
      });
    });
    await batch.commit();
  }

  await gameRef().update({
    status: 'hiding',
    startedAt: now,
    hidingEndsAt: now + (g.headstartMs || 0),
    releasedAt: null,
  });
}

async function releaseSeekers() {
  if (!gameState || gameState.status !== 'hiding') return;
  await gameRef().update({ status: 'active', releasedAt: Date.now() });
}

async function declareHidden() {
  const p = me();
  if (!p || p.role !== 'hider' || p.declaredHiddenAt) return;
  await playerRef().update({ declaredHiddenAt: Date.now() });
  toast('Marked as hidden. Sit tight.');
}

function isHiding() { return !!(gameState && gameState.status === 'hiding'); }
function isPlaying() {
  return !!(gameState && (gameState.status === 'active' || gameState.status === 'hiding'));
}

function hidersStillHiding() {
  return Object.values(playersState)
    .filter((p) => p.role === 'hider' && p.status === 'active' && !p.declaredHiddenAt);
}

// The drawn boundary is the source of truth for area, and therefore for M,
// which every distance rule scales from (design doc Section 3).
async function setBoundary(points) {
  const areaM2 = polygonAreaM2(points);
  const newM = computeM(areaM2);
  const diag = polygonLongestDiagonalM(points);
  const paceMs = (CONFIG.headstart.walkingPaceKmh * 1000) / 3600000;
  const headstartMs = Math.round((CONFIG.headstart.diagonalFraction * diag) / paceMs);
  M = newM;
  await gameRef().update({ boundary: points, areaM2, M: newM, headstartMs });
  return { areaM2, M: newM, headstartMs };
}

async function quitGame() {
  await endPlayer(playerId, 'quit');
}

// Panic is the one place game integrity is deliberately abandoned: exact
// position goes to everyone, because real-world help matters more.
async function sendPanic(message) {
  const now = Date.now();
  await pushEvent({
    type: 'panic',
    playerId,
    name: (me() || {}).name || 'Player',
    lat: myPos ? myPos.lat : null,
    lng: myPos ? myPos.lng : null,
    message: (message || '').trim() || null,
  });
  await gameRef().collection('panicEvents').add({
    playerId, name: (me() || {}).name || 'Player',
    lat: myPos ? myPos.lat : null, lng: myPos ? myPos.lng : null,
    message: (message || '').trim() || null, createdAt: now,
  });
  await endPlayer(playerId, 'panicked');
}

// ---------- Open and closed ----------
//
// A phone can stop reporting two ways: its owner closes it deliberately, or
// it locks itself in a pocket and the heartbeat simply stops. Both are the
// same thing to everyone else — the position they hold on you has gone stale
// — so both are treated the same way, and both are paid for on return.

function playerUnavailable(p, now) {
  if (!p || p.status === 'away') return true;
  if (p.closedAt) return true;
  const silent = (now || Date.now()) - (p.lastContactAt || p.joinedAt || 0);
  return silent >= CONFIG.offline.staleAfterMs;
}

function unavailableForMs(p, now) {
  now = now || Date.now();
  if (!p) return 0;
  if (p.closedAt) return now - p.closedAt;
  return now - (p.lastContactAt || p.joinedAt || now);
}

// Turn a gap in reporting into owed position reports — one per full minute,
// however the gap happened.
function debtForGap(gapMs) {
  return Math.max(0, Math.floor(gapMs / CONFIG.offline.debtPerMs));
}

// Away time only ever comes off a survival score, so the one invariant that
// matters is that it can never exceed the game so far — otherwise a phone
// that was last heard from before kick-off would wipe out a whole round.
// Capping the running total rather than each addition keeps that true however
// many times someone goes dark.
function cappedAwayTotal(p, extraMs, now) {
  const elapsed = gameStartAt ? Math.max(0, (now || Date.now()) - gameStartAt) : 0;
  return Math.min(elapsed, ((p && p.awayTotalMs) || 0) + Math.max(0, extraMs));
}

let phoneClosed = false;

// Deliberate: stop reporting, stop running the rules, and say so.
async function closePhone() {
  if (phoneClosed) return;
  phoneClosed = true;
  const now = Date.now();
  await playerRef().update({ closedAt: now });
  if (watchId && watchId !== -1 && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  stopTravel();
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  renderClosedState();
}

// Back again. The bill for the time away lands here.
async function openPhone() {
  if (!phoneClosed) return;
  phoneClosed = false;
  const now = Date.now();
  const p = me() || {};
  const gap = p.closedAt ? now - p.closedAt : 0;
  await applyAwayGap(gap, now);
  lastSeenAlive = now;
  startTracking();
  startTick();
  renderClosedState();
  return gap;
}

// Shared by the deliberate reopen and by a tab that was simply backgrounded
// long enough for its timers to stop: bank the away time, owe the reports.
async function applyAwayGap(gapMs, now) {
  now = now || Date.now();
  const p = me() || {};
  const owed = debtForGap(gapMs);
  const debt = Math.min(CONFIG.offline.maxDebt, (p.pingDebt || 0) + owed);
  // If the host already greyed them out, markAway banked this stretch — do
  // not charge them for the same silence twice.
  const banked = p.status === 'away' ? 0 : gapMs;
  await playerRef().update({
    closedAt: 0,
    awayTotalMs: cappedAwayTotal(p, banked, now),
    pingDebt: debt,
    // First repayment immediately, then one every thirty seconds.
    nextDebtPingAt: debt ? now : 0,
    lastContactAt: now,
  });
  if (owed) {
    toast(owed === 1
      ? 'Back. You owe one position report.'
      : `Back. You owe ${owed} position reports, one every 30 seconds.`);
  }
  return owed;
}

// Pays the debt down, one ordinary ping at a time. Ordinary on purpose: these
// carry the usual error, and Go quiet and Decoy can both answer them — going
// dark is a cost, not a sentence.
function tickPingDebt(p, now) {
  if (!myPos || !(p.pingDebt > 0)) return;
  if (now < (p.nextDebtPingAt || 0)) return;
  playerRef().update({
    pingDebt: p.pingDebt - 1,
    nextDebtPingAt: now + CONFIG.offline.debtPingIntervalMs,
  }).catch(() => {});
  emitPing(playerId, myPos, { notify: false });
  toast(p.pingDebt > 1
    ? `Position reported. ${p.pingDebt - 1} still owed.`
    : 'Position reported. Debt cleared.');
}

// A backgrounded tab's timers stop, so the tick itself is the detector: if it
// has not run for far longer than it should have, this phone was closed.
let lastSeenAlive = Date.now();
function noticeMissedTime(now) {
  const gap = now - lastSeenAlive;
  lastSeenAlive = now;
  if (gap < CONFIG.offline.staleAfterMs) return;
  applyAwayGap(gap, now).catch(() => {});
}

// ---------- Host: away and reinstatement ----------

// Not an elimination: a greyed-out player keeps their role, their charge and
// their place, and the host can put them back.
async function markAway(id, now) {
  const p = playersState[id];
  if (!p || p.status !== 'active') return;
  // Bank the dark stretch before freezing the clock, or the fifteen minutes
  // of silence that got them here would be scored as fifteen minutes of
  // successful hiding.
  const awayTotalMs = cappedAwayTotal(p, unavailableForMs(p, now), now);
  await playerRef(id).update({
    status: 'away',
    awayAt: now,
    awayTotalMs,
    survivalMs: survivalMsFor({ ...p, awayTotalMs, closedAt: 0 }, now),
    activePower: null, activePowerExpiresAt: 0, decoy: null,
  });
  await clearHuntsOn(id);
  await pushEvent({ type: 'went_away', name: p.name, exclude: id });
}

async function reinstatePlayer(id) {
  const p = playersState[id];
  if (!p || p.status !== 'away') return false;
  const now = Date.now();
  await playerRef(id).update({
    status: 'active',
    awayAt: null,
    // The greyed-out stretch is banked as away time so it is not scored as
    // survival, and their clock starts again from here.
    awayTotalMs: cappedAwayTotal(p, now - (p.awayAt || now), now),
    survivalMs: null,
    closedAt: 0,
    lastContactAt: now,
  });
  await pushEvent({ type: 'reinstated', to: id });
  await pushEvent({ type: 'player_reinstated', name: p.name, exclude: id });
  return true;
}

function rememberName(name) {
  try { localStorage.setItem('h_name', name); } catch (e) { /* private mode */ }
}

function rememberedName() {
  try { return localStorage.getItem('h_name') || ''; } catch (e) { return ''; }
}

// Reload into a given game. Each game is a separate Durable Object and the
// client keeps a lot of per-game state, so a reload is both the simplest and
// the most reliable way to switch — nothing can leak between rounds.
function goToGame(code) {
  const params = new URLSearchParams(location.search);
  params.set('join', code);
  location.search = params.toString();
}

function backToStart() {
  const params = new URLSearchParams(location.search);
  params.delete('join');
  location.search = params.toString();
}

// Host only: reserve the next game's code on this one so everybody can follow,
// then create it with the same settings. Reusing the boundary matters — it is
// the tedious part to redraw, and it keeps the scaling identical between
// rounds.
async function createNextGame() {
  const old = gameState || {};
  const nextCode = newGameCode();

  // Captured before the store switches. A document ref keeps its own backend,
  // so this still writes to the *old* game's Durable Object afterwards — which
  // matters, because the pointer must only appear once the new game actually
  // exists, or a quick follower would try to join nothing.
  const oldGameRef = gameRef();

  await hostCreateGame({
    code: nextCode,
    boundary: old.boundary || null,
    areaM2: old.areaM2,
    gameLengthMin: old.gameLengthMin,
    endConditionMode: old.endConditionMode,
    headstartMs: old.headstartMs,
  });

  await oldGameRef.update({ nextGameCode: nextCode });
  return nextCode;
}

async function pauseGame() { await gameRef().update({ pausedAt: Date.now() }); }

async function resumeGame() {
  const g = gameState;
  if (!g || !g.pausedAt) return;
  await gameRef().update({
    pausedAt: null,
    pausedTotalMs: (g.pausedTotalMs || 0) + (Date.now() - g.pausedAt),
  });
}

async function endGameNow() {
  const now = Date.now();
  const batch = db.batch();
  Object.entries(playersState).forEach(([id, p]) => {
    if (p.status === 'active' && p.role === 'hider') {
      batch.update(playerRef(id), { survivalMs: survivalMsFor(p, now), endedAt: now });
    }
  });
  await batch.commit();
  await gameRef().update({ status: 'ended', endedAt: now });
}

function isPaused() { return !!(gameState && gameState.pausedAt); }

function elapsedGameMs() {
  const g = gameState || {};
  if (!g.releasedAt) return 0;
  const pausedNow = g.pausedAt ? Date.now() - g.pausedAt : 0;
  return Date.now() - g.releasedAt - (g.pausedTotalMs || 0) - pausedNow;
}

// ---------- Realtime subscriptions ----------
// A throw inside a snapshot callback would otherwise take the subscription
// down with it and silently stop the client syncing, so rendering is fenced
// off from the state update.

function safely(label, fn) {
  try { fn(); } catch (e) { console.error('render failed (' + label + ')', e); }
}

function subscribeToGame() {
  gameRef().onSnapshot((snap) => {
    const g = snap.data();
    if (!g) return;
    gameState = g;
    if (g.mode) applyGameMode(g.mode);
    if (g.status === 'active' || g.status === 'hiding') {
      gameStartAt = g.startedAt;
      gameLengthMs = g.gameLengthMin * 60000;
      if (!watchId) startTracking();
    }
    safely('gameStatus', () => renderGameStatus(g));
  });
}

function subscribeToPlayers() {
  gameRef().collection('players').onSnapshot((snap) => {
    const players = {};
    snap.forEach((doc) => { players[doc.id] = doc.data(); });
    playersState = players;
    // Driven off the document rather than the event, so being kicked lands
    // even if the event was missed — a reconnect, a backgrounded tab.
    const mine = players[playerId];
    if (mine && mine.status === 'kicked') { safely('kicked', handleBeingKicked); return; }
    safely('players', () => renderPlayers(players));
  });
}

function subscribeToWorld() {
  gameRef().collection('totems').onSnapshot((snap) => {
    const t = {};
    snap.forEach((d) => { t[d.id] = d.data(); });
    totemsState = t;
    safely('world', renderWorld);
  });
  gameRef().collection('tripwires').onSnapshot((snap) => {
    const t = {};
    snap.forEach((d) => { t[d.id] = d.data(); });
    tripwiresState = t;
    safely('world', renderWorld);
  });
  gameRef().collection('signposts').onSnapshot((snap) => {
    const s = {};
    snap.forEach((d) => { s[d.id] = d.data(); });
    signpostsState = s;
    safely('world', renderWorld);
  });
  gameRef().collection('events').onSnapshot((snap) => {
    const evts = [];
    snap.forEach((d) => evts.push({ id: d.id, ...d.data() }));
    handleEvents(evts);
  });
}

// ---------- Events ----------
// Firestore stands in for a push channel: an event addressed to a player is
// picked up by that player's client, shown once, then marked seen.

async function pushEvent(evt) {
  await gameRef().collection('events').add({ createdAt: Date.now(), seenBy: {}, ...evt });
}

const handledEvents = new Set();

function handleEvents(evts) {
  const now = Date.now();
  evts.forEach((e) => {
    if (handledEvents.has(e.id)) return;
    if (e.to && e.to !== playerId) return;
    if (e.exclude === playerId) return;
    // Ignore anything from before this client joined, so a reconnect doesn't
    // replay the whole game's alerts.
    if (e.createdAt && now - e.createdAt > 120000) { handledEvents.add(e.id); return; }
    handledEvents.add(e.id);
    onGameEvent(e);
  });
}

// ---------- Local rules tick ----------
// The client-side stand-in for design doc Section 17's server tick.

function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(tick, CONFIG.tickMs);
}

// Used when a player is removed from a game: without this the client keeps
// running the rules and writing positions into a game it is no longer in.
function stopPlaying() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (watchId && watchId !== -1 && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
  stopTravel();
}

function tick() {
  const p = me();
  if (!p) return;
  const now = Date.now();
  noticeMissedTime(now);

  // Contact heartbeat, for when GPS is unavailable and no position write is
  // happening. A position write already refreshes lastContactAt.
  if (p.status === 'active' &&
      now - Math.max(lastPositionWrite.at, lastContactWrite) >= CONFIG.sync.tickKeepaliveMs) {
    lastContactWrite = now;
    playerRef().update({ lastContactAt: now }).catch(() => {});
  }
  if (!isPlaying() || isPaused()) { refreshHud(); return; }
  if (p.status !== 'active') { refreshHud(); return; }

  expireActivePower(p, now);

  if (playerRole === 'hider' && myPos) {
    tickBoundary(p, now);
    tickTripwires(p, now);
    tickTotems(p, now);
    tickBreachExposure(p, now);
  }
  // Both roles can leave and read signs, so both roles discover them.
  if (myPos) tickSignpostDiscovery();
  tickPingDebt(p, now);
  tickHunt(p, now);
  if (p.isHost) tickHostChecks(now);

  refreshHud();
  renderWorld();
}

function expireActivePower(p, now) {
  if (p.activePower && p.activePowerExpiresAt && now >= p.activePowerExpiresAt) {
    playerRef().update({ activePower: null, activePowerExpiresAt: 0 }).catch(() => {});
  }
  if (p.decoy && now >= p.decoy.expiresAt) {
    playerRef().update({ decoy: null }).catch(() => {});
  }
}

// A hider's own client trips any tripwire it walks into (design doc 5.3).
function tickTripwires(p, now) {
  const radius = CONFIG.seekerPowers.tripwire.triggerRadiusM;
  Object.entries(tripwiresState).forEach(([id, tw]) => {
    if (tw.triggered) return;
    if (distanceM(myPos, { lat: tw.lat, lng: tw.lng }) > radius) return;
    gameRef().collection('tripwires').doc(id).update({
      triggered: true, triggeredAt: now,
      triggerLat: myPos.lat, triggerLng: myPos.lng,
    });
    // Exact, and it defeats Go Quiet and Decoy — you physically walked into it.
    emitPing(playerId, myPos, { exact: true, ignoreCounters: true, notify: false });
    pushEvent({ type: 'tripwire', to: tw.placedBy });
    toast('You tripped a tripwire.');
  });
}

function tickBoundary(p, now) {
  const boundary = gameState.boundary;
  if (!boundary || boundary.length < 3) return;

  const inside = pointInPolygon(myPos, boundary);
  const edgeDist = distanceToPolygonEdgeM(myPos, boundary);

  if (inside) {
    setBoundaryWarning(edgeDist <= CONFIG.boundary.warningZoneM ? edgeDist : null);
    if (p.outOfBoundsReadings || p.breachStartedAt) {
      playerRef().update({ outOfBoundsReadings: 0, breachStartedAt: 0 });
      if (p.breachStartedAt) toast('Back inside the boundary — countdown cancelled.');
    }
    return;
  }

  setBoundaryWarning(null);
  // Confirm with consecutive readings rather than a single jittery fix.
  const readings = (p.outOfBoundsReadings || 0) + 1;
  if (readings < CONFIG.boundary.confirmReadings) {
    playerRef().update({ outOfBoundsReadings: readings });
    return;
  }
  if (!p.breachStartedAt) {
    playerRef().update({ outOfBoundsReadings: readings, breachStartedAt: now });
    toast('Outside the boundary — return before the countdown ends.');
    return;
  }
  if (now - p.breachStartedAt >= CONFIG.boundary.breachTimerMs) {
    endPlayer(playerId, 'boundary_eliminated');
    toast('Eliminated: out of bounds.');
  }
}

function tickHostChecks(now) {
  // Release the seekers as soon as every hider says they're hidden, or when
  // the hiding clock runs out — whichever comes first.
  if (isHiding()) {
    const hiders = Object.values(playersState)
      .filter((p) => p.role === 'hider' && p.status === 'active');
    const allHidden = hiders.length > 0 && hiders.every((p) => p.declaredHiddenAt);
    if (allHidden || now >= (gameState.hidingEndsAt || 0)) releaseSeekers();
    return;
  }

  // Offline flag / auto-elimination, and the end condition. Run by the host's
  // client only, so these fire once rather than once per player.
  // Long enough unavailable and they are greyed out — not eliminated. The
  // host can put them back, which is why this is a status and not an ending.
  Object.entries(playersState).forEach(([id, p]) => {
    if (p.status !== 'active') return;
    if (unavailableForMs(p, now) >= CONFIG.offline.awayAfterMs) markAway(id, now);
  });

  const hidersLeft = Object.values(playersState)
    .filter((p) => p.role === 'hider' && p.status === 'active').length;
  const mode = gameState.endConditionMode || CONFIG.endConditionMode;
  const timeUp = gameLengthMs && elapsedGameMs() >= gameLengthMs;

  if ((mode === 'elimination' && hidersLeft === 0 && anyHiderEverAssigned()) ||
      (mode === 'time_limit' && timeUp) ||
      (mode === 'elimination' && timeUp)) {
    endGameNow();
  }
}

function anyHiderEverAssigned() {
  return Object.values(playersState).some((p) => p.role === 'hider' || p.convertedAt);
}

function offlineFlagged(p, now) {
  return playerUnavailable(p, now);
}
