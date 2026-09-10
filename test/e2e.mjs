import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

// Drives a full five-player game against the offline dev harness and checks
// the rules in the design doc actually hold. Run with:  node test/e2e.mjs
// Needs Playwright:  npm i -D playwright && npx playwright install chromium
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PORT = 8123;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));

// Play area: a ~600m square in a park, so M ≈ 600.
const BASE = { lat: 51.5074, lng: -0.1278 };
const off = (dEast, dNorth) => ({
  lat: BASE.lat + dNorth / 111320,
  lng: BASE.lng + dEast / (111320 * Math.cos(BASE.lat * Math.PI / 180)),
});
const BOUNDARY = [off(-300, -300), off(300, -300), off(300, 300), off(-300, 300)];

const results = [];
const errors = [];

// Poll until a condition holds rather than sleeping a fixed amount: state
// crosses tabs asynchronously and fixed waits make these checks flaky.
async function until(page, fn, arg, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    if (Date.now() > deadline) return last;
    await page.waitForTimeout(250);
  }
}
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const ctx = await browser.newContext({
  permissions: ['geolocation'],
  geolocation: { latitude: BASE.lat, longitude: BASE.lng },
});

const NAMES = ['Host', 'Seek2', 'Hide1', 'Hide2', 'Hide3'];
const pages = [];

async function openPlayer(i, start) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { errors.push(`${NAMES[i]}: ${e.message}`); });
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${NAMES[i]} console: ${m.text()}`); });
  // mock=1 pins the suite to the offline harness. Without it, now that real
  // credentials are in firebase-config.js, every run would write test games
  // into the live Firestore project.
  await p.goto(`http://localhost:${PORT}/?mock=1&pid=p${i}&sim=${start.lat},${start.lng}`);
  pages.push(p);
  return p;
}

// ---- host creates the game ----
const host = await openPlayer(0, off(0, 0));
await host.fill('#input-name-host', 'Host');
await host.fill('#input-area-side', '600');
await host.fill('#input-length', '90');
await host.click('#btn-host');
await host.waitForSelector('#view-lobby.active');
const code = await host.textContent('#lobby-code');
check('host creates game', !!code && code.length === 5, `code ${code}`);

// Set the boundary directly rather than simulating taps on a Leaflet canvas.
const boundaryInfo = await host.evaluate((b) => setBoundary(b), BOUNDARY);
check('boundary sets M from drawn area', Math.abs(boundaryInfo.M - 600) < 10,
  `M=${Math.round(boundaryInfo.M)} (expected ~600)`);
check('head start computed from diagonal', boundaryInfo.headstartMs > 0,
  `${Math.round(boundaryInfo.headstartMs / 60000)} min`);

// The host may override the computed head start (design doc Section 2).
await host.waitForTimeout(400);
const shownHeadstart = await host.inputValue('#input-headstart');
await host.fill('#input-headstart', '2');
await host.dispatchEvent('#input-headstart', 'change');
await host.waitForTimeout(500);
const overridden = await host.evaluate(() => gameState.headstartMs);
check('host can override the computed head start',
  overridden === 120000, `computed ${shownHeadstart} min, set to ${overridden / 60000} min`);
await host.fill('#input-headstart', '0');
await host.dispatchEvent('#input-headstart', 'change');
await host.waitForTimeout(400);
const zeroed = await host.evaluate(() => gameState.headstartMs);
check('head start can be set to zero for testing', zeroed === 0);

// ---- everyone else joins ----
const starts = [off(50, 0), off(-100, 40), off(120, -80), off(-40, -150)];
for (let i = 1; i < 5; i++) {
  const p = await openPlayer(i, starts[i - 1]);
  await p.fill('#input-name-join', NAMES[i]);
  await p.fill('#input-code', code);
  await p.click('#btn-join');
  await p.waitForSelector('#view-lobby.active');
}
await host.waitForTimeout(500);
const lobbyCount = await host.evaluate(() => Object.keys(playersState).length);
check('all five players in lobby', lobbyCount === 5, `${lobbyCount} players`);

