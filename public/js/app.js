// Core engine: host/join, roles, position sync with phase-based ping
// cadence and uncertainty growth, charge economy, capture, elimination,
// and the local rules tick.
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
let cordonsState = {};
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
      pendingPingMod: null,
      realLat: null, realLng: null, realUpdatedAt: null,
      broadcastLat: null, broadcastLng: null,
      broadcastRadiusM: CONFIG.baseAccuracyRadiusM,
      broadcastAt: null,
      broadcastMode: 'circle',
      broadcastArc: null,
      pingHistory: [],
      falseTrailUntil: 0, falseTrailBearing: null,
      silentRunUntil: 0,
      decoy: null,
      darkUntil: 0,
      forcedBroadcastUntil: 0,
      lockedOutUntil: 0,
      beaconedUntil: 0,
      undeployedTotems: 0,
      huntedBy: {},
      activeHunt: null,
      snitchUsedAt: 0,
      outOfBoundsReadings: 0,
      breachStartedAt: 0,
      declaredHiddenAt: null,
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

  if (shouldWritePosition(here, now)) {
    const update = { realLat: here.lat, realLng: here.lng, realUpdatedAt: now, lastContactAt: now };
    // A seeker's broadcast rides along in the same write rather than costing
    // a second one.
    if (playerRole === 'seeker') Object.assign(update, seekerBroadcastFields(here, now, p));
    playerRef().update(update);
    lastPositionWrite = { lat: here.lat, lng: here.lng, at: now };
  }

  if (playerRole === 'hider' && isPlaying()) maybeSendHiderPing(here, now, p);
}

// Seekers broadcast continuously at full accuracy, unless Go Dark is active
// (and Uncloak can force them back — design doc 5.1/5.3).
function seekerBroadcastFields(here, now, p) {
  if (isSeekerDark(p, now)) {
    if (p.broadcastLat === null) return {};
    return { broadcastLat: null, broadcastLng: null, broadcastAt: now };
  }
  return {
    broadcastLat: here.lat, broadcastLng: here.lng,
    broadcastRadiusM: 0, broadcastAt: now, broadcastMode: 'circle',
  };
}

function updateSeekerBroadcast(here, now, p) {
  const fields = seekerBroadcastFields(here, now, p);
  if (!Object.keys(fields).length) return;
  playerRef().update(fields);
}

function isSeekerDark(p, now) {
  now = now || Date.now();
  if (!p) return false;
  if (p.forcedBroadcastUntil && now < p.forcedBroadcastUntil) return false;
  return !!(p.darkUntil && now < p.darkUntil);
}

// Movement state + phase-based ping cadence, per design doc Section 4.
let nextPingDueAt = 0;

function currentPhase() {
  if (!gameStartAt || !gameLengthMs) return 1;
  const elapsedPct = (elapsedGameMs() / gameLengthMs) * 100;
  if (elapsedPct < CONFIG.ping.phase1EndPct) return 1;
  if (elapsedPct < CONFIG.ping.phase2EndPct) return 2;
  return 3;
}

function pingInterval(phase, moving) {
  const c = CONFIG.ping;
  if (phase === 1) return moving ? c.phase1MovingMs : c.phase1StationaryMs;
  if (phase === 2) return moving ? c.phase2MovingMs : c.phase2StationaryMs;
  return moving ? c.phase3MovingMs : c.phase3StationaryMs;
}

function isMovingNow() {
  if (recentFixes.length < 2) return false;
  const a = recentFixes[0];
  const b = recentFixes[recentFixes.length - 1];
  const dtMin = (b.at - a.at) / 60000;
  if (dtMin <= 0) return false;
  return distanceM(a, b) / dtMin > CONFIG.ping.movingThresholdMPerMin;
}

function maybeSendHiderPing(here, now, p) {
  // A hider inside an active cordon pings continuously — that is the cordon's
  // penalty for being caught inside it (design doc 5.3).
  if (isInsideActiveCordon(here, now)) {
    sendHiderPing(here, now, p, { forceExact: true });
    nextPingDueAt = now + CONFIG.sync.minWriteIntervalMs;
    return;
  }
  // Boundary breach forces full exposure for the countdown (design doc 11).
  if (p.breachStartedAt) {
    sendHiderPing(here, now, p, { forceExact: true });
    nextPingDueAt = now + CONFIG.sync.minWriteIntervalMs;
    return;
  }
  // A beaconed hider is lit up continuously at exact position.
  if (p.beaconedUntil && now < p.beaconedUntil) {
    sendHiderPing(here, now, p, { forceExact: true });
    nextPingDueAt = now + CONFIG.sync.minWriteIntervalMs;
    return;
  }

  if (!lastRealPing) {
    sendHiderPing(here, now, p);
    return;
  }
  if (now < nextPingDueAt) return;
  sendHiderPing(here, now, p);
}

