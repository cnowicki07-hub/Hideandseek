// Tier 2 — every power from design doc Section 5.
//
// Each power declares its role, cost source, and how it is targeted. Powers
// that only reveal information resolve locally on the activating player's
// client (`localReveal`) and are never written into anyone else's visible
// state. Powers that affect another player write a field onto that player's
// doc, which their own client reads and obeys.

// Temporary, client-local reveals. Never synced.
const reveals = {
  scan: null,       // { points: [{lat,lng,name}], expiresAt }
  probe: null,      // { lat, lng, radiusM, hit, expiresAt }
  backtrace: null,  // { lat, lng, bearing, name, expiresAt }
  sweep: null,      // { expiresAt }
  disarm: null,     // { points: [{lat,lng}], expiresAt }
  snitch: null,     // { entries: [...], expiresAt }  (Tier 4)
};

function revealActive(key, now) {
  const r = reveals[key];
  return !!(r && (now || Date.now()) < r.expiresAt);
}

const POWERS = {
  // ---------- Hider loadout ----------
  smear: {
    role: 'hider', loadout: true, label: 'Smear',
    desc: 'Your next ping shows seekers a wide wedge instead of a dot. They learn roughly which way you are, but not where.',
    cost: () => CONFIG.hiderPowers.smear.cost,
    target: 'self',
    async run() {
      await playerRef().update({ pendingPingMod: 'smear', activePower: 'smear', activePowerExpiresAt: 0 });
      toast('Smear armed — your next ping reports as an arc.');
    },
  },

  false_trail: {
    role: 'hider', loadout: true, label: 'False trail',
    desc: 'If a seeker checks which way you were heading, they get a wrong answer for the next 5 minutes.',
    cost: () => CONFIG.hiderPowers.false_trail.cost,
    target: 'self',
    async run() {
      const real = travelBearing(me());
      // Point somewhere plausibly wrong: 90–270° off the true heading.
      const offset = 90 + Math.random() * 180;
      const fake = ((real == null ? Math.random() * 360 : real) + offset) % 360;
      const until = Date.now() + CONFIG.hiderPowers.false_trail.durationMs;
      await playerRef().update({
        falseTrailUntil: until, falseTrailBearing: fake,
        activePower: 'false_trail', activePowerExpiresAt: until,
      });
      toast('False trail active.');
    },
  },

  disarm: {
    role: 'hider', loadout: true, label: 'Disarm',
    desc: 'Finds and destroys any hidden seeker traps within 50m of you. Use it before crossing a gate or a bridge.',
    cost: () => CONFIG.hiderPowers.disarm.cost,
    target: 'self',
    async run() {
      const radius = CONFIG.hiderPowers.disarm.radiusM;
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
      toast(found.length ? `Destroyed ${found.length} tripwire(s).` : 'No tripwires within 50m.');
      renderWorld();
    },
  },

  go_quiet: {
    role: 'hider', loadout: true, label: 'Go quiet',
    desc: 'Skips your next position report entirely. Seekers just see your old circle growing — it looks like your phone lost signal.',
    cost: () => CONFIG.hiderPowers.go_quiet.cost,
    target: 'self',
    async run() {
      await playerRef().update({ pendingPingMod: 'go_quiet', activePower: 'go_quiet', activePowerExpiresAt: 0 });
      toast('Go quiet armed — your next ping will be skipped.');
    },
  },

  uncloak: {
    role: 'hider', loadout: true, label: 'Uncloak',
    desc: 'Drags any hidden seeker within 300m back into view for a minute. Use it when you think one is creeping up on you.',
    cost: () => CONFIG.hiderPowers.uncloak.cost,
    target: 'self',
    async run() {
      const now = Date.now();
      const { radiusM, forceBroadcastMs } = CONFIG.hiderPowers.uncloak;
      let hits = 0;
      const writes = [];
      Object.entries(playersState).forEach(([id, p]) => {
        if (p.role !== 'seeker' || p.status !== 'active') return;
        if (!isSeekerDark(p, now) || !p.realLat) return;
        if (distanceM(myPos, { lat: p.realLat, lng: p.realLng }) > radiusM) return;
        hits++;
        writes.push(playerRef(id).update({ forcedBroadcastUntil: now + forceBroadcastMs }));
        writes.push(pushEvent({ type: 'uncloaked', to: id }));
      });
      await Promise.all(writes);
      // Uncloak also lights those seekers up for you while they are forced out.
      reveals.sweep = { expiresAt: now + forceBroadcastMs };
      toast(hits ? `Uncloaked ${hits} seeker(s).` : 'No dark seekers within 300m.');
    },
  },

  read_the_sweep: {
    role: 'hider', loadout: true, label: 'Read the sweep',
    desc: 'Shows you where the seekers are, and how much ground they can see, for 30 seconds. Your one look at the board.',
    cost: () => CONFIG.hiderPowers.read_the_sweep.cost,
    target: 'self',
    async run() {
      const ms = CONFIG.hiderPowers.read_the_sweep.durationMs;
      reveals.sweep = { expiresAt: Date.now() + ms };
      await playerRef().update({ activePower: 'read_the_sweep', activePowerExpiresAt: Date.now() + ms });
      toast('Reading the sweep.');
      renderWorld();
    },
  },

  silent_run: {
    role: 'hider', loadout: true, label: 'Silent run',
    desc: 'Move for 3 minutes without reporting your position more often. Normally moving makes you ping faster — this is how you relocate safely.',
    cost: () => CONFIG.hiderPowers.silent_run.cost,
    target: 'self',
    async run() {
      const until = Date.now() + CONFIG.hiderPowers.silent_run.durationMs;
      await playerRef().update({
        silentRunUntil: until, activePower: 'silent_run', activePowerExpiresAt: until,
      });
      toast('Silent run — move freely without the faster ping rate.');
    },
  },

  decoy: {
    role: 'hider', loadout: true, label: 'Decoy',
    desc: 'A fake you walks off in a direction you pick, while your real position stops being reported for 3 minutes.',
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

  // ---------- Seeker ----------
  probe: {
    role: 'seeker', label: 'Probe',
    desc: 'Ask whether any hider is inside a 100m circle you tap on the map. Yes or no, nothing more. Cheap way to rule ground out.',
    cost: () => CONFIG.seekerPowers.probe.cost,
    target: 'point',
    async run(ctx) {
      const radiusM = CONFIG.seekerPowers.probe.radiusM;
      const hit = Object.values(playersState).some((p) =>
        p.role === 'hider' && p.status === 'active' && p.realLat &&
        distanceM(ctx.point, { lat: p.realLat, lng: p.realLng }) <= radiusM);
      reveals.probe = { ...ctx.point, radiusM, hit, expiresAt: Date.now() + 30000 };
      toast(hit ? 'Probe: hider present.' : 'Probe: nobody there.');
      renderWorld();
    },
  },

  backtrace: {
    role: 'seeker', label: 'Backtrace',
    desc: "Shows which direction a chosen hider was last moving. Tells you where to cut them off, not where they are.",
    cost: () => CONFIG.seekerPowers.backtrace.cost,
    target: 'hider',
    async run(ctx) {
      const t = playersState[ctx.targetId];
      const bearing = backtraceBearing(t);
      if (bearing == null) {
        toast(`${t.name} has not pinged twice yet — no heading.`);
        return;
      }
      reveals.backtrace = {
        lat: t.broadcastLat, lng: t.broadcastLng, bearing, name: t.name,
        expiresAt: Date.now() + CONFIG.seekerPowers.backtrace.displayMs,
      };
      toast(`${t.name} heading ${Math.round(bearing)}°.`);
      renderWorld();
    },
  },

  tripwire: {
    role: 'seeker', label: 'Tripwire',
    desc: 'Leaves a hidden trap where you stand. If a hider passes within 20m it alerts you and tells you exactly where they were.',
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

  go_dark: {
    role: 'seeker', label: 'Go dark',
    desc: "Stops broadcasting your own position for 3 minutes, so hiders using Read the Sweep can't see you coming.",
    cost: () => CONFIG.seekerPowers.go_dark.cost,
    target: 'self',
    async run() {
      const until = Date.now() + CONFIG.seekerPowers.go_dark.durationMs;
      await playerRef().update({
        darkUntil: until, forcedBroadcastUntil: 0,
        broadcastLat: null, broadcastLng: null,
        activePower: 'go_dark', activePowerExpiresAt: until,
      });
      toast('Dark.');
    },
  },

  lockout: {
    role: 'seeker', label: 'Lockout',
    desc: 'Stops one hider using any of their powers for 3 minutes. Use it on someone you are closing in on.',
    cost: () => CONFIG.seekerPowers.lockout.cost,
    target: 'hider',
    async run(ctx) {
      const until = Date.now() + CONFIG.seekerPowers.lockout.durationMs;
      await playerRef(ctx.targetId).update({ lockedOutUntil: until });
      await pushEvent({ type: 'lockout', to: ctx.targetId });
      toast(`${playersState[ctx.targetId].name} locked out.`);
    },
  },

  scan: {
    role: 'seeker', label: 'Scan',
    desc: 'Instantly reveals the exact position of every hider within 100m of you. One snapshot. Your strongest close-range tool.',
    cost: () => CONFIG.seekerPowers.scan.cost,
    target: 'self',
    async run() {
      const radiusM = CONFIG.seekerPowers.scan.radiusM;
      const points = [];
      Object.values(playersState).forEach((p) => {
        if (p.role !== 'hider' || p.status !== 'active' || !p.realLat) return;
        if (distanceM(myPos, { lat: p.realLat, lng: p.realLng }) > radiusM) return;
        points.push({ lat: p.realLat, lng: p.realLng, name: p.name });
      });
      reveals.scan = {
        points, origin: { ...myPos }, radiusM,
        expiresAt: Date.now() + CONFIG.seekerPowers.scan.displayMs,
      };
      toast(points.length ? `Scan: ${points.length} hider(s).` : 'Scan: nobody within 100m.');
      renderWorld();
    },
  },

  beacon: {
    role: 'seeker', label: 'Beacon',
    desc: 'Lights one hider up permanently for 5 minutes — you see their exact position the whole time. It also spreads to any hider who goes near them.',
    cost: () => CONFIG.seekerPowers.beacon.cost,
    target: 'hider',
    async run(ctx) {
      const until = Date.now() + CONFIG.seekerPowers.beacon.durationMs;
      await playerRef(ctx.targetId).update({ beaconedUntil: until });
      await pushEvent({ type: 'beacon', to: ctx.targetId });
      toast(`${playersState[ctx.targetId].name} beaconed.`);
    },
  },

  cordon: {
    role: 'seeker', label: 'Cordon',
    desc: 'Drops a 150m ring for 5 minutes. Any hider caught inside is forced to report their position constantly until they get out.',
    cost: () => CONFIG.seekerPowers.cordon.cost,
    target: 'point',
    async run(ctx) {
      const cfg = CONFIG.seekerPowers.cordon;
      await gameRef().collection('cordons').add({
        placedBy: playerId, lat: ctx.point.lat, lng: ctx.point.lng,
        radiusM: cfg.radiusM, expiresAt: Date.now() + cfg.durationMs,
      });
      toast('Cordon dropped.');
    },
  },

  totem: {
    role: 'seeker', label: 'Totem',
    desc: 'Places a permanent watchtower anywhere on the map. It reports, anonymously, whenever a hider is inside it. Two hiders working together can destroy it.',
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
};

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
  if (def.loadout && p.lockedOutUntil && now < p.lockedOutUntil) return 'Locked out.';
  if (def.loadout && p.loadout && !p.loadout.includes(key)) return 'Not in your loadout.';
  if (onCooldown(p)) return `Cooldown ${Math.ceil((p.cooldownUntil - now) / 1000)}s.`;
  if (p.activePower && p.activePowerExpiresAt > now) return 'Another power is active.';
  if (p.pendingPingMod) return 'Another power is armed.';
  if (currentCharge(p) < def.cost()) return `Needs ${def.cost()} charge.`;
  if (def.guard) { const g = def.guard(); if (g) return g; }
  if (def.target !== 'point' && def.target !== 'hider' && !myPos) return 'No GPS fix yet.';
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
    beginMapTargeting(`Tap the map to place ${def.label}`, (point) => activatePower(key, { point }));
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

// ---------- Cordon ----------

function isInsideActiveCordon(pos, now) {
  now = now || Date.now();
  return Object.values(cordonsState).some((c) =>
    now < c.expiresAt && distanceM(pos, { lat: c.lat, lng: c.lng }) <= c.radiusM);
}