// ---- roles: force a deterministic split (2 seekers, 3 hiders) ----
await host.evaluate(async () => {
  const roles = { p0: 'seeker', p1: 'seeker', p2: 'hider', p3: 'hider', p4: 'hider' };
  await Promise.all(Object.entries(roles).map(([id, role]) => playerRef(id).update({ role })));
});
// Hiders pick loadouts.
for (let i = 2; i < 5; i++) {
  await pages[i].evaluate(() => playerRef().update({
    loadout: ['go_quiet', 'smear', 'silent_run', 'decoy'],
  }));
}
await host.waitForTimeout(400);

// ---- start, and skip the head start so seekers can act ----
await host.click('#btn-start-game');
await host.evaluate(() => gameRef().update({ seekersReleaseAt: Date.now() - 1 }));
for (const p of pages) await p.waitForSelector('#view-game.active', { timeout: 8000 });
check('game starts for all clients', true);

await host.waitForTimeout(3000);

// ================= TIER 1 / positioning =================

const hiderBroadcast = await host.evaluate(() => {
  const h = playersState.p2;
  return { lat: h.broadcastLat, at: h.broadcastAt, r: h.broadcastRadiusM, mode: h.broadcastMode };
});
check('hider pings on join', hiderBroadcast.lat != null && hiderBroadcast.at != null);
check('hider ping starts at base accuracy', hiderBroadcast.r === 10, `${hiderBroadcast.r}m`);

// Uncertainty must GROW with time since the ping, not be fixed at ping time.
const growth = await host.evaluate(() => {
  const h = playersState.p2;
  const now = h.broadcastAt;
  return {
    at0: displayRadiusM(h, now),
    at2min: displayRadiusM(h, now + 120000),
    cap: displayRadiusM(h, now + 60 * 60000),
  };
});
check('uncertainty grows with time since ping',
  growth.at0 === 10 && Math.abs(growth.at2min - 90) < 1,
  `${growth.at0}m now, ${Math.round(growth.at2min)}m after 2min`);
check('uncertainty capped at 0.5M', Math.abs(growth.cap - 300) < 6, `${Math.round(growth.cap)}m`);

// Seekers broadcast exactly; hiders see nobody.
const seekerView = await pages[1].evaluate(() => ({
  broadcast: playersState.p1.broadcastRadiusM,
  role: playerRole,
}));
check('seeker broadcasts at full accuracy', seekerView.broadcast === 0);

// ================= TIER 2 / powers =================

const outOfLoadout = await pages[2].evaluate(() => powerBlockedReason('uncloak', me()));
check('powers outside your loadout are refused',
  outOfLoadout === 'Not in your loadout.', outOfLoadout);

// From here, reset the activating player each time: full charge, no cooldown,
// no power occupying the single active slot, and the power in their loadout.
// Those constraints are checked individually elsewhere.
async function runPower(pageIdx, key, ctxArg) {
  return pages[pageIdx].evaluate(async ([k, c]) => {
    const cur = me().loadout || [];
    await playerRef().update({
      cooldownUntil: 0, chargeCheckpoint: 100, chargeCheckpointAt: Date.now(),
      activePower: null, activePowerExpiresAt: 0, pendingPingMod: null,
      loadout: cur.includes(k) ? cur : cur.concat([k]),
    });
    await new Promise((r) => setTimeout(r, 120));
    const ok = await activatePower(k, c);
    await new Promise((r) => setTimeout(r, 250));
    return ok;
  }, [key, ctxArg || {}]);
}

