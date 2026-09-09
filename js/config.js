// Central config — every tunable number lives here.
// Matches Section 18 of the design doc. Edit this file to rebalance,
// never hardcode a number elsewhere.

const CONFIG = {
  baseAccuracyRadiusM: 10,
  gameLengthMin: 90,

  charge: {
    cap: 100,
    regenPerMs: 1 / 20000, // 1 point every 20 seconds
    globalCooldownMs: 60000,
    conversionStartingCharge: 30,
    conversionGraceMs: 60000,
  },

  ping: {
    phase1EndPct: 40,
    phase2EndPct: 75,
    phase1StationaryMs: 5 * 60000,
    phase1MovingMs: 2 * 60000,
    phase2StationaryMs: 4 * 60000,
    phase2MovingMs: 90 * 1000,
    phase3StationaryMs: 2 * 60000,
    phase3MovingMs: 45 * 1000,
    growthRateMPerMinPhase12: 40,
    growthRateMPerMinPhase3: 20,
    uncertaintyCapFraction: 0.5, // fraction of M
    movingThresholdMPerMin: 20, // speed above this = "moving" state
  },

  hiderPowers: {
    smear: { cost: 20, durationMs: null }, // applies to next ping only
    false_trail: { cost: 20, durationMs: null },
    disarm: { cost: 20, radiusM: 50 },
    go_quiet: { cost: 30, durationMs: null }, // skips next ping
    uncloak: { cost: 30, radiusM: 300, forceBroadcastMs: 60000 },
    read_the_sweep: { cost: 30, durationMs: 30000 },
    silent_run: { cost: 60, durationMs: 3 * 60000 },
    decoy: { cost: 60, durationMs: 3 * 60000 },
  },

  seekerPowers: {
    probe: { cost: 20, radiusM: 100 },
    backtrace: { cost: 20 },
    tripwire: { cost: 30, triggerRadiusM: 20 },
    go_dark: { cost: 30, durationMs: 3 * 60000 },
    lockout: { cost: 30, durationMs: 3 * 60000 },
    scan: { cost: 45, radiusM: 100 },
    beacon: { cost: 45, radiusM: 30, durationMs: 5 * 60000 },
    cordon: { cost: 40, radiusM: 150, durationMs: 5 * 60000 },
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
  },

  hunt: {
    noCaptureCooldownMs: 10 * 60000,
    durationMs: 10 * 60000,
    bearingRefreshMs: 30000,
    coneDegAt500m: 40,
    coneDegAt100m: 10,
  },

  boundary: {
    warningZoneM: 20,
    breachTimerMs: 3 * 60000,
  },

  offline: {
    flagAfterMs: 15 * 60000,
    eliminateAfterMs: 30 * 60000,
  },
};

// M = sqrt(boundary area). Set once the host draws/enters the play area.
function computeM(areaM2) {
  return Math.sqrt(areaM2);
}
