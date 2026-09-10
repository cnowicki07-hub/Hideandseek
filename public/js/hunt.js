// Tier 4 — the Hunt and Snitch (design doc Sections 7 and 5.2).
//
// The Hunt is deliberately independent of the charge economy: it costs
// nothing and is gated only by the global no-capture timer. Bearings are
// computed on each party's own client from positions both already hold, and
// are refreshed every 30s rather than continuously, so the information
// stays as coarse as the design intends.

function huntAvailableAt(now) {
  if (!gameState || gameState.status !== 'active') return null;
  const since = gameState.lastCaptureAt || gameState.startedAt;
  if (!since) return null;
  return since + CONFIG.hunt.noCaptureCooldownMs;
}

function huntAvailable(now) {
  now = now || Date.now();
  const at = huntAvailableAt(now);
  return at != null && now >= at;
}

async function activateHunt(targetId) {
  const p = me();
  const now = Date.now();
  if (p.role !== 'seeker') { toast('Seekers only.'); return; }
  if (inGrace(p)) { toast('Conversion grace period.'); return; }
  if (!huntAvailable(now)) { toast('Hunt is not available yet.'); return; }
  if (p.activeHunt && now < p.activeHunt.expiresAt) { toast('You already have a hunt running.'); return; }

  const target = playersState[targetId];
  if (!target || target.role !== 'hider' || target.status !== 'active') { toast('Invalid target.'); return; }

  const hunt = { targetId, startedAt: now, expiresAt: now + CONFIG.hunt.durationMs };
  await playerRef().update({ activeHunt: hunt });
  await playerRef(targetId).update({
    ['huntedBy.' + playerId]: { startedAt: now, expiresAt: hunt.expiresAt },
  });
  await pushEvent({ type: 'hunted', to: targetId });
  toast(`Hunting ${target.name}.`);
}

async function clearHuntsOn(targetId) {
  const writes = [];
  const target = playersState[targetId];
  if (target && target.huntedBy && Object.keys(target.huntedBy).length) {
    writes.push(playerRef(targetId).update({ huntedBy: {} }));
  }
  Object.entries(playersState).forEach(([sid, s]) => {
    if (s.activeHunt && s.activeHunt.targetId === targetId) {
      writes.push(playerRef(sid).update({ activeHunt: null }));
      writes.push(pushEvent({ type: 'hunt_cleared', to: sid }));
    }
  });
  await Promise.all(writes);
}

function activeMarksOn(p, now) {
  now = now || Date.now();
  return Object.entries(p.huntedBy || {})
    .filter(([, m]) => now < m.expiresAt)
    .map(([seekerId, m]) => ({ seekerId, ...m }));
}

// ---------- bearings ----------
// Cached so the reading genuinely refreshes on the configured cadence.

const huntBearingCache = {};

function huntBearing(fromId, toId, now) {
  now = now || Date.now();
  const key = fromId + '>' + toId;
  const cached = huntBearingCache[key];
  if (cached && now - cached.at < CONFIG.hunt.bearingRefreshMs) return cached;

  const a = playersState[fromId];
  const b = playersState[toId];
  if (!a || !b || !a.realLat || !b.realLat) return cached || null;

  const from = { lat: a.realLat, lng: a.realLng };
  const to = { lat: b.realLat, lng: b.realLng };
  const dist = distanceM(from, to);
  const reading = {
    bearing: bearingDeg(from, to),
    coneHalfWidthDeg: huntConeHalfWidthDeg(dist),
    at: now,
  };
  huntBearingCache[key] = reading;
  return reading;
}

function tickHunt(p, now) {
  if (p.activeHunt) {
    if (now >= p.activeHunt.expiresAt) {
      playerRef().update({ activeHunt: null }).catch(() => {});
      toast('Your hunt lapsed.');
    } else {
      huntBearing(playerId, p.activeHunt.targetId, now);
    }
  }
  const marks = activeMarksOn(p, now);
  marks.forEach((m) => huntBearing(playerId, m.seekerId, now));

  // Drop expired marks so the UI stops showing them.
  const stale = Object.entries(p.huntedBy || {}).filter(([, m]) => now >= m.expiresAt);
  if (stale.length) {
    const update = {};
    stale.forEach(([sid]) => { update['huntedBy.' + sid] = FieldValue.delete(); });
    playerRef().update(update).catch(() => {});
  }
}