// -- Go quiet: the next ping is skipped, broadcastAt goes stale --
const beforeQuiet = await host.evaluate(() => playersState.p2.broadcastAt);
await runPower(2, 'go_quiet');
await pages[2].evaluate(async () => {
  nextPingDueAt = 0;
  await new Promise((r) => setTimeout(r, 50));
  sendHiderPing(myPos, Date.now(), me());
});
await host.waitForTimeout(400);
const afterQuiet = await host.evaluate(() => ({
  at: playersState.p2.broadcastAt, mod: playersState.p2.pendingPingMod,
}));
check('go quiet skips the ping (position goes stale)',
  afterQuiet.at === beforeQuiet && afterQuiet.mod === null);

// -- Smear: next ping reports an arc --
await runPower(2, 'smear');
await pages[2].evaluate(async () => {
  nextPingDueAt = 0;
  sendHiderPing(myPos, Date.now(), me());
});
await host.waitForTimeout(400);
const smeared = await host.evaluate(() => {
  const h = playersState.p2;
  return { mode: h.broadcastMode, arc: h.broadcastArc };
});
check('smear reports an arc instead of a circle',
  smeared.mode === 'arc' && smeared.arc && smeared.arc.halfWidthDeg === 45);

// -- Decoy: broadcast follows a fake bearing, real position suppressed --
await runPower(3, 'decoy', { bearing: 90 });
await pages[3].evaluate(async () => {
  await new Promise((r) => setTimeout(r, 1200));
  nextPingDueAt = 0;
  sendHiderPing(myPos, Date.now(), me());
});
await host.waitForTimeout(400);
const decoyed = await host.evaluate(() => {
  const h = playersState.p3;
  return {
    real: { lat: h.realLat, lng: h.realLng },
    broadcast: { lat: h.broadcastLat, lng: h.broadcastLng },
    drift: distanceM({ lat: h.realLat, lng: h.realLng }, { lat: h.broadcastLat, lng: h.broadcastLng }),
    bearingOfDrift: bearingDeg({ lat: h.realLat, lng: h.realLng }, { lat: h.broadcastLat, lng: h.broadcastLng }),
  };
});
check('decoy broadcasts a fake position, not the real one',
  decoyed.drift > 0.5 && Math.abs(decoyed.bearingOfDrift - 90) < 15,
  `${decoyed.drift.toFixed(1)}m east (bearing ${Math.round(decoyed.bearingOfDrift)}°)`);

// -- Silent run: moving keeps the stationary cadence --
await runPower(4, 'silent_run');
const cadence = await pages[4].evaluate(() => {
  const p = me();
  recentFixes = [
    { lat: myPos.lat, lng: myPos.lng, at: Date.now() - 60000 },
    { lat: myPos.lat + 0.001, lng: myPos.lng, at: Date.now() },
  ];
  const movingNow = isMovingNow();
  const silent = !!(p.silentRunUntil && Date.now() < p.silentRunUntil);
  return {
    movingNow, silent,
    withSilent: pingInterval(1, movingNow && !silent),
    withoutSilent: pingInterval(1, movingNow),
  };
});
check('silent run keeps the stationary cadence while moving',
  cadence.movingNow && cadence.silent &&
  cadence.withSilent === 300000 && cadence.withoutSilent === 120000,
  `${cadence.withSilent / 1000}s vs ${cadence.withoutSilent / 1000}s`);

// -- Scan: exact positions of hiders within 100m --
await pages[1].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(-100, 40));
await host.waitForTimeout(1200);
await runPower(1, 'scan');
const scan = await pages[1].evaluate(() => ({
  n: reveals.scan.points.length,
  names: reveals.scan.points.map((p) => p.name),
}));
check('scan reveals only hiders within 100m', scan.n === 1 && scan.names[0] === 'Hide1',
  `found ${scan.names.join(', ') || 'nobody'}`);

// -- Probe: yes/no on a chosen circle --
await runPower(1, 'probe', { point: off(120, -80) });
const probeHit = await pages[1].evaluate(() => reveals.probe.hit);
await runPower(1, 'probe', { point: off(290, 290) });
const probeMiss = await pages[1].evaluate(() => reveals.probe.hit);
check('probe answers yes where a hider is, no where none is', probeHit === true && probeMiss === false);

