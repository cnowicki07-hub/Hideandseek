// The powers.
//
// Nothing on the map appears for free. A hider is invisible from the moment
// they hide until a seeker spends charge to find them, so this file is
// effectively the whole information economy of the game.
//
// Reveals that only the acting player should see resolve locally, in
// `reveals`, and are never written anywhere. Effects imposed on another
// player are written as a field on that player's document, which their own
// client reads and obeys.

// Temporary, client-local reveals. Never synced.
const reveals = {
  scan: null,     // { bearings: [{ id, bearing, color }], expiresAt }
  probe: null,    // { origin, bearing, halfWidthDeg, radiusM, expiresAt }
  disarm: null,   // { points: [{lat,lng}], expiresAt }
  snitch: null,   // { entries: [...], expiresAt }
};

function revealActive(key, now) {
  const r = reveals[key];
  return !!(r && (now || Date.now()) < r.expiresAt);
}

// One colour per player, stable for the game, so a Scan's edge glows can be
// counted and told apart.
const PLAYER_COLOURS = [
  '#ff4d4d', '#ffd24d', '#4dd2ff', '#a94dff',
  '#4dff88', '#ff8c4d', '#ff4dc4', '#8cff4d',
];

function playerColour(id) {
  const ids = Object.keys(playersState).sort();
  const i = ids.indexOf(id);
  return PLAYER_COLOURS[(i < 0 ? 0 : i) % PLAYER_COLOURS.length];
}

