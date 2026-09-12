// Central config — every tunable number lives here.
// Matches Section 18 of the design doc. Edit this file to rebalance,
// never hardcode a number elsewhere.
//
// ---------------------------------------------------------------
// How distances scale with the size of the play area
//
// M = sqrt(area), so a 600m square is M = 600. The same game gets played on
// a school field (M ~ 150) and across a country estate (M ~ 2000), and a
// number that is right at one is wrong at the other. Three kinds of number
// live below, and they are treated differently on purpose:
//
//   FIXED — anchored to a human body or to GPS itself. How far you can see
//   someone, how close you have to stand to share a spot, how much a phone's
//   position wanders. None of this cares how big the map is, so none of it
//   scales. Scaling it would be a lie about the physical world.
//
//   SCALED — about searching a space. A tripwire is a bet on where somebody
//   walks; a ping's error is how much ground you must still cover after you
//   are told where to go. These are quoted at REFERENCE_M and stretched
//   linearly, so they stay the same fraction of the map at any size.
//
//   CLAMPED — every scaled number, at both ends. Linear scaling fails twice.
//   Shrunk far enough, a rule drops below GPS's own error and simply stops
//   working — a 6m tripwire never fires. Grown far enough, it stops being a
//   game: a ping wrong by 75m leaves a seeker 17,000 square metres to walk,
//   which is half an hour for one reading in a ninety-minute round. The
//   floors are set by physics, the ceilings by how long a person will
//   actually spend looking.
// ---------------------------------------------------------------

const REFERENCE_M = 600;

// The current game's M, or the reference if no boundary is set yet.
function activeM() {
  return (typeof M === 'number' && M > 0) ? M : REFERENCE_M;
}

// A distance quoted at REFERENCE_M, stretched to this game and held inside
// its floor and ceiling. `m` is optional and only passed by the lobby, which
// previews these numbers for a boundary that has not been saved yet.
function scaledM(rule, m) {
  const raw = rule.ref * ((m || activeM()) / REFERENCE_M);
  return Math.round(Math.min(rule.max, Math.max(rule.min, raw)));
}