// -- Backtrace vs False trail --
await pages[2].evaluate(async () => {
  await playerRef().update({
    pingHistory: [{ lat: myPos.lat, lng: myPos.lng, at: Date.now() - 60000 },
                  { lat: myPos.lat + 0.0009, lng: myPos.lng, at: Date.now() }],
  });
});
await host.waitForTimeout(400);
await runPower(1, 'backtrace', { targetId: 'p2' });
const trueBearing = await pages[1].evaluate(() => reveals.backtrace.bearing);
check('backtrace reads true heading from last two pings', Math.abs(trueBearing) < 5 || Math.abs(trueBearing - 360) < 5,
  `${Math.round(trueBearing)}° (expected ~0° / north)`);

await runPower(2, 'false_trail');
await host.waitForTimeout(400);
await runPower(1, 'backtrace', { targetId: 'p2' });
const fakeBearing = await pages[1].evaluate(() => reveals.backtrace.bearing);
const delta = Math.abs(((fakeBearing - trueBearing) + 540) % 360 - 180);
check('false trail makes backtrace report a wrong heading', delta > 60,
  `reported ${Math.round(fakeBearing)}° vs true ${Math.round(trueBearing)}°`);

// -- Lockout: target's own client refuses loadout powers --
await runPower(1, 'lockout', { targetId: 'p2' });
await host.waitForTimeout(500);
const lockedReason = await pages[2].evaluate(() => powerBlockedReason('smear', me()));
check('lockout blocks the target\'s loadout powers', lockedReason === 'Locked out.', lockedReason);
const snitchStillOk = await pages[2].evaluate(() =>
  powerBlockedReason('smear', me()) === 'Locked out.' && POWERS.smear.loadout === true);
check('lockout is scoped to loadout powers only', snitchStillOk);
await pages[2].evaluate(() => playerRef().update({ lockedOutUntil: 0 }));

// -- Go dark + Uncloak --
await runPower(1, 'go_dark');
await host.waitForTimeout(600);
const wentDark = await host.evaluate(() => ({
  dark: isSeekerDark(playersState.p1),
  broadcast: playersState.p1.broadcastLat,
}));
check('go dark stops the seeker broadcasting', wentDark.dark === true && wentDark.broadcast === null);

const sweepWhileDark = await pages[2].evaluate(() => {
  const now = Date.now();
  return Object.values(playersState).filter((p) =>
    p.role === 'seeker' && p.status === 'active' && p.realLat && !isSeekerDark(p, now)).length;
});
await pages[2].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(-100, 40));
await host.waitForTimeout(1200);
await runPower(2, 'uncloak');
const afterUncloak = await until(host, () => {
  const r = {
    dark: isSeekerDark(playersState.p1),
    forced: playersState.p1.forcedBroadcastUntil > Date.now(),
  };
  return (r.dark === false && r.forced === true) ? r : null;
}) || await host.evaluate(() => ({
  dark: isSeekerDark(playersState.p1),
  forced: playersState.p1.forcedBroadcastUntil > Date.now(),
}));
check('uncloak forces a nearby dark seeker back into broadcast',
  afterUncloak.dark === false && afterUncloak.forced === true,
  `${sweepWhileDark} seeker(s) visible to the hider while dark`);

// -- Beacon + contagion --
await pages[3].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(-100, 45));
await host.waitForTimeout(1000);
await runPower(1, 'beacon', { targetId: 'p2' });
const beaconed = await until(host, () => playersState.p2.beaconedUntil > Date.now());
check('beacon lights up the target', beaconed);
const spread = await until(host, () => playersState.p3.beaconedUntil > Date.now());
check('beacon spreads to a hider within 30m', spread);
await host.evaluate(() => Promise.all([
  playerRef('p2').update({ beaconedUntil: 0 }),
  playerRef('p3').update({ beaconedUntil: 0 }),
]));