const POWERS = {
  // ---------------- Seeker ----------------

  scan: {
    role: 'seeker', label: 'Scan',
    desc: 'A coloured glow at the edge of your screen for each hider, showing '
      + 'roughly which direction they are in. No distance, no position — just '
      + 'how many and which way. Cheap. Use it to decide where to Probe.',
    cost: () => CONFIG.seekerPowers.scan.cost,
    target: 'self',
    async run() {
      const now = Date.now();
      const bearings = [];
      Object.entries(playersState).forEach(([id, p]) => {
        if (p.role !== 'hider' || p.status !== 'active' || !p.realLat) return;
        bearings.push({
          id,
          bearing: bearingDeg(myPos, { lat: p.realLat, lng: p.realLng }),
          color: playerColour(id),
        });
      });
      reveals.scan = { bearings, expiresAt: now + CONFIG.seekerPowers.scan.displayMs };
      toast(bearings.length
        ? `${bearings.length} hider(s) out there.`
        : 'Nothing out there.');
      renderScanGlow();
    },
  },

  probe: {
    role: 'seeker', label: 'Probe',
    desc: () => 'Tap the map to send a wave sweeping out across that entire half of '
      + 'the world, to the boundary. Everyone it passes gets pinged. The most '
      + 'you can learn in one action — two of them cover everything — but what '
      + `it reports is only good to about ${pingJitterM()}m. Scan first to `
      + 'pick the half.',
    cost: () => CONFIG.seekerPowers.probe.cost,
    target: 'point',
    async run(ctx) {
      const now = Date.now();
      const half = CONFIG.seekerPowers.probe.halfWidthDeg;
      const sweepBearing = bearingDeg(myPos, ctx.point);

      let hits = 0;
      for (const [id, p] of Object.entries(playersState)) {
        if (id === playerId || p.status !== 'active' || !p.realLat) continue;
        if (p.role !== 'hider') continue;
        const toThem = bearingDeg(myPos, { lat: p.realLat, lng: p.realLng });
        if (angleDifference(toThem, sweepBearing) > half) continue;
        // eslint-disable-next-line no-await-in-loop
        if (await emitPing(id, { lat: p.realLat, lng: p.realLng })) hits++;
      }

      reveals.probe = {
        origin: { ...myPos }, bearing: sweepBearing, halfWidthDeg: half,
        radiusM: sweepReachM(),
        expiresAt: now + 6000,
      };
      toast(hits ? `Wave caught ${hits} hider(s).` : 'The wave found nothing.');
      renderWorld();
    },
  },

  tripwire: {
    role: 'seeker', label: 'Tripwire',
    desc: () => `Leaves a hidden trap where you stand. If a hider passes within `
      + `${tripwireRadiusM()}m it tells you exactly where they were — the only `
      + 'reading in the game that is not fuzzy. Dirt cheap, but you have to '
      + 'guess where they walk.',
    cost: () => CONFIG.seekerPowers.tripwire.cost,
    target: 'self',
    async run() {
      await gameRef().collection('tripwires').add({
        placedBy: playerId, lat: myPos.lat, lng: myPos.lng,
        triggered: false, placedAt: Date.now(),
      });
      toast('Tripwire placed.');
    },
  },

  lockout: {
    role: 'seeker', label: 'Lockout',
    desc: 'Stops one hider using any power for 3 minutes — no Go Quiet, no '
      + 'Decoy, no Seeker Scan. Use it on someone you are already closing on.',
    cost: () => CONFIG.seekerPowers.lockout.cost,
    target: 'hider',
    async run(ctx) {
      const until = Date.now() + CONFIG.seekerPowers.lockout.durationMs;
      await playerRef(ctx.targetId).update({ lockedOutUntil: until });
      await pushEvent({ type: 'lockout', to: ctx.targetId });
      toast(`${playersState[ctx.targetId].name} locked out.`);
    },
  },

  totem: {
    role: 'seeker', label: 'Totem',
    desc: 'A permanent watchtower placed anywhere on the map. Any hider inside '
      + 'it gets reported — anonymously, but exactly, with no fuzziness at all. '
      + 'Two hiders standing at it together can destroy it.',
    cost: () => CONFIG.seekerPowers.totem.cost,
    target: 'point',
    guard() {
      const live = Object.values(totemsState).filter((t) => t.status !== 'destroyed').length;
      if (live >= CONFIG.seekerPowers.totem.maxLive) {
        return `Totem limit reached (${CONFIG.seekerPowers.totem.maxLive} live).`;
      }
      return null;
    },
    async run(ctx) { await placeTotem(ctx.point); },
  },

  // ---------------- Hider ----------------

  go_quiet: {
    role: 'hider', label: 'Go quiet',
    running: (p, now) => !!(p.goQuietUntil && now < p.goQuietUntil),
    desc: 'The next attempt to ping you simply fails. A seeker can sweep right '
      + 'over you and get nothing back. Lasts 3 minutes or until it eats a ping.',
    cost: () => CONFIG.hiderPowers.go_quiet.cost,
    target: 'self',
    async run() {
      const until = Date.now() + CONFIG.hiderPowers.go_quiet.durationMs;
      await playerRef().update({
        goQuietUntil: until, activePower: 'go_quiet', activePowerExpiresAt: until,
      });
      toast('Quiet. The next ping aimed at you will find nothing.');
    },
  },

  decoy: {
    role: 'hider', label: 'Decoy',
    running: (p, now) => !!(p.decoy && now < p.decoy.expiresAt),
    desc: 'A fake you walks off on a bearing you pick. For 3 minutes, anything '
      + 'that pings you pings the decoy instead — so seekers get real dots, in '
      + 'the wrong place, walking somewhere you are not.',
    cost: () => CONFIG.hiderPowers.decoy.cost,
    target: 'bearing',
    async run(ctx) {
      const now = Date.now();
      const until = now + CONFIG.hiderPowers.decoy.durationMs;
      await playerRef().update({
        decoy: {
          originLat: myPos.lat, originLng: myPos.lng,
          bearing: ctx.bearing, startedAt: now, expiresAt: until,
        },
        activePower: 'decoy', activePowerExpiresAt: until,
      });
      toast(`Decoy walking ${Math.round(ctx.bearing)}°.`);
    },
  },

  seeker_scan: {
    role: 'hider', label: 'Seeker scan',
    desc: 'Sweeps the whole area and pins every seeker on your map, exactly, '
      + 'wherever they are. Expensive, and your only way of ever seeing them.',
    cost: () => CONFIG.hiderPowers.seeker_scan.cost,
    target: 'self',
    async run() {
      let found = 0;
      for (const [id, p] of Object.entries(playersState)) {
        if (p.role !== 'seeker' || p.status !== 'active' || !p.realLat) continue;
        // Seekers are reported exactly — the fuzziness is a hider's privilege.
        // eslint-disable-next-line no-await-in-loop
        await emitPing(id, { lat: p.realLat, lng: p.realLng },
          { exact: true, ignoreCounters: true, notify: false });
        found++;
      }
      toast(found ? `${found} seeker(s) pinned.` : 'No seekers found.');
      renderWorld();
    },
  },

  disarm: {
    role: 'hider', label: 'Disarm',
    desc: () => `Finds and destroys any hidden tripwires within ${disarmRadiusM()}m `
      + 'of you. Worth spending before a gate, a bridge, or anywhere obvious '
      + 'you have to cross.',
    cost: () => CONFIG.hiderPowers.disarm.cost,
    target: 'self',
    async run() {
      const radius = disarmRadiusM();
      const found = [];
      const deletions = [];
      Object.entries(tripwiresState).forEach(([id, tw]) => {
        if (tw.triggered) return;
        if (distanceM(myPos, { lat: tw.lat, lng: tw.lng }) > radius) return;
        found.push({ lat: tw.lat, lng: tw.lng });
        deletions.push(gameRef().collection('tripwires').doc(id).delete());
      });
      await Promise.all(deletions);
      reveals.disarm = { points: found, expiresAt: Date.now() + 15000 };
      toast(found.length
        ? `Destroyed ${found.length} tripwire(s).`
        : `No tripwires within ${radius}m.`);
      renderWorld();
    },
  },
};

