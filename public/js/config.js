// Central config — every tunable number lives here.
// Matches Section 18 of the design doc. Edit this file to rebalance,
// never hardcode a number elsewhere.

const CONFIG = {
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
    movementThresholdM: 5,      // below this, treat the player as parked
    tickKeepaliveMs: 60000,     // contact heartbeat when GPS is unavailable
  },

  charge: {
    cap: 100,
    // THE PACING NUMBER. Nothing pings on its own any more, so how often
    // anyone can be found is set entirely here. A Probe costs 30, so this
    // regen rate means a seeker can sweep roughly every two minutes.
    // Halve the regen and the game slows down everywhere at once.
    regenPerMs: 1 / 4000, // 1 point every 4 seconds — 15/min
    globalCooldownMs: 60000,
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
    // Reported positions are wrong by up to this much, rolled fresh each
    // time. Two pings on a player who has not moved an inch can land 60m
    // apart in unrelated directions — so a still player can look like a
    // moving one, and the trail drawn between their dots lies about which
    // way they went. DISPLAY ONLY: never used for tripwires, sabotage,
    // capture range or boundary checks.
    jitterRadiusM: 30,
    maxStored: 12, // dots kept per player; comfortably more than a lifetime
    dotRadiusPx: 7,
    trailWidthPx: 3,
  },

  hiderPowers: {
    disarm: { cost: 15, radiusM: 50 },
    go_quiet: { cost: 20, durationMs: 3 * 60000 },
    decoy: { cost: 35, durationMs: 3 * 60000, paceKmh: 3 },
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
    tripwire: { cost: 5, triggerRadiusM: 20 },
    // Passive, free, and mechanically inert on purpose: inside this radius a
    // hider is told, in enormous letters, that they may no longer run. The
    // app does not and cannot enforce it — the players do. It gives the
    // seeker nothing at all, which is what keeps it out of the ping economy.
    i_see_you: { radiusM: 20 },
    lockout: { cost: 25, durationMs: 3 * 60000 },
    totem: { cost: 60, maxUndeployed: 2, maxLive: 10 },
  },

  snitch: {
    cost: 20,
    displayMs: 15000,
    exactRangeM: 100,
    mediumCircleM: 50,
    mediumRangeM: 300,
    wideCircleM: 150,
    wideRangeM: 600,
  },

  totem: {
    radiusFraction: 0.126, // fraction of M
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
    // A sign is invisible until you walk into it. Once you have been this
    // close it stays on your map for the rest of the game — you know it is
    // there now. Discovery is per player and never shared, so a sign
    // appearing on your map says nothing about where anyone else has been.
    discoverRadiusM: 10,
    readRadiusM: 18,
    cost: 0,
    maxLength: 120,
  },

  boundary: {
    warningZoneM: 20,
    breachTimerMs: 3 * 60000,
    confirmReadings: 3, // consecutive out-of-bounds fixes before a breach counts
  },

  headstart: {
    walkingPaceKmh: 3,
    diagonalFraction: 0.5,
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

function totemRadiusM(M) {
  return CONFIG.totem.radiusFraction * M;
}

function totemPrecisionOverrideM() {
  return CONFIG.totem.sabotageOverrideRadiusM || null;
}

function totemSabotageSeconds(radiusM) {
  const mins = Math.min(CONFIG.totem.sabotageMaxMin, radiusM / CONFIG.totem.sabotageTimeDivisor);
  return mins * 60;
}