const CONFIG = {
  // FIXED. Consumer GPS on a phone. Everything physical is built on this:
  // it is the sabotage precision radius, the floor under every scaled
  // distance, and the reason no rule is allowed to shrink below it.
  baseAccuracyRadiusM: 10,
  gameLengthMin: 90,
  endConditionMode: 'elimination', // or 'time_limit'

  // How often each client runs its local rules pass (boundary, sabotage,
  // tripwires, totem pings, hunt bearings).
  tickMs: 3000,

  // How often a client pushes its true position to the Durable Object.
  // GPS fires about once a second; writing every fix is roughly 88,000
  // writes for a 90-minute five-player game, and those bytes cross someone's
  // mobile data. Throttling on movement is self-correcting: a position only
  // goes stale while a player is standing still, and a stationary player's
  // last position is still correct.
  sync: {
    minWriteIntervalMs: 5000,   // never write more often than this
    keepaliveMs: 30000,         // ...but always write at least this often
    // FIXED. The GPS noise floor — has this person actually moved, or is the
    // phone wandering? Nothing to do with the size of the map.
    movementThresholdM: 5,
    tickKeepaliveMs: 60000,     // contact heartbeat when GPS is unavailable
  },

  charge: {
    cap: 100,
    // THE PACING NUMBER. Nothing pings on its own any more, so how often
    // anyone can be found is set entirely here. A Probe costs 30, so this
    // regen rate means a seeker can sweep roughly every two minutes.
    // Halve the regen and the game slows down everywhere at once.
    regenPerMs: 1 / 4000, // 1 point every 4 seconds — 15/min
    // No blanking period between powers. Charge is the whole limiter: a
    // minute's enforced silence on top of it only made people miss the moment
    // they were saving for, and the regen rate already decides how often
    // anyone can act.
    globalCooldownMs: 0,
    conversionStartingCharge: 30,
    conversionGraceMs: 60000,
  },

  // Positions are never reported automatically. Every dot on the map was
  // paid for by somebody.
  ping: {
    // A dot's whole life. White at birth, shading to red by the halfway
    // mark, then fading to nothing.
    lifetimeMs: 10 * 60000,
    fadeStartMs: 5 * 60000,
    // SCALED. How wrong a reported position is, rolled fresh each time. Two
    // pings on a player who has not moved an inch can land twice this far
    // apart in unrelated directions — so a still player can look like a
    // moving one, and the trail drawn between their dots lies about which way
    // they went. DISPLAY ONLY: never used for tripwires, sabotage, capture
    // range or boundary checks.
    //
    // This is the single most size-sensitive number in the game, because it
    // decides how much ground is left to search after a ping. The search is
    // an area, so it grows as the square: 30m is ~2,800 m2, five minutes of
    // pushing through scrub; 75m is ~17,000 m2, half an hour. Hence the
    // ceiling. The floor is GPS itself — an error smaller than the phone's
    // own wander is a fiction.
    jitter: { ref: 30, min: 10, max: 45 },
    maxStored: 12, // dots kept per player; comfortably more than a lifetime
    dotRadiusPx: 7,
    trailWidthPx: 3,
  },

  hiderPowers: {
    // DERIVED. A disarm has to clear a corridor, not a point, so it is kept
    // at a fixed multiple of whatever a tripwire covers in this game. Tie
    // them together and the relationship survives every map size.
    disarm: { cost: 15, radiusPerTripwire: 2.5 },
    go_quiet: { cost: 20, durationMs: 3 * 60000 },
    // FIXED pace — a decoy walks like a person. But the distance it can get
    // to is capped as a share of the map: at three km/h a full three minutes
    // is 150m, which is a quarter of a 600m map and the whole of a small one.
    // Without this the decoy strolls out of the play area and the lie stops
    // being believable.
    decoy: { cost: 35, durationMs: 3 * 60000, paceKmh: 3, maxTravelFractionOfM: 0.25 },
    seeker_scan: { cost: 40, displayMs: 20000 },
  },

  seekerPowers: {
    // A 180° sweep from you out to the boundary, pinging everything in that
    // half of the world. Deliberately expensive: it is the most information
    // anyone can buy in one action, and two of them cover the whole map.
    probe: { cost: 30, halfWidthDeg: 90 },
    // Direction only, never position. One coloured glow per player at the
    // screen edge, so it tells you how many and roughly where, and nothing
    // else. Cheap enough to use as the opener before a Probe.
    scan: { cost: 15, displayMs: 25000 },
    // SCALED. A tripwire is a bet on where somebody walks, so it has to stay
    // the same fraction of the ground they might cross. The floor is above
    // GPS error, because a wire narrower than the phone's own wander would
    // fire at random or never; the ceiling stops five charge from buying
    // sixty metres of area denial.
    tripwire: { cost: 5, trigger: { ref: 20, min: 15, max: 60 } },
    // FIXED, with a small-map ceiling. This is eye contact distance: can the
    // seeker plausibly see you? That does not change because the field is
    // bigger, so it never grows. It does shrink on a very small map, where a
    // flat 20m would leave it permanently on and stop meaning anything.
    i_see_you: { radiusM: 20, maxFractionOfM: 0.12 },
    lockout: { cost: 25, durationMs: 3 * 60000 },
    totem: { cost: 60, maxUndeployed: 2, maxLive: 10 },
  },

  // SCALED, all of it. Selling someone out is a question of how well you can
  // make them out from where you stand, which is relative to the ground you
  // are both on. The bands are derived from one number so they cannot drift
  // apart: exact up close, a rough circle further out, nothing at all beyond.
  // The ceiling is a limit on knowing anything useful about a person more
  // than a kilometre away, whatever the map says.
  snitch: {
    cost: 20,
    displayMs: 15000,
    // The floor is set so the bands stay distinguishable rather than
    // collapsing into "everyone is exact" on a small map: at 150 the closest
    // band is 25m and the middle circle is about one GPS error wide.
    wideRange: { ref: 600, min: 150, max: 1200 },
    exactFraction: 1 / 6,     // of the wide range
    mediumFraction: 1 / 2,
    mediumCircleFraction: 1 / 6,  // of the medium range
    wideCircleFraction: 1 / 4,    // of the wide range
  },

  totem: {
    // SCALED, and the original — every other scaled number in this file was
    // brought into line with it. The floor matters: a totem smaller than
    // three GPS errors stops being an area you are inside and collapses into
    // the ten-metre spot you sabotage from, which would make its anonymous
    // report an exact one.
    radiusFraction: 0.126, // fraction of M
    radiusMinM: 30,
    radiusMaxM: 250,
    // ...but the floor itself gives way on a very small map, where a flat 30m
    // totem would swallow a quarter of the ground and two of them would cover
    // everything.
    radiusMaxFractionOfM: 0.25,
    pingIntervalMs: 60000,
    sabotageMinParticipants: 2,
    sabotageDecayRate: 0.5,
    // Sabotage requires participants within the game's base accuracy radius
    // of the totem centre (design doc Section 3, "sabotage precision radius"
    // — never smaller than base GPS accuracy).
    sabotageTimeDivisor: 25, // radius_m / 25 = minutes
    sabotageMaxMin: 10,
    presenceStaleMs: 8000, // a presence heartbeat older than this doesn't count
  },

  hunt: {
    noCaptureCooldownMs: 10 * 60000,
    durationMs: 10 * 60000,
    // A hunt no longer hands out a bearing cone. It pings the hunted hider on
    // this interval instead, starting the moment it is declared — so a hunt
    // is worth four readings over its ten minutes, and every one of them is
    // an ordinary ping that Go quiet and Decoy can answer.
    pingIntervalMs: 3 * 60000,
  },

  signposts: {
    // FIXED. A sign is an object in the world: you find it by walking into
    // it and read it by standing next to it. Both of those are about a
    // person's eyes and a signpost's size, not the map's. Scaled up on a big
    // map, signs would appear from nowhere and the fiction would break —
    // which also means signs get found less often out there, and that is the
    // correct consequence of leaving one somewhere nobody goes.
    //
    // Discovery is per player and never shared, so a sign appearing on your
    // map says nothing about where anyone else has been.
    discoverRadiusM: 10,
    readRadiusM: 18,
    cost: 0,
    maxLength: 120,
  },

  boundary: {
    // SCALED. How much warning you get before you are out. The floor keeps it
    // above GPS wander, so standing still near the edge does not flicker; the
    // ceiling stops a big map from warning you while you are still nowhere
    // near the fence.
    warningZone: { ref: 20, min: 15, max: 50 },
    // The smallest play area the lobby will accept. Below this every scaled
    // rule is sitting on its floor and the distances stop relating to each
    // other at all — a 3m boundary gives a 1m totem. 25m is a back garden,
    // which is already smaller than anything sensible.
    minM: 25,
    breachTimerMs: 3 * 60000,
    confirmReadings: 3, // consecutive out-of-bounds fixes before a breach counts
  },

  headstart: {
    // FIXED: this is how fast a person walks.
    walkingPaceKmh: 3,
    diagonalFraction: 0.5,
    // CLAMPED against the clock, not the map. Half the diagonal of a two
    // kilometre estate is twenty-eight minutes of walking — a third of the
    // round spent with nobody hunting. Nobody waits that long, so the head
    // start is capped as a share of the game and floored so a small map still
    // gives the hiders a moment to get out of sight.
    maxFractionOfGame: 0.2,
    minMs: 2 * 60000,
  },

  // What gets kept for the walk-through at the end. Positions are already
  // throttled on the wire; this is a second, coarser sample kept per player
  // so the end-of-game map can draw where everybody actually went — the only
  // time in the game true movement is ever shown.
  replay: {
    minIntervalMs: 15000,
    maxPoints: 400,   // 400 x 15s is over 90 minutes of walking
  },

  // ---------------------------------------------------------------
  // Solo
  //
  // The living-room game with nobody else in the room. The other players are
  // run by the one client that is open, on the same documents and the same
  // rules — a bot spends charge, gets pinged and can be caught exactly like
  // anybody else, and knows only what the game would have told a person in
  // its position.
  //
  // One rule has to change. Capture is normally a conversation: the hider
  // reads out four letters. There is nobody to read them to, so indoors and
  // alone it becomes proximity, which the tap-to-travel tokens are precise
  // enough to make fair.
  // ---------------------------------------------------------------
  solo: {
    captureRadiusM: 18,
    // How often a bot thinks. Slower than the rules tick on purpose: a bot
    // that reacts instantly to every ping reads as a cheat rather than an
    // opponent.
    thinkMs: 1600,
    // A bot seeker will not spend its last charge; it keeps enough back to
    // answer a lead when one appears.
    seekerReserve: 10,
    // How long a bot seeker trusts a dot before going back to sweeping.
    leadTrustMs: 90000,
    // A bot hider waits this long after being pinged before spending on
    // cover, so it looks like a decision rather than a reflex.
    reactMs: 2500,
    // How often a bot seeker sets out to close more ground down. Between
    // these it plays normally; when one is due it stops taking speculative
    // sweeps and saves, because at 60 a bot that always probes first
    // oscillates between 10 and 40 charge and can never afford one at all.
    // Saving from 10 takes about twenty seconds, so this leaves most of the
    // time for actually hunting.
    totemIntervalMs: 600000,
    // How long a bot will hold off sweeping while it saves for one. It has to
    // be longer than the save actually takes — sixty charge at fifteen a
    // minute is four minutes from empty — or the bot gives up every time and
    // never places anything. Without any limit at all, a bot whose income is
    // going elsewhere saves for a totem it can never afford and stops
    // hunting entirely.
    maxSaveMs: 300000,
    // Wires are cheap, but cheap is not free: at five charge every twenty
    // seconds a bot was spending its entire income on them and never
    // affording anything else. Paced against the regen rate instead, they
    // cost well under a fifth of what comes in.
    wireIntervalMs: 120000,
    maxWires: 5,
    maxBots: 7,
    names: ['Wren', 'Ash', 'Fen', 'Mox', 'Pike', 'Juno', 'Rook'],
  },

  // Bravado. Costs no charge, because charge buys information and this buys
  // nothing — it is a firework, it lasts five seconds, and it leaves nothing
  // behind. The cooldown is the only limiter, and it exists so a taunt stays
  // an event rather than a strobe.
  taunt: {
    cooldownMs: 30000,
    durationMs: 5000,
  },

  // Hiders can talk to each other. Seekers cannot see it — client-enforced,
  // like every other rule in this build.
  chat: {
    maxLength: 160,
    maxMessages: 120,
  },

  // Events are a push channel, not a history. Anything older than the window
  // handleEvents will look at is dead weight that a reconnecting client still
  // has to download, so the conductor clears it out.
  events: {
    keepMs: 5 * 60000,
    pruneIntervalMs: 60000,
  },

  // Phones get closed — deliberately, to save battery, or because they lock
  // themselves in a pocket. A closed phone stops reporting, so everything
  // anyone knows about that player goes stale. None of this is free.
  offline: {
    // Said nothing for this long and you are treated as closed, whether or
    // not you pressed the button. Positions write at least every 30s and the
    // tick heartbeats every 60s, so this only trips on a genuinely dark phone.
    staleAfterMs: 90000,
    // The debt: one owed position report per full minute unavailable...
    debtPerMs: 60000,
    // ...paid off at this rate once you are back. Going dark for five minutes
    // costs you five dots over the two and a half minutes after you return.
    debtPingIntervalMs: 30000,
    // A dead battery should not buy an hour of exposure on return.
    maxDebt: 20,
    // Unavailable this long and you are greyed out of the game until the host
    // puts you back.
    awayAfterMs: 15 * 60000,
  },
};

