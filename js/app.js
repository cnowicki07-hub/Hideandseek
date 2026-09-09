// Core engine. Tier 1: join/host, roles, position sync with real
// ping cadence + uncertainty growth, charge economy shell, capture,
// timer. Power *effects* hook into activatePower() below — Tier 2.

let gameCode = null;
let playerId = null;
let playerRole = null;
let map, markersLayer;
let watchId = null;
let M = 0; // sqrt(boundary area), set from game config on join
let lastRealPing = null; // { lat, lng, at } — for movement-state detection
let gameStartAt = null;
let gameLengthMs = 0;

function newPlayerId() {
  let id = localStorage.getItem('h_playerId');
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    localStorage.setItem('h_playerId', id);
  }
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

// ---------- Host: create game ----------

async function hostCreateGame(areaM2, gameLengthMinInput) {
  gameCode = newGameCode();
  M = computeM(areaM2);
  const lengthMin = gameLengthMinInput || CONFIG.gameLengthMin;
  await db.collection('games').doc(gameCode).set({
    status: 'lobby',
    areaM2, M,
    gameLengthMin: lengthMin,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    lastCaptureAt: null, // drives the global Hunt no-capture timer
  });
  await joinGame(gameCode, currentPlayerName, true);
}

// ---------- Join ----------

async function joinGame(code, name, isHost) {
  gameCode = code.toUpperCase();
  playerId = newPlayerId();
  const gameRef = db.collection('games').doc(gameCode);
  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) { alert('Game code not found.'); return false; }
  const gameData = gameSnap.data();
  M = gameData.M;

  await gameRef.collection('players').doc(playerId).set({
    name,
    isHost: !!isHost,
    role: null, // assigned in lobby
    status: 'active',
    captureCode: newCaptureCode(),
    charge: CONFIG.charge.cap,
    chargeCheckpoint: CONFIG.charge.cap,
    chargeCheckpointAt: Date.now(),
    cooldownUntil: 0,
    activePower: null,
    realLat: null, realLng: null, realUpdatedAt: null,
    broadcastLat: null, broadcastLng: null, broadcastRadiusM: CONFIG.baseAccuracyRadiusM,
    broadcastAt: null,
    lastPingRealPos: null,
    huntedBy: {},
    joinedAt: Date.now(),
  }, { merge: true });

  subscribeToGame();
  subscribeToPlayers();
  return true;
}

// ---------- Charge economy ----------

function currentCharge(p) {
  if (!p) return 0;
  const elapsedMs = Date.now() - p.chargeCheckpointAt;
  const regen = elapsedMs * CONFIG.charge.regenPerMs;
  return Math.min(CONFIG.charge.cap, p.chargeCheckpoint + regen);
}

async function spendCharge(amount) {
  const ref = playerRef();
  const snap = await ref.get();
  const p = snap.data();
  const have = currentCharge(p);
  if (have < amount) return false;
  if (p.cooldownUntil && Date.now() < p.cooldownUntil) return false;
  await ref.update({
    chargeCheckpoint: have - amount,
    chargeCheckpointAt: Date.now(),
    cooldownUntil: Date.now() + CONFIG.charge.globalCooldownMs,
  });
  return true;
}

function playerRef() {
  return db.collection('games').doc(gameCode).collection('players').doc(playerId);
}

// ---------- Position tracking ----------

function startTracking() {
  if (!navigator.geolocation) { alert('No GPS on this device/browser.'); return; }
  watchId = navigator.geolocation.watchPosition(onPosition, (err) => console.warn('geo error', err), {
    enableHighAccuracy: true, maximumAge: 2000, timeout: 10000,
  });
}

function onPosition(pos) {
  const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  playerRef().update({ realLat: here.lat, realLng: here.lng, realUpdatedAt: Date.now() });

  if (playerRole === 'seeker') {
    // Seekers broadcast continuously at full accuracy, unless Go Dark is active — handled in Tier 2.
    playerRef().update({ broadcastLat: here.lat, broadcastLng: here.lng, broadcastRadiusM: 0, broadcastAt: Date.now() });
    return;
  }

  if (playerRole === 'hider') {
    maybeSendHiderPing(here);
  }
}

// Movement state + phase-based ping cadence + uncertainty growth,
// per design doc Section 4.
let nextPingDueAt = 0;