// The single interception point for every power that changes what a hider
// broadcasts: Go Quiet, Smear, Decoy, Silent Run.
function sendHiderPing(here, now, p, opts) {
  opts = opts || {};
  // Silent Run keeps the stationary cadence even while moving.
  const silentRun = !!(p.silentRunUntil && now < p.silentRunUntil);
  const moving = opts.forceExact ? true : (isMovingNow() && !silentRun);
  const phase = currentPhase();
  const scheduleNext = () => { nextPingDueAt = now + pingInterval(phase, moving); };

  if (!opts.forceExact && p.pendingPingMod === 'go_quiet') {
    // Skip this ping entirely. broadcastAt is deliberately left stale so the
    // seeker's circle keeps growing — indistinguishable from signal loss.
    playerRef().update({ pendingPingMod: null, activePower: null });
    scheduleNext();
    return;
  }

  const history = (p.pingHistory || []).concat([{ lat: here.lat, lng: here.lng, at: now }])
    .slice(-CONFIG.ping.historyLength);

  const update = {
    broadcastAt: now,
    broadcastRadiusM: CONFIG.baseAccuracyRadiusM,
    pingHistory: history,
  };

  const decoyActive = !opts.forceExact && p.decoy && now < p.decoy.expiresAt;

  if (!opts.forceExact && p.pendingPingMod === 'smear') {
    // Report a wide directional arc instead of a circle, for this ping only.
    const bearing = travelBearing(p) != null ? travelBearing(p) : Math.random() * 360;
    update.broadcastMode = 'arc';
    update.broadcastLat = here.lat;
    update.broadcastLng = here.lng;
    update.broadcastArc = {
      bearing,
      halfWidthDeg: CONFIG.hiderPowers.smear.arcHalfWidthDeg,
      radiusM: Math.max(CONFIG.baseAccuracyRadiusM * 8, 0.06 * M),
    };
    update.pendingPingMod = null;
    update.activePower = null;
  } else if (decoyActive) {
    // Fake marker walks the chosen bearing at a plausible pace; the real
    // position is not broadcast at all while the decoy runs.
    const paceMPerMs = (CONFIG.hiderPowers.decoy.paceKmh * 1000) / 3600000;
    const travelled = (now - p.decoy.startedAt) * paceMPerMs;
    const fake = destinationPoint({ lat: p.decoy.originLat, lng: p.decoy.originLng }, p.decoy.bearing, travelled);
    update.broadcastMode = 'circle';
    update.broadcastLat = fake.lat;
    update.broadcastLng = fake.lng;
  } else {
    update.broadcastMode = 'circle';
    update.broadcastLat = here.lat;
    update.broadcastLng = here.lng;
  }

  playerRef().update(update);
  lastRealPing = { ...here, at: now };
  scheduleNext();
}

// Direction of travel from the last two real pings, or null if unknown.
// False Trail replaces this for Backtrace purposes only.
function travelBearing(p) {
  const h = p.pingHistory || [];
  if (h.length < 2) return null;
  return bearingDeg(h[h.length - 2], h[h.length - 1]);
}

function backtraceBearing(p, now) {
  now = now || Date.now();
  if (p.falseTrailUntil && now < p.falseTrailUntil && p.falseTrailBearing != null) {
    return p.falseTrailBearing;
  }
  return travelBearing(p);
}

// The radius a hider's circle should be *drawn* at right now: base accuracy
// plus growth since the last ping, capped at 0.5M (design doc Section 4).
// Growth happens at render time, not at ping time — that is what makes
// staying still expensive and Go Quiet indistinguishable from signal loss.
function displayRadiusM(p, now) {
  now = now || Date.now();
  if (!p.broadcastAt) return CONFIG.baseAccuracyRadiusM;
  const phase = currentPhase();
  const rate = phase === 3 ? CONFIG.ping.growthRateMPerMinPhase3 : CONFIG.ping.growthRateMPerMinPhase12;
  const mins = (now - p.broadcastAt) / 60000;
  const cap = CONFIG.ping.uncertaintyCapFraction * M;
  return Math.min(cap, (p.broadcastRadiusM || CONFIG.baseAccuracyRadiusM) + rate * mins);
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
    broadcastRadiusM: 0,
    broadcastMode: 'circle',
    survivalMs: survivalMsFor(target, now),
    // A converted hider drops every hider-side state.
    huntedBy: {},
    declaredHiddenAt: null,
    activePower: null,
    activePowerExpiresAt: 0,
    pendingPingMod: null,
    decoy: null,
    beaconedUntil: 0,
    lockedOutUntil: 0,
    silentRunUntil: 0,
    undeployedTotems: 0,
  });
  await clearHuntsOn(targetId);
  await gameRef().update({ lastCaptureAt: now });
  return { ok: true, name: target ? target.name : 'player' };
}

