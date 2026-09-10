// Tap-to-travel, used by living-room mode instead of GPS.
//
// You tap a destination and your token walks there at a set speed. It is not
// a teleport on purpose: travel time is the substance of the game — deciding
// whether you can reach a totem before a seeker sweeps it is the same
// decision indoors as out, just compressed into seconds.

let travelPos = null;      // where the token is now
let travelDest = null;     // where it is heading, or null when parked
let travelTimer = null;
let travelLastStepAt = 0;

function usingTravelMode() {
  return !!(gameState && gameState.mode === 'livingroom');
}

function startTravel(origin) {
  travelPos = { lat: origin.lat, lng: origin.lng };
  travelDest = null;
  travelLastStepAt = Date.now();
  if (travelTimer) return;
  // Faster than the rules tick so the token slides rather than teleports.
  travelTimer = setInterval(stepTravel, 250);
}

function stopTravel() {
  if (travelTimer) clearInterval(travelTimer);
  travelTimer = null;
  travelDest = null;
}

function setTravelDestination(point) {
  if (!travelPos) return;
  travelDest = { lat: point.lat, lng: point.lng };
}

function travelDistanceRemaining() {
  if (!travelPos || !travelDest) return 0;
  return distanceM(travelPos, travelDest);
}

function stepTravel() {
  if (!travelPos) return;
  const now = Date.now();
  const dtS = Math.max(0, (now - travelLastStepAt) / 1000);
  travelLastStepAt = now;

  if (isPaused()) return;

  if (travelDest) {
    const remaining = distanceM(travelPos, travelDest);
    const step = (CONFIG.livingRoom ? CONFIG.livingRoom.travelSpeedMps : 28) * dtS;
    if (remaining <= step) {
      travelPos = { lat: travelDest.lat, lng: travelDest.lng };
      travelDest = null;
    } else {
      const heading = bearingDeg(travelPos, travelDest);
      travelPos = destinationPoint(travelPos, heading, step);
    }
  }

  // Feed the engine exactly as a GPS fix would, so every rule downstream —
  // pings, boundary, sabotage presence, tripwires — behaves identically.
  onPosition({
    coords: { latitude: travelPos.lat, longitude: travelPos.lng, accuracy: 1 },
    timestamp: now,
  });
}

// Scatter starting positions, since indoors nobody has a real one. Hiders go
// anywhere inside the boundary; seekers start together at the middle so they
// have somewhere to be held.
function scatterStartPositions(boundary, players) {
  const centre = polygonCentroid(boundary);
  const out = {};
  Object.entries(players).forEach(([id, p]) => {
    if (p.role === 'seeker') {
      out[id] = { lat: centre.lat, lng: centre.lng };
      return;
    }
    let point = centre;
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = randomPointInRadius(centre, 0.42 * computeM(polygonAreaM2(boundary)));
      if (pointInPolygon(candidate, boundary)) { point = candidate; break; }
    }
    out[id] = point;
  });
  return out;
}
