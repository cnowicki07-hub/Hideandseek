// Tier 3 — totems and sabotage. Plus signposts (Tier 5), which live here
// because they are the other piece of persistent world state.
//
// Sabotage is the fiddliest sync problem in the build: two hiders must be
// inside the totem's precision radius *at the same time* with no server to
// adjudicate. The approach: each present client writes a presence heartbeat
// onto the totem doc, so any client can count who is currently there, and
// accrual runs inside a transaction keyed on `lastAccrualAt` so concurrent
// writers credit the elapsed gap once rather than once each.

function totemPrecisionRadiusM() {
  // Design doc Section 3: equal to the game's base GPS accuracy, never smaller.
  // Living-room mode overrides it — tokens are exact, so there is no GPS
  // slop to compensate for.
  return totemPrecisionOverrideM() || CONFIG.baseAccuracyRadiusM;
}

async function placeTotem(point) {
  const radiusM = totemRadiusM(M);
  await gameRef().collection('totems').add({
    placedBy: playerId,
    lat: point.lat, lng: point.lng,
    radiusM,
    requiredS: totemSabotageSeconds(radiusM),
    status: 'active',
    createdAt: Date.now(),
    presence: {},
    sabotageProgressS: 0,
    lastAccrualAt: 0,
    lastPingAt: 0,
    recentPings: [],
  });
  toast(`Totem placed (${Math.round(radiusM)}m radius).`);
}

async function retireTotem(totemId) {
  const t = totemsState[totemId];
  if (!t || t.placedBy !== playerId) { toast('You can only retire your own totems.'); return; }
  await gameRef().collection('totems').doc(totemId).update({ status: 'destroyed', destroyedAt: Date.now(), destroyedBy: 'retired' });
  toast('Totem retired.');
}

// ---------- presence ----------

function freshPresenceIds(t, now) {
  now = now || Date.now();
  return Object.entries(t.presence || {})
    .filter(([id, at]) => now - at <= CONFIG.totem.presenceStaleMs)
    .filter(([id]) => {
      const p = playersState[id];
      return p && p.role === 'hider' && p.status === 'active';
    })
    .map(([id]) => id);
}

function isBeingSabotaged(t, now) {
  if (!t || t.status !== 'active') return false;
  return freshPresenceIds(t, now).length >= CONFIG.totem.sabotageMinParticipants;
}

// Progress as it stands right now, applying half-rate decay for any time
// since accrual last ran (design doc Section 8).
function effectiveSabotageProgressS(t, now) {
  now = now || Date.now();
  const stored = t.sabotageProgressS || 0;
  if (!stored) return 0;
  if (isBeingSabotaged(t, now)) return stored;
  const absentS = t.lastAccrualAt ? (now - t.lastAccrualAt) / 1000 : 0;
  return Math.max(0, stored - CONFIG.totem.sabotageDecayRate * absentS);
}

// Seconds until an abandoned sabotage decays back to nothing — shown to other
// hiders so a partner can decide whether it is worth running over.
function sabotageDecaySecondsLeft(t, now) {
  const progress = effectiveSabotageProgressS(t, now);
  if (progress <= 0) return 0;
  return progress / CONFIG.totem.sabotageDecayRate;
}

// ---------- tick (hider clients only) ----------

function tickTotems(p, now) {
  const precision = totemPrecisionRadiusM();
  Object.entries(totemsState).forEach(([id, t]) => {
    if (t.status !== 'active') return;
    const centre = { lat: t.lat, lng: t.lng };
    const dist = distanceM(myPos, centre);

    if (dist <= precision) {
      // Heartbeat: this is what lets every other client see me standing here.
      gameRef().collection('totems').doc(id)
        .update({ ['presence.' + playerId]: now }).catch(() => {});
      accrueSabotage(id);
    }

    if (dist <= t.radiusM && !isBeingSabotaged(t, now)) {
      maybeEmitTotemPing(id, t, now);
    }
  });
}

async function accrueSabotage(totemId) {
  const ref = gameRef().collection('totems').doc(totemId);
  const tolerance = (CONFIG.tickMs / 1000) * 2;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const t = snap.data();
    if (!t || t.status !== 'active') return;

    const now = Date.now();
    const present = freshPresenceIds(t, now);
    if (present.length < CONFIG.totem.sabotageMinParticipants) return;

    const sinceLastS = t.lastAccrualAt ? (now - t.lastAccrualAt) / 1000 : Infinity;

    let base;
    let credit;
    if (sinceLastS > tolerance) {
      // Resuming after a gap: apply the half-rate decay for the absence first,
      // then start crediting from now.
      base = Math.max(0, (t.sabotageProgressS || 0) - CONFIG.totem.sabotageDecayRate * (t.lastAccrualAt ? sinceLastS : 0));
      credit = 0;
    } else {
      base = t.sabotageProgressS || 0;
      credit = sinceLastS;
    }

    const progress = Math.min(t.requiredS, base + credit);

    if (progress >= t.requiredS) {
      tx.update(ref, {
        status: 'destroyed', destroyedAt: now, destroyedBy: 'sabotage',
        sabotageProgressS: t.requiredS, sabotageParticipants: present,
      });
      onSabotageComplete(present, t);
    } else {
      tx.update(ref, { sabotageProgressS: progress, lastAccrualAt: now });
    }
  }).catch((e) => console.warn('sabotage accrual', e));
}