// -- Tripwire + Disarm --
await pages[1].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(0, 200));
await host.waitForTimeout(1000);
await runPower(1, 'tripwire');
await host.waitForTimeout(500);
const twCount = await host.evaluate(() => Object.keys(tripwiresState).length);
check('tripwire is placed', twCount === 1);

await pages[4].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(0, 195));
const tripped = await until(host, () => {
  const tw = Object.values(tripwiresState)[0];
  return !!(tw && tw.triggered);
});
check('a hider walking within 20m trips the wire', tripped === true);

await runPower(1, 'tripwire');
await host.waitForTimeout(400);
await pages[4].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(0, 210));
await host.waitForTimeout(1200);
await runPower(4, 'disarm');
await host.waitForTimeout(500);
const remaining = await host.evaluate(() =>
  Object.values(tripwiresState).filter((t) => !t.triggered).length);
check('disarm destroys untriggered tripwires within 50m', remaining === 0);

// -- Cordon --
await runPower(1, 'cordon', { point: off(0, 210) });
await host.waitForTimeout(600);
const cordonEffect = await pages[4].evaluate(() => isInsideActiveCordon(myPos));
check('a hider inside a cordon is flagged for continuous pinging', cordonEffect === true);
await host.evaluate(async () => {
  const snap = await gameRef().collection('cordons').get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
});

// ================= TIER 3 / totems + sabotage =================

await runPower(1, 'totem', { point: off(0, 0) });
await host.waitForTimeout(600);
const totem = await host.evaluate(() => {
  const [id, t] = Object.entries(totemsState)[0];
  return { id, radiusM: t.radiusM, requiredS: t.requiredS, status: t.status };
});
check('totem radius is 0.126 x M', Math.abs(totem.radiusM - 0.126 * 600) < 3,
  `${Math.round(totem.radiusM)}m`);
check('sabotage time is radius/25 minutes',
  Math.abs(totem.requiredS - (totem.radiusM / 25) * 60) < 2,
  `${(totem.requiredS / 60).toFixed(1)} min`);

// A hider inside the radius triggers an anonymous ping.
await pages[2].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(30, 30));
await until(host, () => (Object.values(totemsState)[0].recentPings || []).length >= 1);
const pinged = await host.evaluate(() => Object.values(totemsState)[0].recentPings || []);
check('totem pings anonymously while a hider is inside', pinged.length >= 1,
  `${pinged.length} ping(s)`);
const anonymous = await host.evaluate(() => {
  const p = (Object.values(totemsState)[0].recentPings || [])[0];
  return p && p.playerId === undefined && p.name === undefined;
});
check('totem ping carries no identity', anonymous === true);

// One hider alone: no progress.
await pages[2].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(0, 3));
await host.waitForTimeout(6000);
const soloProgress = await host.evaluate(() => Object.values(totemsState)[0].sabotageProgressS || 0);
check('one hider alone accrues no sabotage progress', soloProgress === 0);
const waitingFlag = await pages[3].evaluate(() => {
  const t = Object.values(totemsState)[0];
  return freshPresenceIds(t).length;
});
check('other hiders can see one hider waiting at the totem', waitingFlag === 1);

// Second hider arrives: progress accrues, totem greys out.
await pages[3].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(2, -2));
await until(host, () => (Object.values(totemsState)[0].sabotageProgressS || 0) > 2, null, 20000);
const joint = await host.evaluate(() => {
  const t = Object.values(totemsState)[0];
  return { progress: t.sabotageProgressS || 0, sabotaging: isBeingSabotaged(t), present: freshPresenceIds(t).length };
});
check('two hiders together accrue sabotage progress', joint.progress > 2,
  `${joint.progress.toFixed(1)}s accrued`);
