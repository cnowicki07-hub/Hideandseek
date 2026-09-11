// Solo — the living-room game with nobody else in the room.
//
// The other players are ordinary players. They have documents, charge,
// capture codes, trails and scores like anyone else; what they do not have
// is a phone. So the one client that is open drives them: it walks their
// tokens, spends their charge and writes their positions, on the same rules
// and through the same functions everyone else goes through.
//
// The thing that matters most here is that a bot must not cheat, and the
// temptation is everywhere — this client is holding every true position in
// memory. So a bot seeker reads exactly what a real seeker reads: the dots
// on a hider's document, which somebody had to pay for. It does not look at
// realLat until it is close enough that a person would have line of sight.
// A bot hider knows only that it has been pinged, because that is all the
// game tells a hider.

function soloGame() { return !!(gameState && gameState.solo); }

// Bot state that belongs to this client, not to the game: where a bot is
// walking, what it thinks it knows, when it last acted. None of it is
// written down, because none of it is anybody else's business.
const botMinds = {};

function botIds() {
  return Object.keys(playersState).filter((id) => id.startsWith('bot_'));
}

function mindFor(id) {
  if (!botMinds[id]) {
    botMinds[id] = {
      dest: null,            // where the token is walking
      leads: {},             // hiderId -> { lat, lng, at } read off public dots
      seenDotAt: {},         // the last dot this bot has already reacted to
      lastThoughtAt: 0,
      lastPingedAt: 0,
      nextChatAt: Date.now() + 30000 + Math.random() * 60000,
      declaredAt: 0,
    };
  }
  return botMinds[id];
}

// ---------- making them ----------

async function spawnBots(count, humanRole) {
  const names = CONFIG.solo.names.slice();
  const n = Math.min(count, CONFIG.solo.maxBots);
  const writes = [];
  for (let i = 0; i < n; i++) {
    const id = 'bot_' + i;
    writes.push(gameRef().collection('players').doc(id).set({
      name: names[i % names.length],
      isHost: false,
      isBot: true,
      role: null,
      status: 'active',
      captureCode: newCaptureCode(),
      chargeCheckpoint: CONFIG.charge.cap,
      chargeCheckpointAt: Date.now(),
      cooldownUntil: 0,
      activePower: null, activePowerExpiresAt: 0,
      realLat: null, realLng: null, realUpdatedAt: null,
      pings: [],
      goQuietUntil: 0, decoy: null, lockedOutUntil: 0,
      huntedBy: {}, activeHunt: null, snitchUsedAt: 0,
      outOfBoundsReadings: 0, breachStartedAt: 0,
      declaredHiddenAt: null,
      tauntScore: 0, tauntCooldownUntil: 0,
      track: [],
      closedAt: 0, pingDebt: 0, nextDebtPingAt: 0, awayTotalMs: 0,
      survivalMs: null, endedAt: null,
      lastContactAt: Date.now(), joinedAt: Date.now(),
    }));
  }
  await Promise.all(writes);
  await assignSoloRoles(humanRole);
}

// The human picks their side; the bots fill the other one, with at least one
// of each so there is a game.
async function assignSoloRoles(humanRole) {
  const ids = botIds().length ? botIds()
    : Array.from({ length: CONFIG.solo.maxBots }, (_, i) => 'bot_' + i);
  const bots = ids.filter((id) => playersState[id]);
  const others = humanRole === 'seeker' ? 'hider' : 'seeker';
  const writes = [playerRef().update({ role: humanRole })];

  if (humanRole === 'hider') {
    // One or two seekers, the rest hiding alongside you.
    const seekers = Math.max(1, Math.round(bots.length / 3));
    bots.forEach((id, i) => writes.push(
      playerRef(id).update({ role: i < seekers ? 'seeker' : 'hider' })));
  } else {
    bots.forEach((id) => writes.push(playerRef(id).update({ role: others })));
  }
  await Promise.all(writes);
}

// ---------- walking ----------

function botStep(id, mind, now) {
  const p = playersState[id];
  if (!p || p.status !== 'active') return null;
  const from = (p.realLat != null) ? { lat: p.realLat, lng: p.realLng } : null;
  if (!from) return null;
  if (!mind.dest) return from;

  const stepMs = Math.min(3000, now - (mind.lastStepAt || now));
  mind.lastStepAt = now;
  const reach = (LIVING_ROOM.travelSpeedMps * stepMs) / 1000;
  const gap = distanceM(from, mind.dest);
  if (gap <= reach) { mind.dest = null; return { ...mind.dest || from }; }
  return destinationPoint(from, bearingDeg(from, mind.dest), reach);
}

function somewhereInside(near, spreadM) {
  const b = gameState.boundary;
  const centre = polygonCentroid(b);
  for (let i = 0; i < 30; i++) {
    const candidate = randomPointInRadius(near || centre, spreadM);
    if (pointInPolygon(candidate, b)) return candidate;
  }
  return centre;
}