// ---------------------------------------------------------------
// Living-room mode
//
// GPS cannot work indoors: a living room is a few metres across, indoor
// position error is tens of metres, and often there is no fix at all. So
// indoors the game swaps real walking for tap-to-travel — you pick a
// destination and your token walks there at speed. Travel time is what makes
// the game work, so it is kept, just compressed.
//
// Everything else is identical: the same dots, powers, totems, hunts and
// sabotage, on a round that fits in about ten minutes.
// ---------------------------------------------------------------

const LIVING_ROOM = {
  travelSpeedMps: 28,      // virtual metres per real second
  timeScale: 9,            // 90-minute game becomes 10
  gameLengthMin: 10,
  defaultAreaSideM: 400,
  hidingSeconds: 45,
};

// Applied over CONFIG once, after the game's mode is known. The list is
// explicit rather than a recursive walk, so it is obvious what changes and
// what deliberately does not.
function applyGameMode(mode) {
  if (mode !== 'livingroom' || CONFIG._mode === 'livingroom') return;
  const t = LIVING_ROOM.timeScale;
  const shorter = (ms) => Math.round(ms / t);

  CONFIG._mode = 'livingroom';
  CONFIG.gameLengthMin = LIVING_ROOM.gameLengthMin;

  // Positions must sync faster, because tokens cover ground far quicker than
  // people do. A ten-minute round makes the extra traffic irrelevant.
  CONFIG.sync.minWriteIntervalMs = 1200;
  CONFIG.sync.keepaliveMs = 6000;
  CONFIG.sync.movementThresholdM = 12;
  CONFIG.tickMs = 1000;

  // A dot that outlives the round tells you nothing, so the trail is
  // compressed with everything else.
  CONFIG.ping.lifetimeMs = shorter(CONFIG.ping.lifetimeMs);
  CONFIG.ping.fadeStartMs = shorter(CONFIG.ping.fadeStartMs);

  CONFIG.charge.regenPerMs *= t;
  CONFIG.charge.globalCooldownMs = shorter(CONFIG.charge.globalCooldownMs);
  CONFIG.charge.conversionGraceMs = shorter(CONFIG.charge.conversionGraceMs);

  [CONFIG.hiderPowers, CONFIG.seekerPowers].forEach((table) => {
    Object.values(table).forEach((power) => {
      if (power && typeof power.durationMs === 'number') power.durationMs = shorter(power.durationMs);
      if (power && typeof power.displayMs === 'number') power.displayMs = shorter(power.displayMs);
    });
  });

  CONFIG.totem.pingIntervalMs = shorter(CONFIG.totem.pingIntervalMs);
  CONFIG.totem.sabotageTimeDivisor *= t;
  CONFIG.totem.sabotageMaxMin /= t;
  // Tokens are precise, unlike GPS, so standing on a totem can mean it.
  CONFIG.totem.sabotageOverrideRadiusM = 12;

  CONFIG.hunt.noCaptureCooldownMs = shorter(CONFIG.hunt.noCaptureCooldownMs);
  CONFIG.hunt.durationMs = shorter(CONFIG.hunt.durationMs);
  CONFIG.hunt.pingIntervalMs = shorter(CONFIG.hunt.pingIntervalMs);

  // Deliberately NOT scaled: staleAfterMs and debtPingIntervalMs are about how
  // long a real phone takes to lock and how fast a person reads their screen,
  // neither of which cares that the round is ten minutes long. The two that
  // are about game time do scale.
  // A compressed round needs the ground closing down faster too, or a
  // ten-minute game ends before the second totem goes up.
  CONFIG.solo.totemIntervalMs = shorter(CONFIG.solo.totemIntervalMs);
  CONFIG.solo.maxSaveMs = shorter(CONFIG.solo.maxSaveMs);
  CONFIG.solo.wireIntervalMs = shorter(CONFIG.solo.wireIntervalMs);
  CONFIG.solo.leadTrustMs = shorter(CONFIG.solo.leadTrustMs);

  CONFIG.offline.debtPerMs = shorter(CONFIG.offline.debtPerMs);
  CONFIG.offline.awayAfterMs = shorter(CONFIG.offline.awayAfterMs);

  CONFIG.boundary.breachTimerMs = shorter(CONFIG.boundary.breachTimerMs);

  // Deliberately NOT scaled: the offline timers. Someone whose phone drops
  // out for 90 seconds shouldn't be eliminated mid-round.
  CONFIG.livingRoom = LIVING_ROOM;
}