check('totem greys out for everyone while being sabotaged', joint.sabotaging === true,
  `${joint.present} present`);

// One leaves: progress decays at half rate.
await pages[3].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(200, 200));
await host.waitForTimeout(9000);
const decayed = await host.evaluate(() => {
  const t = Object.values(totemsState)[0];
  return { stored: t.sabotageProgressS, effective: effectiveSabotageProgressS(t), sabotaging: isBeingSabotaged(t) };
});
check('progress decays at half rate once a participant leaves',
  decayed.effective < decayed.stored && decayed.effective >= 0,
  `${decayed.stored.toFixed(1)}s stored -> ${decayed.effective.toFixed(1)}s effective`);
check('totem stops showing as sabotaged when the pair breaks up', decayed.sabotaging === false);

// Force completion to check destruction + hunt clearing.
await pages[3].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(2, -2));
await host.waitForTimeout(1500);
await host.evaluate(async () => {
  const [id, t] = Object.entries(totemsState)[0];
  await gameRef().collection('totems').doc(id).update({
    sabotageProgressS: t.requiredS - 1, lastAccrualAt: Date.now(),
  });
});
await until(host, () => Object.values(totemsState)[0].status === 'destroyed', null, 20000);
const destroyed = await host.evaluate(() => Object.values(totemsState)[0].status);
check('sabotage completes and destroys the totem', destroyed === 'destroyed', destroyed);

// ================= TIER 4 / hunt + snitch =================

await host.evaluate(() => gameRef().update({ lastCaptureAt: Date.now() - 11 * 60000 }));
await host.waitForTimeout(600);
const huntReady = await pages[1].evaluate(() => huntAvailable());
check('hunt unlocks after 10 minutes without a capture', huntReady === true);

await pages[1].evaluate(() => activateHunt('p2'));
await host.waitForTimeout(800);
const huntState = await host.evaluate(() => ({
  seeker: !!playersState.p1.activeHunt,
  target: Object.keys(playersState.p2.huntedBy || {}),
}));
check('hunt marks the chosen target', huntState.seeker && huntState.target.includes('p1'));

const bearings = await host.evaluate(() => {
  const toTarget = huntBearing('p1', 'p2');
  const back = huntBearing('p2', 'p1');
  const sep = (((toTarget.bearing - back.bearing) % 360) + 360) % 360;
  return { toTarget, back, sep };
});
check('hunted player sees the reciprocal bearing back',
  Math.abs(bearings.sep - 180) < 2,
  `${Math.round(bearings.toTarget.bearing)}° vs ${Math.round(bearings.back.bearing)}° (separation ${Math.round(bearings.sep)}°)`);
check('cone narrows with distance',
  bearings.toTarget.coneHalfWidthDeg >= 5 && bearings.toTarget.coneHalfWidthDeg <= 20,
  `±${bearings.toTarget.coneHalfWidthDeg.toFixed(1)}°`);

// Snitch: only available while hunted.
const snitchBlockedForUnhunted = await pages[4].evaluate(() => snitchAvailableReason(me()));
check('snitch is unavailable when not hunted',
  snitchBlockedForUnhunted === 'Only usable while you are being hunted.', snitchBlockedForUnhunted);

await pages[2].evaluate(() => playerRef().update({ cooldownUntil: 0, chargeCheckpoint: 100, chargeCheckpointAt: Date.now() }));
await host.waitForTimeout(300);
await pages[4].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(0, 50));   // ~47m => exact
await pages[3].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(0, 250));  // ~247m => 50m circle
await host.waitForTimeout(1500);
const survey = await pages[2].evaluate(() => snitchSurvey().map((e) => ({ name: e.name, r: e.radiusM, d: Math.round(e.dist) })));
check('snitch survey bands fidelity by range',
  survey.length === 2 &&
  survey.find((s) => s.name === 'Hide3').r === 0 &&
  survey.find((s) => s.name === 'Hide2').r === 50,
  survey.map((s) => `${s.name}@${s.d}m=${s.r || 'exact'}`).join(', '));