// Straight away from a threat, but kept inside the boundary — a bot that
// walks itself into a breach countdown is not playing, it is losing.
function awayFrom(here, threat, distM) {
  const b = gameState.boundary;
  const base = bearingDeg(threat, here);
  for (let turn = 0; turn <= 180; turn += 30) {
    for (const sign of [1, -1]) {
      const candidate = destinationPoint(here, base + sign * turn, distM);
      if (pointInPolygon(candidate, b)) return candidate;
    }
  }
  return somewhereInside(here, distM);
}

// ---------- a bot that seeks ----------
//
// It reads the same dots a person would, off the public documents, and it
// pays for every one of them.

function refreshLeads(mind, now) {
  Object.entries(playersState).forEach(([id, p]) => {
    if (p.role !== 'hider' || p.status !== 'active') return;
    const dots = p.pings || [];
    const last = dots[dots.length - 1];
    if (!last) return;
    if (mind.seenDotAt[id] === last.at) return;
    mind.seenDotAt[id] = last.at;
    mind.leads[id] = { lat: last.lat, lng: last.lng, at: last.at };
  });
  Object.keys(mind.leads).forEach((id) => {
    const lead = mind.leads[id];
    const target = playersState[id];
    if (!target || target.status !== 'active' || now - lead.at > CONFIG.solo.leadTrustMs) {
      delete mind.leads[id];
    }
  });
}

function freshestLead(mind) {
  let best = null;
  Object.entries(mind.leads).forEach(([id, lead]) => {
    if (!best || lead.at > best.lead.at) best = { id, lead };
  });
  return best;
}

async function botSpend(id, cost) {
  const p = playersState[id];
  if (!p || p.status !== 'active') return false;
  if (!gameState || gameState.status !== 'active' || isPaused()) return false;
  if (inGrace(p) || (p.lockedOutUntil && Date.now() < p.lockedOutUntil)) return false;
  const have = currentCharge(p);
  if (have < cost) return false;
  if (onCooldown(p)) return false;
  await playerRef(id).update({
    chargeCheckpoint: have - cost,
    chargeCheckpointAt: Date.now(),
    cooldownUntil: Date.now() + CONFIG.charge.globalCooldownMs,
  });
  return true;
}

// The same sweep a person gets for the same price, run from the bot's own
// position through the same emitPing — so Go quiet and Decoy answer it, the
// dots carry the usual error, and the human watches them appear.
async function botProbe(id, at, towards) {
  if (!(await botSpend(id, CONFIG.seekerPowers.probe.cost))) return 0;
  const half = CONFIG.seekerPowers.probe.halfWidthDeg;
  const sweep = bearingDeg(at, towards);
  let hits = 0;
  for (const [hid, h] of Object.entries(playersState)) {
    if (hid === id || h.role !== 'hider' || h.status !== 'active' || !h.realLat) continue;
    const toThem = bearingDeg(at, { lat: h.realLat, lng: h.realLng });
    if (angleDifference(toThem, sweep) > half) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await emitPing(hid, { lat: h.realLat, lng: h.realLng })) hits++;
  }
  return hits;
}

// A Scan gives a direction and nothing else. The bot gets exactly that: a
// bearing per hider, no distance, which is only enough to choose which half
// of the room to spend a Probe on.
async function botScan(id, at) {
  if (!(await botSpend(id, CONFIG.seekerPowers.scan.cost))) return null;
  const bearings = Object.values(playersState)
    .filter((p) => p.role === 'hider' && p.status === 'active' && p.realLat)
    .map((p) => bearingDeg(at, { lat: p.realLat, lng: p.realLng }));
  if (!bearings.length) return null;
  return bearings[Math.floor(Math.random() * bearings.length)];
}