// ---------- Snitch ----------

function snitchAvailableReason(p, now) {
  now = now || Date.now();
  if (p.role !== 'hider') return 'Hiders only.';
  const marks = activeMarksOn(p, now);
  if (!marks.length) return 'Only usable while you are being hunted.';
  const newestMark = Math.max(...marks.map((m) => m.startedAt));
  if ((p.snitchUsedAt || 0) >= newestMark) return 'Already used for this hunt.';
  if (onCooldown(p)) return `Cooldown ${Math.ceil((p.cooldownUntil - now) / 1000)}s.`;
  if (currentCharge(p) < CONFIG.snitch.cost) return `Needs ${CONFIG.snitch.cost} charge.`;
  return null;
}

// Stage 1: survey every other hider at range-banded fidelity.
function snitchSurvey(now) {
  now = now || Date.now();
  const c = CONFIG.snitch;
  const out = [];

  Object.entries(playersState).forEach(([id, p]) => {
    if (id === playerId || p.role !== 'hider' || p.status !== 'active') return;
    // Someone running Go Quiet cannot be sold out.
    if (p.goQuietUntil && now < p.goQuietUntil) return;

    // A decoy user surveys as their decoy, not their real position.
    let pos;
    if (p.decoy && now < p.decoy.expiresAt) {
      pos = decoyPositionAt(p.decoy, now);
    } else {
      if (!p.realLat) return;
      pos = { lat: p.realLat, lng: p.realLng };
    }

    const dist = distanceM(myPos, pos);
    let radiusM;
    if (dist <= c.exactRangeM) radiusM = 0;
    else if (dist <= c.mediumRangeM) radiusM = c.mediumCircleM;
    else if (dist <= c.wideRangeM) radiusM = c.wideCircleM;
    else return; // beyond wide range: nothing

    // The band is the error, not a circle to draw any more: someone far off
    // surveys as a point that is wrong by up to the band's radius, so what
    // you pass on about them is wrong by that much too.
    const shown = radiusM ? randomPointInRadius(pos, radiusM) : pos;
    out.push({ id, name: p.name, lat: shown.lat, lng: shown.lng, radiusM, dist });
  });

  return out.sort((a, b) => a.dist - b.dist);
}

async function beginSnitch() {
  const p = me();
  const blocked = snitchAvailableReason(p);
  if (blocked) { toast(blocked); return; }
  if (!myPos) { toast('No GPS fix yet.'); return; }

  const paid = await spendCharge(CONFIG.snitch.cost);
  if (!paid) { toast('Not enough charge.'); return; }

  const now = Date.now();
  await playerRef().update({ snitchUsedAt: now });

  const entries = snitchSurvey(now);
  reveals.snitch = { entries, expiresAt: now + CONFIG.snitch.displayMs };
  showSnitchSurvey(entries);
  renderWorld();
}

// Stage 2: hand one surveyed hider to whichever seeker currently holds the mark.
async function snitchOn(targetId) {
  const p = me();
  const now = Date.now();
  const entry = (reveals.snitch && reveals.snitch.entries || []).find((e) => e.id === targetId);
  if (!entry) { toast('That reading has expired.'); return; }

  const marks = activeMarksOn(p, now);
  if (!marks.length) { toast('You are no longer being hunted.'); return; }

  // Betrayal produces a real ping on the betrayed hider, so it lands in the
  // trail like any other reading — and the hunters are told to look.
  await emitPing(targetId, { lat: entry.lat, lng: entry.lng }, { notify: false });
  await Promise.all(marks.map((m) => pushEvent({
    type: 'snitch_report', to: m.seekerId, name: entry.name,
  })));

  reveals.snitch = null;
  hideSnitchSurvey();
  // The betrayed player is deliberately never notified.
  toast(`Sold out ${entry.name}.`);
}