await pages[2].evaluate(async () => { await beginSnitch(); });
await host.waitForTimeout(600);
await pages[2].evaluate(() => snitchOn('p4'));
await host.waitForTimeout(800);
const seekerGotReport = await pages[1].evaluate(() =>
  reveals.scan && reveals.scan.points.some((p) => p.name === 'Hide3'));
check('snitch delivers the position to the hunting seeker', seekerGotReport === true);
const snitchUsedUp = await pages[2].evaluate(() => snitchAvailableReason(me()));
check('snitch is once per hunt', snitchUsedUp === 'Already used for this hunt.', snitchUsedUp);

// Sabotage clears the hunt mark.
await pages[1].evaluate(() => playerRef().update({ activeHunt: null }));
await host.waitForTimeout(500);
await pages[1].evaluate(() => activateHunt('p3'));
await host.waitForTimeout(800);
const markedBeforeClear = await host.evaluate(() => Object.keys(playersState.p3.huntedBy || {}).length);
check('second hunt marks the new target', markedBeforeClear === 1);
// A completed sabotage clears the mark from the hider's own client.
await pages[3].evaluate(() => clearHuntsOn('p3'));
await host.waitForTimeout(800);
const cleared = await host.evaluate(() => ({
  marks: Object.keys(playersState.p3.huntedBy || {}).length,
  seekerHunt: playersState.p1.activeHunt,
}));
check('clearing a mark also ends the seeker\'s hunt',
  cleared.marks === 0 && cleared.seekerHunt === null);

// ================= TIER 5 / signposts, boundary, capture, end =================

await pages[3].evaluate(() => placeSignpost('gate is unlocked'));
await host.waitForTimeout(600);
const signRead = await pages[3].evaluate(() => signpostsInRange(myPos).map((s) => s.text));
const signFar = await pages[4].evaluate(() => signpostsInRange(myPos).length);
check('signposts are readable in range and invisible outside it',
  signRead[0] === 'gate is unlocked' && signFar === 0);
const signAnonymous = await pages[4].evaluate(() => {
  const s = Object.values(signpostsState)[0];
  return { hasText: !!s.text, authorSurfaced: false, authorStored: !!s.authorId };
});
check('signposts are anonymous to readers but attributable internally',
  signAnonymous.hasText && signAnonymous.authorStored);

// Boundary breach.
await pages[4].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(0, 500));
await until(host, () => !!playersState.p4.breachStartedAt, null, 25000);
const breach = await host.evaluate(() => ({
  readings: playersState.p4.outOfBoundsReadings,
  started: !!playersState.p4.breachStartedAt,
}));
check('leaving the boundary starts a confirmed breach countdown',
  breach.readings >= 3 && breach.started, `${breach.readings} consecutive readings`);

// The forced exposure lands on the breaching player's next fix, a beat
// after the breach flag itself propagates.
const exposed = await until(host, () => {
  const h = playersState.p4;
  if (!h.broadcastLat) return false;
  return distanceM({ lat: h.realLat, lng: h.realLng }, { lat: h.broadcastLat, lng: h.broadcastLng }) < 5;
});
check('a breaching hider pings their true position continuously', exposed === true);

await pages[4].evaluate((pos) => window.__sim.setPos(pos.lat, pos.lng), off(0, 100));
await host.waitForTimeout(6000);
const recovered = await host.evaluate(() => !playersState.p4.breachStartedAt);
check('returning inside cancels the countdown', recovered === true);