async function thinkAsSeeker(id, mind, now) {
  const p = playersState[id];
  // Held at the start line exactly like a person is. Driving bots from this
  // client means none of powerBlockedReason's gates apply to them by
  // default, so the ones that matter have to be stated here — the first
  // run of this mode had bot seekers probing through the whole head start.
  if (isHiding() || inGrace(p) || (p.lockedOutUntil && now < p.lockedOutUntil)) return;
  const at = { lat: p.realLat, lng: p.realLng };
  refreshLeads(mind, now);

  // Close enough to see them: that is the one time a bot is allowed to look
  // at a true position, and it is the same line of sight a person would have.
  const reach = CONFIG.solo.captureRadiusM;
  for (const [hid, h] of Object.entries(playersState)) {
    if (h.role !== 'hider' || h.status !== 'active' || !h.realLat) continue;
    if (distanceM(at, { lat: h.realLat, lng: h.realLng }) <= reach) {
      await confirmCapture(hid);
      mind.dest = null;
      return;
    }
  }

  const best = freshestLead(mind);
  if (best) {
    // Walk at the dot. It is up to 30m out and minutes old, so this is a
    // search, not an interception.
    mind.dest = { lat: best.lead.lat, lng: best.lead.lng };
    if (distanceM(at, mind.dest) < 40 && currentCharge(p) >= CONFIG.seekerPowers.probe.cost) {
      await botProbe(id, at, mind.dest);
    }
    return;
  }

  // Nothing to go on. A tripwire is almost free and the only exact reading
  // in the game, so lay one wherever it happens to be standing before
  // spending on anything bigger.
  const spare = currentCharge(p) - CONFIG.solo.seekerReserve;
  if (spare >= CONFIG.seekerPowers.tripwire.cost * 3 && Math.random() < 0.3) {
    if (await botSpend(id, CONFIG.seekerPowers.tripwire.cost)) {
      await gameRef().collection('tripwires').add({
        placedBy: id, lat: at.lat, lng: at.lng, triggered: false, placedAt: now,
      });
      return;
    }
  }
  if (spare >= CONFIG.seekerPowers.probe.cost) {
    const towards = mind.sweepBearing != null
      ? destinationPoint(at, mind.sweepBearing, 400)
      : somewhereInside(at, 250);
    mind.sweepBearing = null;
    await botProbe(id, at, towards);
    return;
  }
  if (spare >= CONFIG.seekerPowers.scan.cost && mind.sweepBearing == null) {
    mind.sweepBearing = await botScan(id, at);
    return;
  }
  if (!mind.dest) mind.dest = somewhereInside(at, 180);
}

// ---------- a bot that hides ----------
//
// It knows one thing: whether it has just been pinged. That is all the game
// tells a hider, so it is all the bot gets. It never reads where a seeker
// is unless it pays for a Seeker scan like anybody else.

const BOT_CHAT = [
  'seeker went past me',
  'anyone near the north corner?',
  'holding still for a bit',
  'that was close',
  'moving, they pinged me',
  'good luck',
];

async function thinkAsHider(id, mind, now) {
  const p = playersState[id];
  const at = { lat: p.realLat, lng: p.realLng };

  if (isHiding()) {
    if (!p.declaredHiddenAt) {
      // Get some distance first, then say you are set.
      if (!mind.dest) mind.dest = somewhereInside(at, 160);
      if (!mind.declaredAt) mind.declaredAt = now + 4000 + Math.random() * 6000;
      if (now >= mind.declaredAt) {
        await playerRef(id).update({ declaredHiddenAt: now });
      }
    }
    return;
  }

  // Was I just found out? The dot on my own document is the only signal.
  const dots = p.pings || [];
  const last = dots[dots.length - 1];
  if (last && mind.seenDotAt.self !== last.at) {
    mind.seenDotAt.self = last.at;
    mind.lastPingedAt = last.at;
  }
  // How rattled is it? One reading is a seeker guessing; two in quick
  // succession is a seeker working your patch, and that is when a person
  // actually runs.
  if (mind.lastPingedAt > (mind.countedPingAt || 0)) {
    mind.countedPingAt = mind.lastPingedAt;
    mind.pingRun = (now - (mind.prevPingAt || 0) < 60000) ? (mind.pingRun || 0) + 1 : 1;
    mind.prevPingAt = mind.lastPingedAt;
    // People do not react in the same beat every time.
    mind.reactAt = now + CONFIG.solo.reactMs + Math.random() * 5000;
  }
  const recentlyPinged = now - mind.lastPingedAt < 45000;
  const reacting = recentlyPinged && mind.reactAt && now >= mind.reactAt;

  if (reacting && !mind.reactedTo) {
    mind.reactedTo = mind.lastPingedAt;
    const charge = currentCharge(p);
    const hunted = (mind.pingRun || 1) > 1;

    // The first reading often does not move anybody. Standing still is
    // genuinely safe in this game — nothing reports you for it — and a bot
    // that sprints 200m off every single ping is not playing like a person,
    // it is playing perfectly. That made the seeker's last thirty metres
    // impossible to close.
    if (!hunted && Math.random() < 0.55) {
      mind.dest = null;              // sit tight and hope
      return;
    }

    // Spend on cover if it can, then move — a dot is only worth anything to
    // a seeker while you are still near it.
    if (charge >= CONFIG.hiderPowers.decoy.cost && Math.random() < 0.5) {
      if (await botSpend(id, CONFIG.hiderPowers.decoy.cost)) {
        const until = now + CONFIG.hiderPowers.decoy.durationMs;
        await playerRef(id).update({
          decoy: {
            originLat: at.lat, originLng: at.lng,
            bearing: Math.random() * 360, startedAt: now, expiresAt: until,
          },
          activePower: 'decoy', activePowerExpiresAt: until,
        });
      }
    } else if (charge >= CONFIG.hiderPowers.go_quiet.cost) {
      if (await botSpend(id, CONFIG.hiderPowers.go_quiet.cost)) {
        const until = now + CONFIG.hiderPowers.go_quiet.durationMs;
        await playerRef(id).update({
          goQuietUntil: until, activePower: 'go_quiet', activePowerExpiresAt: until,
        });
      }
    }
    // A short shuffle if it is only mildly worried, a proper run if it is
    // being hunted down.
    mind.dest = somewhereInside(at, hunted ? 230 : 90);
    return;
  }
  if (!recentlyPinged) { mind.reactedTo = null; mind.pingRun = 0; }

  // Otherwise: drift, and get out of the way of anything it has actually
  // been shown. A seeker's trail is public once somebody pays for it.
  const seen = Object.values(playersState)
    .filter((s) => s.role === 'seeker' && s.status === 'active' && (s.pings || []).length)
    .map((s) => s.pings[s.pings.length - 1])
    .filter((d) => now - d.at < 2 * 60000)
    .sort((a, b) => distanceM(at, a) - distanceM(at, b))[0];
  if (seen && distanceM(at, seen) < 150) {
    mind.dest = awayFrom(at, seen, 200);
    return;
  }
  if (!mind.dest) mind.dest = somewhereInside(at, 140);

  // Flavour, on a long fuse: a firework, or a word to the other hiders.
  if (now >= mind.nextChatAt) {
    mind.nextChatAt = now + 60000 + Math.random() * 120000;
    if (Math.random() < 0.45 && !(p.tauntCooldownUntil > now)) {
      await playerRef(id).update({
        tauntCooldownUntil: now + CONFIG.taunt.cooldownMs,
        tauntScore: (p.tauntScore || 0) + 1,
      });
      await pushEvent({
        type: 'taunt', name: p.name, message: '',
        lat: at.lat, lng: at.lng,
        shape: FIREWORK_SHAPES[Math.floor(Math.random() * FIREWORK_SHAPES.length)],
        colour: FIREWORK_COLOURS[Math.floor(Math.random() * FIREWORK_COLOURS.length)],
      });
    } else {
      await gameRef().collection('chat').add({
        from: id, name: p.name, at: now,
        text: BOT_CHAT[Math.floor(Math.random() * BOT_CHAT.length)],
      });
    }
  }
}