async function onSabotageComplete(participants, totem) {
  // Sabotaging any totem clears the Hunt mark on everyone who worked on it
  // (design doc Sections 7 and 8).
  await Promise.all(participants.map((id) => clearHuntsOn(id)));
  await pushEvent({ type: 'totem_destroyed', lat: totem.lat, lng: totem.lng });
  if (participants.includes(playerId)) toast('Totem destroyed. Any hunt on you is cleared.');
}

// The anonymous ping: a hider inside an active totem is reported exactly, but
// without identity. When several hiders are inside, one is picked at random —
// which is what lets a seeker tell a stack of dots (someone camping) from a
// drifting line of them (someone passing through).
async function maybeEmitTotemPing(totemId, t, now) {
  if (now - (t.lastPingAt || 0) < CONFIG.totem.pingIntervalMs) return;
  const ref = gameRef().collection('totems').doc(totemId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data();
    if (!cur || cur.status !== 'active') return;
    if (Date.now() - (cur.lastPingAt || 0) < CONFIG.totem.pingIntervalMs) return;

    const inside = Object.entries(playersState).filter(([, p]) =>
      p.role === 'hider' && p.status === 'active' && p.realLat &&
      distanceM({ lat: p.realLat, lng: p.realLng }, { lat: cur.lat, lng: cur.lng }) <= cur.radiusM);
    if (!inside.length) return;

    const pick = inside[Math.floor(Math.random() * inside.length)][1];
    const pings = (cur.recentPings || []).concat([{
      lat: pick.realLat, lng: pick.realLng, at: Date.now(),
    }]).slice(-CONFIG.ping.maxStored);

    tx.update(ref, { lastPingAt: Date.now(), recentPings: pings });
  }).catch((e) => console.warn('totem ping', e));
}

// ---------- Signposts (Tier 5) ----------

async function placeSignpost(text) {
  const trimmed = (text || '').trim().slice(0, CONFIG.signposts.maxLength);
  if (!trimmed) return;
  if (!myPos) { toast('No GPS fix yet.'); return; }
  await gameRef().collection('signposts').add({
    lat: myPos.lat, lng: myPos.lng,
    text: trimmed,
    placedAt: Date.now(),
    // Stored but never surfaced to readers — signs are anonymous.
    authorId: playerId,
  });
  toast('Signpost placed.');
}

// ---------- I SEE YOU ----------
//
// Distance to the closest active seeker, from true positions — this is a
// physical proximity rule like a tripwire, not a reading, so the 30m display
// jitter has nothing to do with it.
function nearestSeekerM(now) {
  if (!myPos) return Infinity;
  let best = Infinity;
  Object.entries(playersState).forEach(([id, p]) => {
    if (id === playerId || p.role !== 'seeker' || p.status !== 'active') return;
    if (p.realLat == null) return;
    best = Math.min(best, distanceM(myPos, { lat: p.realLat, lng: p.realLng }));
  });
  return best;
}

// True when this player must stop running. Hiders only, and only once the
// hunt is actually on — during hiding time the seekers are frozen at the
// start line and every hider walks past them on the way out.
function iSeeYouActive(p, now) {
  if (!p || p.role !== 'hider' || p.status !== 'active') return false;
  if (!gameState || gameState.status !== 'active' || isPaused()) return false;
  return nearestSeekerM(now) <= iSeeYouRadiusM();
}

// Signs you have walked into. Kept per player and per game, and remembered
// across a reload so a dropped connection does not un-discover the map.
const discoveredSignposts = new Set();
let discoveryLoadedFor = null;

function signpostDiscoveryKey() { return `h_signs_${gameCode}`; }

function loadSignpostDiscovery() {
  if (discoveryLoadedFor === gameCode) return;
  discoveryLoadedFor = gameCode;
  discoveredSignposts.clear();
  try {
    JSON.parse(localStorage.getItem(signpostDiscoveryKey()) || '[]')
      .forEach((id) => discoveredSignposts.add(id));
  } catch (e) { /* first run, or storage unavailable */ }
}

// Called from the rules tick: anything you are standing next to is now known.
function tickSignpostDiscovery() {
  if (!myPos || !gameCode) return;
  loadSignpostDiscovery();
  let found = false;
  Object.entries(signpostsState).forEach(([id, s]) => {
    if (discoveredSignposts.has(id)) return;
    if (distanceM(myPos, { lat: s.lat, lng: s.lng }) > CONFIG.signposts.discoverRadiusM) return;
    discoveredSignposts.add(id);
    found = true;
  });
  if (!found) return;
  try {
    localStorage.setItem(signpostDiscoveryKey(), JSON.stringify([...discoveredSignposts]));
  } catch (e) { /* storage unavailable — discovery just won't survive a reload */ }
  toast('You found a signpost.');
}

function signpostDiscovered(id) {
  loadSignpostDiscovery();
  return discoveredSignposts.has(id);
}

// Readable signs: ones you have already found, and are currently close
// enough to read. You have to walk into a sign before it exists for you, so
// the Signs button can never count one you have not discovered.
function signpostsInRange(pos, now) {
  if (!pos) return [];
  return Object.entries(signpostsState)
    .filter(([id]) => signpostDiscovered(id))
    .map(([id, s]) => ({ id, ...s, dist: distanceM(pos, { lat: s.lat, lng: s.lng }) }))
    .filter((s) => s.dist <= CONFIG.signposts.readRadiusM)
    .sort((a, b) => b.placedAt - a.placedAt);
}