// M = sqrt(boundary area). Set once the host draws/enters the play area.
function computeM(areaM2) {
  return Math.sqrt(areaM2);
}

// ---------- the scaled distances, one accessor each ----------

function totemRadiusM(m) {
  const t = CONFIG.totem;
  const size = m || activeM();
  const floor = Math.min(t.radiusMinM, t.radiusMaxFractionOfM * size);
  return Math.round(Math.min(t.radiusMaxM,
    Math.max(floor, t.radiusFraction * size)));
}

// How wrong every reported position is in this game.
function pingJitterM(m) { return scaledM(CONFIG.ping.jitter, m); }

// How wide a tripwire's net is, and how much ground one disarm clears.
function tripwireRadiusM(m) { return scaledM(CONFIG.seekerPowers.tripwire.trigger, m); }
function disarmRadiusM(m) {
  return Math.round(tripwireRadiusM(m) * CONFIG.hiderPowers.disarm.radiusPerTripwire);
}

// How close to the fence you are warned.
function boundaryWarningZoneM(m) { return scaledM(CONFIG.boundary.warningZone, m); }

// Never grows past eye-contact distance; shrinks only on a map too small for
// twenty metres to mean anything.
function iSeeYouRadiusM(m) {
  const c = CONFIG.seekerPowers.i_see_you;
  return Math.round(Math.min(c.radiusM, c.maxFractionOfM * (m || activeM())));
}