function survivalMsFor(p, now) {
  if (!gameStartAt) return 0;
  const releasedAt = gameStartAt;
  const capped = gameLengthMs ? Math.min(now, releasedAt + gameLengthMs) : now;
  return Math.max(0, capped - releasedAt);
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
    broadcastLat: null, broadcastLng: null, broadcastAt: null,
    activePower: null, activePowerExpiresAt: 0, decoy: null, huntedBy: {},
  });
  await clearHuntsOn(id);
  // Removing a hider re-arms the Hunt timer exactly as a capture does.
  if (p.role === 'hider') await gameRef().update({ lastCaptureAt: now });
}

// ---------- Host: lobby actions ----------

async function assignRolesRandom(numSeekers) {
  const snap = await gameRef().collection('players').get();
  const ids = snap.docs.map((d) => d.id);
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
  gameRef().collection('cordons').onSnapshot((snap) => {
    const c = {};
    snap.forEach((d) => { c[d.id] = d.data(); });
    cordonsState = c;
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

function tick() {
  const p = me();
  if (!p) return;
  const now = Date.now();

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
    tickBeaconContagion(p, now);
    tickTripwires(p, now);
    tickTotems(p, now);
    maybeSendHiderPing(myPos, now, p);
  }
  if (playerRole === 'seeker' && myPos) {
    // Only correct a mismatch — Go Dark starting or lapsing. Steady-state
    // broadcasting rides on the position write.
    const shouldBeDark = isSeekerDark(p, now);
    const isBroadcasting = p.broadcastLat !== null;
    if (shouldBeDark === isBroadcasting) {
      updateSeekerBroadcast(myPos, now, p);
      lastPositionWrite = { lat: myPos.lat, lng: myPos.lng, at: now };
    }
  }

  tickHunt(p, now);
  if (p.isHost) tickHostChecks(now);

  refreshHud();
  renderWorld();
}

function expireActivePower(p, now) {
  if (p.activePower && p.activePowerExpiresAt && now >= p.activePowerExpiresAt && !p.pendingPingMod) {
    playerRef().update({ activePower: null, activePowerExpiresAt: 0 }).catch(() => {});
  }
  if (p.decoy && now >= p.decoy.expiresAt) {
    playerRef().update({ decoy: null }).catch(() => {});
  }
}

// A beaconed hider spreads the beacon to any hider coming within 30m
// (design doc 5.3). Each hider's own client applies this to itself.
function tickBeaconContagion(p, now) {
  if (p.beaconedUntil && now < p.beaconedUntil) return;
  const radius = CONFIG.seekerPowers.beacon.radiusM;
  for (const [id, other] of Object.entries(playersState)) {
    if (id === playerId || other.role !== 'hider' || other.status !== 'active') continue;
    if (!(other.beaconedUntil && now < other.beaconedUntil)) continue;
    if (!other.realLat) continue;
    if (distanceM(myPos, { lat: other.realLat, lng: other.realLng }) <= radius) {
      playerRef().update({ beaconedUntil: other.beaconedUntil }).catch(() => {});
      toast('You have been lit up by a nearby beacon.');
      return;
    }
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
    pushEvent({
      type: 'tripwire',
      to: tw.placedBy,
      lat: myPos.lat, lng: myPos.lng,
    });
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
  Object.entries(playersState).forEach(([id, p]) => {
    if (p.status !== 'active') return;
    const silentMs = now - (p.lastContactAt || p.joinedAt || now);
    if (silentMs >= CONFIG.offline.eliminateAfterMs) endPlayer(id, 'offline_eliminated');
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
  const silentMs = (now || Date.now()) - (p.lastContactAt || p.joinedAt || 0);
  return silentMs >= CONFIG.offline.flagAfterMs;
}