function currentPhase() {
  const elapsedPct = ((Date.now() - gameStartAt) / gameLengthMs) * 100;
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

function maybeSendHiderPing(here) {
  const now = Date.now();
  if (!lastRealPing) {
    lastRealPing = { ...here, at: now };
    sendRealHiderPing(here, now);
    return;
  }
  const dtMin = (now - lastRealPing.at) / 60000;
  const distM = distanceM(lastRealPing, here);
  const speedMPerMin = dtMin > 0 ? distM / dtMin : 0;
  const moving = speedMPerMin > CONFIG.ping.movingThresholdMPerMin;

  if (now < nextPingDueAt) return;
  sendRealHiderPing(here, now, moving);
}

function sendRealHiderPing(here, now, moving) {
  const phase = currentPhase();
  const growthRate = phase === 3 ? CONFIG.ping.growthRateMPerMinPhase3 : CONFIG.ping.growthRateMPerMinPhase12;
  const minsSinceLast = lastRealPing ? (now - lastRealPing.at) / 60000 : 0;
  const cap = CONFIG.ping.uncertaintyCapFraction * M;
  const uncertainty = Math.min(cap, CONFIG.baseAccuracyRadiusM + growthRate * minsSinceLast);

  playerRef().get().then((snap) => {
    const p = snap.data();
    // Go Quiet / Decoy / Smear intercept here in Tier 2 — for now, real ping always.
    playerRef().update({
      broadcastLat: here.lat, broadcastLng: here.lng,
      broadcastRadiusM: uncertainty, broadcastAt: now,
    });
  });

  lastRealPing = { ...here, at: now };
  nextPingDueAt = now + pingInterval(phase, moving);
}

// ---------- Capture ----------
// No target selection in the UI — capture in real life happens because
// the seeker can already see/identify the hider. The app's only job is
// to verify the 4-letter code they're handed and convert that player.

async function attemptCaptureByCode(enteredCode) {
  const snap = await db.collection('games').doc(gameCode).collection('players')
    .where('captureCode', '==', enteredCode.toUpperCase())
    .where('role', '==', 'hider')
    .where('status', '==', 'active')
    .get();
  if (snap.empty) return { ok: false, reason: 'code_mismatch' };
  const doc = snap.docs[0];
  const target = doc.data();
  await doc.ref.update({
    role: 'seeker',
    status: 'active',
    convertedAt: Date.now(),
    graceUntil: Date.now() + CONFIG.charge.conversionGraceMs,
    chargeCheckpoint: CONFIG.charge.conversionStartingCharge,
    chargeCheckpointAt: Date.now(),
    broadcastRadiusM: 0,
  });
  await db.collection('games').doc(gameCode).update({ lastCaptureAt: Date.now() });
  return { ok: true, name: target.name };
}

// ---------- Host: lobby actions ----------

async function assignRolesRandom(numSeekers) {
  const snap = await db.collection('games').doc(gameCode).collection('players').get();
  const ids = snap.docs.map((d) => d.id);
  const shuffled = ids.sort(() => Math.random() - 0.5);
  const batch = db.batch();
  shuffled.forEach((id, i) => {
    const role = i < numSeekers ? 'seeker' : 'hider';
    batch.update(db.collection('games').doc(gameCode).collection('players').doc(id), { role });
  });
  await batch.commit();
}

async function startGame() {
  const now = Date.now();
  gameStartAt = now;
  await db.collection('games').doc(gameCode).update({
    status: 'active', startedAt: now,
  });
  startTracking();
}

// ---------- Realtime subscriptions ----------


function subscribeToGame() {
  db.collection('games').doc(gameCode).onSnapshot((snap) => {
    const g = snap.data();
    if (!g) return;
    if (g.status === 'active') {
      if (!gameStartAt) {
        gameStartAt = g.startedAt;
        gameLengthMs = g.gameLengthMin * 60000;
      }
      if (!watchId) startTracking(); // every client starts tracking itself once the game is live
    }
    renderGameStatus(g);
  });
}

function subscribeToPlayers() {
  db.collection('games').doc(gameCode).collection('players').onSnapshot((snap) => {
    const players = {};
    snap.forEach((doc) => { players[doc.id] = doc.data(); });
    renderPlayers(players);
  });
}

// renderGameStatus, renderPlayers, and all UI wiring live in ui.js.