// How far a decoy is allowed to get from where it was cast.
function decoyMaxTravelM() {
  return CONFIG.hiderPowers.decoy.maxTravelFractionOfM * activeM();
}

// The snitch's range bands, all derived from the one scaled number so they
// can never drift out of order.
function snitchBands(m) {
  const c = CONFIG.snitch;
  const wide = scaledM(c.wideRange, m);
  const medium = Math.round(wide * c.mediumFraction);
  return {
    exactRangeM: Math.round(wide * c.exactFraction),
    mediumRangeM: medium,
    wideRangeM: wide,
    mediumCircleM: Math.round(medium * c.mediumCircleFraction),
    wideCircleM: Math.round(wide * c.wideCircleFraction),
  };
}

// Half the walk across the play area, held between "long enough to get out of
// sight" and "short enough that nobody is standing about".
function headstartMsFor(diagonalM, gameLengthMin) {
  const h = CONFIG.headstart;
  const paceMs = (h.walkingPaceKmh * 1000) / 3600000; // metres per ms
  const raw = (h.diagonalFraction * diagonalM) / paceMs;
  const ceiling = (gameLengthMin || CONFIG.gameLengthMin) * 60000 * h.maxFractionOfGame;
  return Math.round(Math.min(ceiling, Math.max(h.minMs, raw)));
}

function totemPrecisionOverrideM() {
  return CONFIG.totem.sabotageOverrideRadiusM || null;
}

function totemSabotageSeconds(radiusM) {
  const mins = Math.min(CONFIG.totem.sabotageMaxMin, radiusM / CONFIG.totem.sabotageTimeDivisor);
  return mins * 60;
}