// Capture.
const hiderCode = await host.evaluate(() => playersState.p2.captureCode);
check('capture code excludes confusable letters', !/[AEIOULI01]/.test(hiderCode), hiderCode);
const lookup = await pages[1].evaluate((c) => lookupCaptureTarget(c), hiderCode);
check('code lookup finds the right hider for confirmation', lookup && lookup.name === 'Hide1');
await pages[1].evaluate((id) => confirmCapture(id), 'p2');
await host.waitForTimeout(800);
const converted = await host.evaluate(() => ({
  role: playersState.p2.role,
  charge: Math.floor(currentCharge(playersState.p2)),
  grace: playersState.p2.graceUntil > Date.now(),
  survival: playersState.p2.survivalMs,
  huntTimerReset: Date.now() - gameState.lastCaptureAt < 5000,
}));
check('capture converts the hider to a seeker', converted.role === 'seeker');
check('converted seeker starts at 30 charge, not 100',
  converted.charge >= 30 && converted.charge < 35, `${converted.charge}`);
check('converted seeker has a grace period', converted.grace === true);
check('capture locks the hider\'s survival time', converted.survival > 0,
  `${Math.round(converted.survival / 1000)}s`);
check('capture re-arms the hunt timer', converted.huntTimerReset === true);
const graceBlocks = await pages[2].evaluate(() => powerBlockedReason('scan', me()));
check('powers are blocked during the conversion grace period',
  graceBlocks === 'Conversion grace period.', graceBlocks);

// Quit and panic both count as found.
await pages[3].evaluate(() => quitGame());
await host.waitForTimeout(700);
const quit = await host.evaluate(() => ({
  status: playersState.p3.status, survival: playersState.p3.survivalMs,
}));
check('quit locks survival time and removes the player',
  quit.status === 'quit' && quit.survival > 0);

await pages[4].evaluate(() => sendPanic('twisted ankle by the fallen tree'));
await host.waitForTimeout(900);
const panic = await host.evaluate(() => ({
  status: playersState.p4.status,
  alerts: panicAlerts.length,
  msg: panicAlerts[0] && panicAlerts[0].message,
  exact: panicAlerts[0] && panicAlerts[0].lat != null,
}));
check('panic broadcasts an exact position and message to everyone',
  panic.status === 'panicked' && panic.alerts === 1 && panic.exact &&
  panic.msg === 'twisted ankle by the fallen tree');

// Elimination mode ends the game once no hiders remain.
await until(host, () => gameState.status === 'ended', null, 20000);
const ended = await host.evaluate(() => gameState.status);
check('elimination mode ends the game when the last hider is gone', ended === 'ended', ended);
await host.waitForTimeout(700);
const board = await host.evaluate(() => ({
  rows: Array.from(document.querySelectorAll('#scoreboard li')).map((li) => li.textContent.trim()),
  summary: document.getElementById('end-summary').textContent,
}));
check('scoreboard scores only players who were hiders', board.rows.length === 3,
  `${board.rows.length} rows: ${board.rows.join(' | ')}`);
check('original seekers are listed separately, not ranked',
  !board.rows.some((r) => r.startsWith('Host') || r.startsWith('Seek2')) &&
  /Seekers: (Host, Seek2|Seek2, Host)\./.test(board.summary), board.summary);
check('outcomes are labelled in plain language',
  board.rows.some((r) => r.includes('(found)')) &&
  board.rows.some((r) => r.includes('(withdrew)')) &&
  board.rows.some((r) => r.includes('(panic)')),
  board.rows.join(' | '));

// ---- results ----
console.log('\n' + '='.repeat(60));
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('FAILED:\n' + failed.map((f) => '  - ' + f.name + (f.detail ? ` (${f.detail})` : '')).join('\n'));

const realErrors = errors.filter((e) => !/favicon|tile\.openstreetmap|ERR_|Failed to load resource/i.test(e));
if (realErrors.length) {
  console.log(`\nJS errors (${realErrors.length}):`);
  [...new Set(realErrors)].slice(0, 20).forEach((e) => console.log('  ! ' + e));
} else {
  console.log('\nNo JS errors.');
}

await browser.close();
server.close();
process.exit(failed.length || realErrors.length ? 1 : 0);