// ---------- the loop ----------
//
// Run from the human's rules tick, because theirs is the only client there
// is. Positions are written on the same throttle a real phone uses, so the
// traffic and the replay track look like an ordinary game.

let lastBotWriteAt = {};

async function tickBots(now) {
  if (!soloGame()) return;
  if (!gameState || (gameState.status !== 'active' && gameState.status !== 'hiding')) return;
  if (isPaused()) return;

  for (const id of botIds()) {
    const p = playersState[id];
    if (!p || p.status !== 'active' || !p.role) continue;
    const mind = mindFor(id);

    // Walk first, so a decision is made from where the token actually is.
    const moved = botStep(id, mind, now);
    if (moved) {
      const lastAt = lastBotWriteAt[id] || 0;
      const far = p.realLat == null
        || distanceM({ lat: p.realLat, lng: p.realLng }, moved) >= CONFIG.sync.movementThresholdM;
      if (now - lastAt >= CONFIG.sync.keepaliveMs || (far && now - lastAt >= CONFIG.sync.minWriteIntervalMs)) {
        lastBotWriteAt[id] = now;
        const update = {
          realLat: moved.lat, realLng: moved.lng, realUpdatedAt: now, lastContactAt: now,
        };
        const track = trackWith(p, moved, now);
        if (track) update.track = track;
        // eslint-disable-next-line no-await-in-loop
        await playerRef(id).update(update);
      }
    }

    if (now - mind.lastThoughtAt < CONFIG.solo.thinkMs) continue;
    mind.lastThoughtAt = now;
    try {
      // eslint-disable-next-line no-await-in-loop
      if (p.role === 'seeker') await thinkAsSeeker(id, mind, now);
      // eslint-disable-next-line no-await-in-loop
      else await thinkAsHider(id, mind, now);
    } catch (e) {
      console.warn('bot', id, e);
    }
  }
}

// A bot never puts its phone down, so it must say so — otherwise the away
// rules grey it out a couple of minutes into a compressed round.
function botsAreHere(now) {
  if (!soloGame()) return;
  botIds().forEach((id) => {
    const p = playersState[id];
    if (!p || p.status !== 'active') return;
    if (now - (p.lastContactAt || 0) < CONFIG.offline.staleAfterMs / 2) return;
    playerRef(id).update({ lastContactAt: now }).catch(() => {});
  });
}