// How far a Probe wave has to travel to clear the play area.
function sweepReachM() {
  const b = gameState && gameState.boundary;
  if (!b || b.length < 3 || !myPos) return 2000;
  return Math.max(...b.map((v) => distanceM(myPos, v))) * 1.05;
}

// Smallest angle between two bearings, 0–180.
function angleDifference(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// ---------- Availability ----------

function powerBlockedReason(key, p, now) {
  const def = POWERS[key];
  now = now || Date.now();
  if (!def) return 'Unknown power.';
  if (!p || p.status !== 'active') return 'You are out of the game.';
  if (isHiding()) {
    return p.role === 'seeker'
      ? 'Held at the start line until hiding time ends.'
      : 'Get hidden first — powers unlock when the seekers are released.';
  }
  if (!gameState || gameState.status !== 'active') return 'Game is not running.';
  if (isPaused()) return 'Game is paused.';
  if (def.role !== p.role) return 'Wrong role.';
  if (inGrace(p)) return 'Conversion grace period.';
  if (p.lockedOutUntil && now < p.lockedOutUntil) return 'Locked out.';
  if (onCooldown(p)) return `Cooldown ${Math.ceil((p.cooldownUntil - now) / 1000)}s.`;
  // Only the same power is barred while it runs. This used to bar every
  // power for the whole duration, which meant casting Go quiet greyed out
  // your entire hand for three minutes — a far longer blanking period than
  // the cooldown that was deliberately removed, and the thing people were
  // actually running into. Charge is the limiter; nothing else needs to be.
  if (def.running && def.running(p, now)) return `${def.label} is already running.`;
  if (currentCharge(p) < def.cost()) return `Needs ${def.cost()} charge.`;
  if (def.guard) { const g = def.guard(); if (g) return g; }
  if (def.target !== 'hider' && !myPos) return 'No GPS fix yet.';
  return null;
}

// ---------- Activation ----------

async function activatePower(key, ctx) {
  const def = POWERS[key];
  const p = me();
  const blocked = powerBlockedReason(key, p);
  if (blocked) { toast(blocked); return false; }

  const paid = await spendCharge(def.cost());
  if (!paid) { toast('Not enough charge.'); return false; }

  try {
    await def.run(ctx || {});
  } catch (e) {
    console.error('power failed', key, e);
    toast('That power failed — charge was still spent.');
    return false;
  }
  return true;
}

// Entry point from the UI: resolves targeting first, then activates.
function requestPower(key) {
  const def = POWERS[key];
  const blocked = powerBlockedReason(key, me());
  if (blocked) { toast(blocked); return; }

  if (def.target === 'point') {
    beginMapTargeting(`Tap the map to aim ${def.label}`, (point) => activatePower(key, { point }));
  } else if (def.target === 'bearing') {
    beginMapTargeting(`Tap the direction the ${def.label.toLowerCase()} should walk`, (point) => {
      activatePower(key, { bearing: bearingDeg(myPos, point) });
    });
  } else if (def.target === 'hider') {
    const options = Object.entries(playersState)
      .filter(([, p]) => p.role === 'hider' && p.status === 'active')
      .map(([id, p]) => ({ id, label: p.name }));
    if (!options.length) { toast('No active hiders.'); return; }
    beginPlayerTargeting(def.label, options, (targetId) => activatePower(key, { targetId }));
  } else {
    activatePower(key);
  }
}
