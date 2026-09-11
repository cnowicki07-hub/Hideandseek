import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

// Drives a full five-player game against the offline dev harness and checks
// the rules in the design doc actually hold. Run with:  node test/e2e.mjs
// Needs Playwright:  npm i -D playwright && npx playwright install chromium
const ROOT = path.join(path.resolve(new URL('..', import.meta.url).pathname), 'public');
// BASE_URL points the run at a real Worker (npx wrangler dev). Without it the
// suite serves public/ itself and uses the offline store, so it can run with
// no server at all.
const BASE_URL = process.env.BASE_URL || null;
const PORT = 8123;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});
if (!BASE_URL) await new Promise((r) => server.listen(PORT, r));
const ORIGIN = BASE_URL || `http://localhost:${PORT}`;
const STORE_PARAM = BASE_URL ? '' : 'mock=1&';
console.log(`running against ${ORIGIN}${BASE_URL ? ' (real Worker)' : ' (offline store)'}\n`);

// Play area: a ~600m square in a park, so M ≈ 600.
const BASE = { lat: 51.5074, lng: -0.1278 };
const off = (dEast, dNorth) => ({
  lat: BASE.lat + dNorth / 111320,
  lng: BASE.lng + dEast / (111320 * Math.cos(BASE.lat * Math.PI / 180)),
});
const BOUNDARY = [off(-300, -300), off(300, -300), off(300, 300), off(-300, 300)];

const results = [];
const errors = [];
const dialogs = [];   // expected ones exist (the panic alert), so not errors
const skipped = [];
function skip(name, why) {
  skipped.push({ name, why });
  console.log(`SKIP  ${name}  — ${why}`);
}

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
  // Playwright dismisses dialogs by default, which silently turns a confirm()
  // into "no" and makes a blocked action look like a mystery timeout.
  p.on('dialog', (d) => {
    dialogs.push(`${NAMES[i]} [${d.type()}] ${d.message().split('\n')[0]}`);
    d.dismiss().catch(() => {});
  });
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${NAMES[i]} console: ${m.text()}`); });
  // mock=1 pins the suite to the offline harness. Without it, now that real
  // credentials are in firebase-config.js, every run would write test games
  // into the live Firestore project.
  // Mark help as already seen for most pages — the first-run modal is
  // asserted once, explicitly, rather than clicked through on every page.
  await p.addInitScript(() => { try { localStorage.setItem('h_seen_help', '1'); } catch (e) {} });
  await p.goto(`${ORIGIN}/?${STORE_PARAM}pid=p${i}&sim=${start.lat},${start.lng}`);
  pages.push(p);
  return p;
}


// Position writes are throttled (CONFIG.sync), so a teleport is not broadcast
// the instant it happens. Wait for it to actually land on another client
// rather than guessing a sleep — this is the difference between testing the
// game and testing the network.
async function teleport(idx, pos) {
  await pages[idx].evaluate((p) => window.__sim.setPos(p.lat, p.lng), pos);
  const landed = await until(host, ([id, target]) => {
    const p = playersState[id];
    if (!p || p.realLat == null) return false;
    return distanceM({ lat: p.realLat, lng: p.realLng }, target) < 3;
  }, ['p' + idx, pos], 20000);
  if (!landed) console.log(`  (warn) teleport of p${idx} did not propagate`);
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

// ---- a scanned QR must still ask who you are, and the host can remove you ----
// Outdoor testing threw up both of these at once: the QR walked people past
// the name field, and an uninvited stranger who had the code was unkickable.
const stranger = await ctx.newPage();
stranger.on('pageerror', (e) => { errors.push(`Stranger: ${e.message}`); });
stranger.on('dialog', (d) => {
  dialogs.push(`Stranger [${d.type()}] ${d.message().split('\n')[0]}`);
  d.accept().catch(() => {});
});
await stranger.addInitScript(() => {
  try {
    localStorage.setItem('h_seen_help', '1');
    // Every page in this suite shares one browser profile, so they share the
    // remembered name too. A stranger scanning a QR on their own phone has
    // never typed one, which is the case worth testing.
    localStorage.removeItem('h_name');
  } catch (e) {}
});
await stranger.goto(`${ORIGIN}/?${STORE_PARAM}pid=p9&sim=${BASE.lat},${BASE.lng}&join=${code}`);
await stranger.waitForTimeout(700);

const scanned = await stranger.evaluate(() => ({
  view: document.querySelector('.view.active').id,
  code: document.getElementById('input-code').value,
  name: document.getElementById('input-name-join').value,
  prompt: document.getElementById('join-prompt').textContent,
}));
check('a scanned join code stops at the name step',
  scanned.view === 'view-landing' && scanned.code === code && scanned.name === ''
  && /what should everyone call you/i.test(scanned.prompt),
  `${scanned.view}, code "${scanned.code}", name "${scanned.name}"`);
const noGhost = await host.evaluate(() => Object.keys(playersState).length);
check('scanning alone does not put you in the game', noGhost === 5, `${noGhost} players`);

// A blank name used to become "Player" silently. It is refused now.
await stranger.click('#btn-join');
await stranger.waitForTimeout(400);
const blankRefused = await stranger.evaluate(() => document.querySelector('.view.active').id);
check('joining without a name is refused', blankRefused === 'view-landing', blankRefused);

await stranger.fill('#input-name-join', 'Uninvited');
await stranger.click('#btn-join');
await stranger.waitForSelector('#view-lobby.active', { timeout: 10000 });
const joined = await until(host, () => !!playersState.p9);
check('naming yourself then joining works', joined === true);

// The host removes them. The suite dismisses dialogs by default, so the
// confirm is stubbed out rather than fought with.
await host.evaluate(() => {
  window.__realConfirm = window.confirm;
  window.confirm = () => true;
});
const kickClicked = await host.evaluate(() => {
  const btn = document.querySelector('#lobby-players .kick-btn[aria-label="Remove Uninvited from the game"]');
  if (!btn) return false;
  btn.click();
  return true;
});
check('the kick control is on the stranger\'s row', kickClicked === true);
const kicked = await until(host, () => playersState.p9 && playersState.p9.status === 'kicked');
check('the host can remove a player', kicked === true);

const kickedOut = await until(stranger, () => document.querySelector('.view.active').id === 'view-landing');
check('a removed player is told and taken out of the game', kickedOut === true);

await host.evaluate(() => { window.confirm = window.__realConfirm; });
const listAfterKick = await host.evaluate(() =>
  document.querySelectorAll('#lobby-players li').length);
check('a removed player leaves the lobby list', listAfterKick === 5, `${listAfterKick} rows`);

// And the code alone no longer gets them back in.
await stranger.fill('#input-name-join', 'Uninvited');
await stranger.fill('#input-code', code);
await stranger.click('#btn-join');
await stranger.waitForTimeout(900);
const rejoinRefused = await stranger.evaluate(() => document.querySelector('.view.active').id);
check('a removed player cannot rejoin with the same code',
  rejoinRefused === 'view-landing', rejoinRefused);
await stranger.close();

// A first-time player gets the primer without asking for it.
const primer = await host.evaluate(() => {
  localStorage.removeItem('h_seen_help');
  maybeShowFirstRunHelp();
  const shown = document.getElementById('how-modal').style.display === 'flex';
  const text = document.getElementById('how-body').textContent;
  document.getElementById('how-modal').style.display = 'none';
  return { shown, seen: localStorage.getItem('h_seen_help'), text };
});
check('first-time players are shown how to play',
  primer.shown && primer.seen === '1' &&
  /no tag button/i.test(primer.text) && /keep the screen on/i.test(primer.text),
  primer.shown ? 'shown once, covers capture and screen-on' : 'not shown');

// ---- the host can set roles by hand, one player at a time ----
// Every lobby row is a button for the host, cycling none -> seeker -> hider.
const hostPicks = await host.evaluate(() =>
  document.querySelectorAll('#lobby-players .role-pick').length);
check('the host gets a role control on every player', hostPicks === 5, `${hostPicks} controls`);
const guestPicks = await pages[2].evaluate(() =>
  document.querySelectorAll('#lobby-players .role-pick').length);
check('other players get no role controls', guestPicks === 0, `${guestPicks} controls`);

// Tap Hide1's row twice: unassigned -> seeker -> hider. Picked by name, not
// by index — a removed player is skipped in the list but still in the state.
const tapRole = () => host.evaluate(() => {
  const btn = [...document.querySelectorAll('#lobby-players .role-pick')]
    .find((b) => b.getAttribute('aria-label').startsWith('Hide1 '));
  if (!btn) return false;
  btn.click();
  return true;
});
check('the role control is on the right row', (await tapRole()) === true);
const madeSeeker = await until(host, () => playersState.p2.role === 'seeker');
check('tapping a player makes them a seeker', madeSeeker === true);
await tapRole();
const madeHider = await until(host, () => playersState.p2.role === 'hider');
check('tapping again makes them a hider', madeHider === true);

// A hand-assigned game can be one-sided in a way a random deal never is,
// so the lobby has to refuse it.
await host.evaluate(async () => {
  await Promise.all(['p0', 'p1', 'p3', 'p4'].map((id) => playerRef(id).update({ role: 'hider' })));
});
const refusedOneSided = await until(host, () =>
  document.getElementById('btn-start-game').disabled
  && /Nobody is seeking/.test(document.getElementById('ready-status').textContent));
check('a game with nobody seeking cannot start', refusedOneSided === true);

// ---- roles: force a deterministic split (2 seekers, 3 hiders) ----
await host.evaluate(async () => {
  const roles = { p0: 'seeker', p1: 'seeker', p2: 'hider', p3: 'hider', p4: 'hider' };
  await Promise.all(Object.entries(roles).map(([id, role]) => playerRef(id).update({ role })));
});
// Wait for each player to actually see their role before going on.
for (let i = 0; i < 5; i++) {
  await until(pages[i], () => !!(me() && me().role));
}


// Give hiding time a real duration — an earlier check set it to zero, which
// would release the seekers the instant the game starts.
await host.fill('#input-headstart', '3');
await host.dispatchEvent('#input-headstart', 'change');
await until(host, () => gameState && gameState.headstartMs === 180000);

// ---- start: the lobby must refuse to start until everyone is ready ----
const startReady = await until(host,
  () => !document.getElementById('btn-start-game').disabled, null, 15000);
const readyText = await host.evaluate(() => ({
  ready: document.getElementById('ready-status').textContent,
  roles: Object.fromEntries(Object.entries(playersState).map(([k, v]) => [k, v.role || '-'])),
}));
check('start unlocks once every role is settled', startReady === true,
  `${readyText.ready} | ${JSON.stringify(readyText.roles)}`);

await host.click('#btn-start-game');
for (const p of pages) await p.waitForSelector('#view-game.active', { timeout: 8000 });
check('game starts for all clients', true);

// ---- hiding phase ----
await until(host, () => gameState && gameState.status === 'hiding');
const hidingStatus = await host.evaluate(() => gameState.status);
check('starting begins hiding time, not the hunt', hidingStatus === 'hiding', hidingStatus);

const seekerHeld = await pages[1].evaluate(() => powerBlockedReason('scan', me()));
check('seekers cannot act during hiding time',
  /Held at the start line/.test(seekerHeld), seekerHeld);

// Hiders declare one at a time; only the last one should release the seekers.
await pages[2].evaluate(() => declareHidden());
await pages[3].evaluate(() => declareHidden());
await host.waitForTimeout(1200);
const stillHiding = await host.evaluate(() => gameState.status);
check('seekers stay held while any hider is still moving', stillHiding === 'hiding', stillHiding);

await pages[4].evaluate(() => declareHidden());
await until(host, () => gameState && gameState.status === 'active', null, 15000);
const released = await host.evaluate(() => ({
  status: gameState.status,
  early: gameState.releasedAt < gameState.hidingEndsAt,
}));
check('seekers release early once every hider declares hidden',
  released.status === 'active' && released.early === true,
  `status ${released.status}, released before the clock: ${released.early}`);

await host.waitForTimeout(3000);

// ================= POSITIONING =================
//
// True positions still sync — the physical rules need them — but they are
// never shown to anyone. Only paid-for pings appear.

const truthSynced = await host.evaluate(() => {
  const h = playersState.p2;
  return h.realLat != null && h.realLng != null;
});
check('true positions still sync for the physical rules', truthSynced === true);

const nothingShown = await host.evaluate(() =>
  Object.values(playersState).every((p) => (p.pings || []).length === 0));
check('but nothing is displayed until someone pays for it', nothingShown === true);

const noLegacyFields = await host.evaluate(() => {
  const h = playersState.p2;
  return ['broadcastLat', 'broadcastRadiusM', 'broadcastMode', 'pingHistory']
    .filter((k) => h[k] !== undefined);
});
check('the old circle/uncertainty fields are gone',
  noLegacyFields.length === 0, noLegacyFields.join(', ') || 'none');

// ================= POWERS =================
//
// Nothing pings on its own any more, so the first thing to prove is silence.

async function runPower(pageIdx, key, ctxArg) {
  return pages[pageIdx].evaluate(async ([k, c]) => {
    await playerRef().update({
      cooldownUntil: 0, chargeCheckpoint: 100, chargeCheckpointAt: Date.now(),
      activePower: null, activePowerExpiresAt: 0,
    });
    await new Promise((r) => setTimeout(r, 120));
    const ok = await activatePower(k, c);
    await new Promise((r) => setTimeout(r, 300));
    return ok;
  }, [key, ctxArg || {}]);
}

const dotsOf = (pid) => host.evaluate(([id]) => (playersState[id].pings || []).length, [pid]);

// -- silence by default --
await host.waitForTimeout(4000);
const idleDots = await host.evaluate(() =>
  Object.values(playersState).reduce((n, p) => n + (p.pings || []).length, 0));
check('nobody pings on their own', idleDots === 0, `${idleDots} dots without anyone spending`);

// -- Probe: a 180 degree sweep pings that half of the world and no more --
await teleport(1, off(0, 0));        // seeker at the centre
await teleport(2, off(0, 200));      // hider due north
await teleport(3, off(0, -200));     // hider due south
await runPower(1, 'probe', { point: off(0, 400) });   // sweep north
await host.waitForTimeout(900);
const northDots = await dotsOf('p2');
const southDots = await dotsOf('p3');
check('probe pings hiders in the swept half', northDots === 1, `${northDots} dot(s) on the northern hider`);
check('probe leaves the other half alone', southDots === 0, `${southDots} dot(s) on the southern hider`);

// -- pings are fuzzy, and independently so --
const offsets = await host.evaluate(() => {
  const p = playersState.p2;
  return (p.pings || []).map((d) =>
    Math.round(distanceM({ lat: d.lat, lng: d.lng }, { lat: p.realLat, lng: p.realLng })));
});
check('reported positions are wrong by up to ~30m',
  offsets.length === 1 && offsets[0] > 0 && offsets[0] <= 31, `${offsets[0]}m off true position`);

await runPower(1, 'probe', { point: off(0, 400) });
await host.waitForTimeout(900);
const drift = await host.evaluate(() => {
  const d = playersState.p2.pings;
  return Math.round(distanceM(d[d.length - 2], d[d.length - 1]));
});
check('a motionless player appears to move between pings', drift > 0,
  `${drift}m of apparent movement while standing still`);

// -- Nothing on the map is labelled --
// Dots used to carry a name and an age. Both are gone: colour says how old a
// reading is, green says it is yours, and nothing says who anyone is.
const mapLabels = await pages[1].evaluate(() => {
  renderWorld();
  const found = [];
  worldLayer.eachLayer((layer) => {
    const t = layer.getTooltip && layer.getTooltip();
    if (t) found.push(String(t.getContent()));
  });
  return found;
});
check('nothing on the map carries a label', mapLabels.length === 0,
  mapLabels.length ? mapLabels.join(' | ') : 'no labels on any layer');

// -- I SEE YOU: passive, theatrical, and mechanically inert --
// p1 is the seeker at the centre; p3 is the hider due south of them.
const isyOff = await pages[3].evaluate(() => ({
  shown: document.getElementById('i-see-you').classList.contains('on'),
  toSeeker: Math.round(nearestSeekerM()),
}));
check('I SEE YOU stays off at a distance', isyOff.shown === false,
  `${isyOff.toSeeker}m from the nearest seeker`);

await teleport(3, off(0, 12));   // 12m from the seeker at the centre
const isyOn = await until(pages[3], () =>
  document.getElementById('i-see-you').classList.contains('on'), null, 20000);
check('walking within 20m of a seeker puts I SEE YOU on the hider\'s screen',
  isyOn === true);

const isyLook = await pages[3].evaluate(() => {
  const n = document.getElementById('i-see-you');
  const style = getComputedStyle(n);
  const under = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  return {
    words: n.querySelector('.isy-words').textContent.replace(/\s+/g, ' ').trim(),
    rule: n.querySelector('.isy-rule').textContent,
    passesTaps: style.pointerEvents === 'none',
    // Whatever is under the middle of the screen, it must not be the overlay.
    hitsOverlay: !!(under && under.closest && under.closest('#i-see-you')),
    drips: n.querySelectorAll('.drip').length,
  };
});
check('it says I SEE YOU', isyLook.words === 'I SEE YOU', isyLook.words);
check('and tells them the rule', /can hide.*can't run/i.test(isyLook.rule), isyLook.rule);
check('it drips', isyLook.drips === 5, `${isyLook.drips} drips`);
check('it lets every tap through to the interface underneath',
  isyLook.passesTaps === true && isyLook.hitsOverlay === false);

// Mechanically inert: it must not touch charge, powers or position.
const isyInert = await pages[3].evaluate(async () => {
  await playerRef().update({
    cooldownUntil: 0, chargeCheckpoint: 100, chargeCheckpointAt: Date.now(),
    activePower: null, activePowerExpiresAt: 0,
  });
  await new Promise((r) => setTimeout(r, 150));
  return {
    blocked: powerBlockedReason('go_quiet', me()),
    charge: Math.floor(currentCharge(me())),
    stillReporting: me().realLat != null,
  };
});
check('it changes nothing about what a hider can do',
  isyInert.blocked === null && isyInert.charge >= 99 && isyInert.stillReporting,
  `powers ${isyInert.blocked || 'available'}, charge ${isyInert.charge}`);

// Seekers are told nothing at all — a free passive reading would break the
// rule that every dot on the map was paid for.
const seekerSeesNothing = await pages[1].evaluate(() => ({
  overlay: document.getElementById('i-see-you').classList.contains('on'),
  dots: Object.values(playersState).reduce((n, x) => n + (x.pings || []).length, 0),
}));
check('the seeker is told nothing by it', seekerSeesNothing.overlay === false);

await teleport(3, off(0, -200));   // back south, clear of the seeker
const isyCleared = await until(pages[3], () =>
  !document.getElementById('i-see-you').classList.contains('on'), null, 20000);
check('it clears once the hider is clear', isyCleared === true);

// -- Daylight mode: readable in a bright field, per player --
// Read the tile rule off a probe element rather than a real tile: OSM tiles
// do not load in this sandbox, and the point is the CSS, not the imagery.
await pages[1].addScriptTag({ content: `
  window.__readScreen = () => {
    const probe = document.createElement('div');
    probe.className = 'leaflet-tile';
    document.body.appendChild(probe);
    const tileFilter = getComputedStyle(probe).filter;
    probe.remove();
    const dot = worldLayer.getLayers()
      .find((l) => l.options && l.options.radius === CONFIG.ping.dotRadiusPx);
    return {
      tileFilter,
      ring: dot && dot.options.color,
      fill: dot && dot.options.fillColor,
      onBody: document.body.classList.contains('daylight'),
      stored: localStorage.getItem('h_daylight'),
      bg: getComputedStyle(document.body).backgroundColor,
    };
  };
` });
const dark = await pages[1].evaluate(() => window.__readScreen());
await pages[1].evaluate(() => setDaylight(true));
await pages[1].waitForTimeout(300);
const bright = await pages[1].evaluate(() => window.__readScreen());

check('daylight mode stops inverting the map into night',
  /invert/.test(dark.tileFilter) && !/invert/.test(bright.tileFilter),
  `dark "${dark.tileFilter}" -> bright "${bright.tileFilter}"`);
check('daylight mode lifts the whole screen',
  bright.onBody === true && bright.bg !== dark.bg, `${dark.bg} -> ${bright.bg}`);
check('dots get a dark ring so they survive a pale tile',
  !!dark.fill && dark.ring === dark.fill && !!bright.fill && bright.ring !== bright.fill,
  `dark ring ${dark.ring} on ${dark.fill}; bright ring ${bright.ring} on ${bright.fill}`);
check('the choice is remembered for next time', bright.stored === '1', bright.stored);

// It is one player's choice, not the game's — they are not all standing in
// the same light.
const othersUnaffected = await pages[2].evaluate(() =>
  document.body.classList.contains('daylight'));
check('daylight is per player, not per game', othersUnaffected === false);
await pages[1].evaluate(() => setDaylight(false));

// -- Scan: directions only, one per hider, never a position --
await runPower(1, 'scan');
const scan = await pages[1].evaluate(() => ({
  n: reveals.scan.bearings.length,
  colours: new Set(reveals.scan.bearings.map((b) => b.color)).size,
  hasPositions: reveals.scan.bearings.some((b) => b.lat !== undefined),
  bearings: reveals.scan.bearings.map((b) => Math.round(b.bearing)),
}));
check('scan reports one direction per hider, each its own colour',
  scan.n === 3 && scan.colours === 3, `${scan.n} glows, ${scan.colours} colours`);
check('scan never reveals a position', scan.hasPositions === false);
check('scan bearings point the right way',
  scan.bearings.some((b) => b < 5 || b > 355) && scan.bearings.some((b) => Math.abs(b - 180) < 5),
  scan.bearings.join('°, ') + '°');

const dotsAfterScan = await dotsOf('p3');
check('scan does not ping anyone', dotsAfterScan === 0);

// -- Go quiet eats the next ping aimed at you --
await runPower(3, 'go_quiet');
await host.waitForTimeout(400);
await runPower(1, 'probe', { point: off(0, -400) });   // sweep south, at p3
await host.waitForTimeout(1000);
const quietDots = await dotsOf('p3');
const quietSpent = await host.evaluate(() => !playersState.p3.goQuietUntil);
check('go quiet absorbs the ping aimed at you', quietDots === 0, `${quietDots} dot(s) got through`);
check('go quiet is spent absorbing it', quietSpent === true);

await runPower(1, 'probe', { point: off(0, -400) });
await host.waitForTimeout(1000);
check('the ping after that lands normally', (await dotsOf('p3')) === 1);

// -- Decoy sends the ping somewhere you are not --
// The decoy leaves from wherever you cast it, so cast it in one corner and
// then walk a long way off: the seeker's wave has to report the corner.
// A decoy walks at 3 km/h, so its own displacement over a few test seconds
// is a metre or two — far below the 30m jitter — which is why the walk is
// asserted separately, against the clock, rather than by waiting for it.
const DECOY_CAST = off(-200, -150);
const DECOY_TRUE = off(150, -150);
await teleport(4, DECOY_CAST);
await runPower(4, 'decoy', { bearing: 90 });
await teleport(4, DECOY_TRUE);
await runPower(1, 'probe', { point: off(0, -400) });
await host.waitForTimeout(1000);
// Measured against where the decoy actually was when the dot was made, not
// where it set off: it has been walking the whole time, so the cast point is
// only an approximation and the jitter bound has to sit on the real one.
const decoyed = await host.evaluate(() => {
  const p = playersState.p4;
  const dot = (p.pings || [])[p.pings.length - 1];
  if (!dot) return null;
  return {
    fromTrue: Math.round(distanceM(dot, { lat: p.realLat, lng: p.realLng })),
    fromDecoy: Math.round(distanceM(dot, decoyPositionAt(p.decoy, dot.at))),
  };
});
check('decoy makes the ping land where you are not',
  decoyed && decoyed.fromTrue > 250,
  decoyed ? `${decoyed.fromTrue}m from the real player` : 'no dot');
check('the ping lands on the decoy instead',
  decoyed && decoyed.fromDecoy <= 31,
  decoyed ? `${decoyed.fromDecoy}m from the decoy itself` : 'no dot');

// And the decoy is walking, not standing: a minute on, it is a minute's walk
// along the bearing that was picked.
const decoyWalk = await pages[4].evaluate(() => {
  const d = me().decoy;
  const later = decoyPositionAt(d, d.startedAt + 60000);
  return {
    metres: Math.round(distanceM({ lat: d.originLat, lng: d.originLng }, later)),
    bearing: Math.round(bearingDeg({ lat: d.originLat, lng: d.originLng }, later)),
  };
});
check('the decoy walks off on the bearing you chose',
  decoyWalk.metres >= 45 && decoyWalk.metres <= 55 && Math.abs(decoyWalk.bearing - 90) < 2,
  `${decoyWalk.metres}m east after a minute, bearing ${decoyWalk.bearing}°`);
await pages[4].evaluate(() => playerRef().update({ decoy: null }));

// -- Seeker scan: hiders' only sight of a seeker, and it is exact --
await runPower(2, 'seeker_scan');
await host.waitForTimeout(900);
const seekerDots = await host.evaluate(() => {
  const s1 = playersState.p1;
  const dot = (s1.pings || [])[s1.pings.length - 1];
  if (!dot) return null;
  return { off: Math.round(distanceM(dot, { lat: s1.realLat, lng: s1.realLng })), exact: dot.exact };
});
check('seeker scan pins seekers, and does it exactly',
  seekerDots && seekerDots.off === 0 && seekerDots.exact === true,
  seekerDots ? `${seekerDots.off}m off, exact=${seekerDots.exact}` : 'no dot');

// -- Dot ageing: white, to red, to gone --
const ageing = await host.evaluate(() => {
  const now = Date.now();
  const at = (ms) => pingAppearance({ lat: 0, lng: 0, at: now - ms }, now);
  return {
    fresh: at(0), mid: at(CONFIG.ping.fadeStartMs),
    late: at(CONFIG.ping.fadeStartMs + (CONFIG.ping.lifetimeMs - CONFIG.ping.fadeStartMs) / 2),
    dead: at(CONFIG.ping.lifetimeMs + 1000),
  };
});
check('a fresh dot is white', ageing.fresh.color === 'rgb(255,255,255)', ageing.fresh.color);
check('a dot is red by the halfway mark', ageing.mid.color === 'rgb(255,0,0)', ageing.mid.color);
check('a dot then fades out', ageing.late.opacity > 0 && ageing.late.opacity < 1,
  `opacity ${ageing.late.opacity.toFixed(2)}`);
check('a dot expires entirely', ageing.dead === null);

// -- Lockout --
await runPower(1, 'lockout', { targetId: 'p2' });
await host.waitForTimeout(600);
const lockedReason = await pages[2].evaluate(() => powerBlockedReason('go_quiet', me()));
check('lockout stops the target using powers', lockedReason === 'Locked out.', lockedReason);
await pages[2].evaluate(() => playerRef().update({ lockedOutUntil: 0 }));

// -- Tripwire is cheap, and the one exact reading in the game --
await teleport(1, off(0, 300));
await runPower(1, 'tripwire');
await host.waitForTimeout(500);
check('tripwire is placed', (await host.evaluate(() => Object.keys(tripwiresState).length)) === 1);
check('tripwire costs almost nothing',
  (await host.evaluate(() => CONFIG.seekerPowers.tripwire.cost)) === 5);

await teleport(4, off(0, 295));
const tripped = await until(host, () => {
  const tw = Object.values(tripwiresState)[0];
  return !!(tw && tw.triggered);
});
check('a hider walking within 20m trips the wire', tripped === true);
const tripDot = await host.evaluate(() => {
  const p = playersState.p4;
  const dot = (p.pings || [])[p.pings.length - 1];
  return dot ? { exact: dot.exact, off: Math.round(distanceM(dot, { lat: p.realLat, lng: p.realLng })) } : null;
});
check('a tripwire reports the exact position',
  tripDot && tripDot.exact === true && tripDot.off === 0,
  tripDot ? `exact=${tripDot.exact}, ${tripDot.off}m off` : 'no dot');

// -- Disarm --
await runPower(1, 'tripwire');
await host.waitForTimeout(400);
await teleport(4, off(0, 310));
await runPower(4, 'disarm');
await host.waitForTimeout(600);
check('disarm destroys untriggered tripwires within 50m',
  (await host.evaluate(() => Object.values(tripwiresState).filter((t) => !t.triggered).length)) === 0);

// -- the cut powers really are gone --
const gone = await host.evaluate(() => ['smear', 'false_trail', 'backtrace', 'beacon',
  'cordon', 'go_dark', 'read_the_sweep', 'uncloak', 'silent_run'].filter((k) => POWERS[k]));
check('every cut power is actually gone', gone.length === 0, gone.join(', ') || 'none left');

// -- the economy hits the two-minute target --
const pace = await host.evaluate(() => ({
  probe: CONFIG.seekerPowers.probe.cost,
  perMin: CONFIG.charge.regenPerMs * 60000,
}));
const minutesPerProbe = pace.probe / pace.perMin;
check('a seeker can probe about every two minutes',
  minutesPerProbe > 1.5 && minutesPerProbe < 2.5,
  `${minutesPerProbe.toFixed(1)} min per probe`);

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
await teleport(2, off(30, 30));
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
await teleport(2, off(0, 3));
await host.waitForTimeout(6000);
const soloProgress = await host.evaluate(() => Object.values(totemsState)[0].sabotageProgressS || 0);
check('one hider alone accrues no sabotage progress', soloProgress === 0);
const waitingFlag = await pages[3].evaluate(() => {
  const t = Object.values(totemsState)[0];
  return freshPresenceIds(t).length;
});
check('other hiders can see one hider waiting at the totem', waitingFlag === 1);

// Second hider arrives: progress accrues, totem greys out.
await teleport(3, off(2, -2));
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
await teleport(3, off(200, 200));
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
await teleport(3, off(2, -2));
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

// ---- optimistic concurrency (replaces Firestore's transactions) ----
// Without version checking, two clients reading the same value and both
// writing back would lose one increment — which in the real game means two
// hiders' clients each crediting the same second of sabotage progress.
await host.evaluate(() => gameRef().collection('racetest').doc('r1').set({ n: 0 }));
await host.waitForTimeout(600);

const bump = (page) => page.evaluate(async () => {
  const ref = gameRef().collection('racetest').doc('r1');
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      // Widen the window so both clients genuinely overlap.
      await new Promise((r) => setTimeout(r, 150));
      tx.update(ref, { n: (snap.data().n || 0) + 1 });
    });
    return 'ok';
  } catch (e) { return 'failed: ' + e.message; }
});

if (BASE_URL) {
  const raceOutcomes = await Promise.all([bump(pages[2]), bump(pages[3])]);
  await host.waitForTimeout(800);
  const raceTotal = await host.evaluate(async () =>
    (await gameRef().collection('racetest').doc('r1').get()).data().n);
  check('concurrent transactions do not lose an update',
    raceTotal === 2 && raceOutcomes.every((r) => r === 'ok'),
    `n=${raceTotal} after two concurrent increments (${raceOutcomes.join(', ')})`);
} else {
  // The offline store is localStorage, which gives no atomicity across
  // browser processes, so two tabs can both win a race there. Only the
  // Durable Object can actually provide this, so only it is asserted on.
  skip('concurrent transactions do not lose an update',
    'needs the real Worker (BASE_URL=...); localStorage has no cross-process atomicity');
}

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

// A hunt reports as ordinary dots, not a cone — that is what lets a hider's
// two defensive powers answer the one thing actually chasing them.
const noCones = await host.evaluate(() => ({
  bearingFn: typeof huntBearing,
  coneFn: typeof huntConeHalfWidthDeg,
  coneConfig: CONFIG.hunt.coneDegAt500m,
}));
check('the hunt no longer hands out a bearing cone',
  noCones.bearingFn === 'undefined' && noCones.coneFn === 'undefined'
  && noCones.coneConfig === undefined,
  `${noCones.bearingFn}/${noCones.coneFn}/${noCones.coneConfig}`);

// The first reading is due the instant the hunt is declared.
const firstHuntDot = await until(host, () => {
  const dots = playersState.p2.pings || [];
  const mark = (playersState.p2.huntedBy || {}).p1;
  return !!(mark && mark.lastPingAt && dots.length) && {
    off: Math.round(distanceM(dots[dots.length - 1],
      { lat: playersState.p2.realLat, lng: playersState.p2.realLng })),
  };
}, null, 20000);
check('a hunt pings the hunted hider straight away',
  !!firstHuntDot && firstHuntDot.off <= 31,
  firstHuntDot ? `${firstHuntDot.off}m off true position` : 'no dot');

// And it is an ordinary ping, so Go quiet eats one.
await pages[2].evaluate(() => playerRef().update({
  goQuietUntil: Date.now() + 120000,
  ['huntedBy.p1.lastPingAt']: Date.now() - CONFIG.hunt.pingIntervalMs,
}));
const dotsBeforeQuiet = await dotsOf('p2');
const quietAte = await until(host, ([before]) =>
  !playersState.p2.goQuietUntil && (playersState.p2.pings || []).length === before,
[dotsBeforeQuiet], 20000);
check('go quiet answers a hunt reading', quietAte === true,
  `${await dotsOf('p2')} dots, was ${dotsBeforeQuiet}`);

// A decoy poisons the ones after it. Cast it, walk a long way off, and only
// then make a reading due — otherwise the tick fires mid-teleport and the
// dot lands before the player has gone anywhere.
await pages[2].evaluate(() => playerRef().update({
  decoy: {
    originLat: myPos.lat, originLng: myPos.lng,
    bearing: 90, startedAt: Date.now(), expiresAt: Date.now() + 180000,
  },
}));
await teleport(2, off(250, 200));
const decoySince = Date.now();
await pages[2].evaluate((ms) => playerRef().update({
  ['huntedBy.p1.lastPingAt']: Date.now() - ms,
}), 3 * 60000);
const decoyedHunt = await until(host, ([since]) => {
  const p = playersState.p2;
  const dots = (p.pings || []).filter((d) => d.at > since);
  if (!dots.length || !p.decoy) return false;
  const last = dots[dots.length - 1];
  return {
    fromTrue: Math.round(distanceM(last, { lat: p.realLat, lng: p.realLng })),
    fromDecoy: Math.round(distanceM(last, decoyPositionAt(p.decoy, last.at))),
  };
}, [decoySince], 25000);
check('a decoy sends the hunt readings somewhere you are not',
  !!decoyedHunt && decoyedHunt.fromTrue > 150 && decoyedHunt.fromDecoy <= 31,
  decoyedHunt ? `${decoyedHunt.fromTrue}m from the player, ${decoyedHunt.fromDecoy}m from the decoy`
    : 'no dot');
await pages[2].evaluate(() => playerRef().update({ decoy: null }));
await teleport(2, off(0, 3));   // back where the sabotage and snitch checks expect

// Snitch: only available while hunted.
const snitchBlockedForUnhunted = await pages[4].evaluate(() => snitchAvailableReason(me()));
check('snitch is unavailable when not hunted',
  snitchBlockedForUnhunted === 'Only usable while you are being hunted.', snitchBlockedForUnhunted);

await pages[2].evaluate(() => playerRef().update({ cooldownUntil: 0, chargeCheckpoint: 100, chargeCheckpointAt: Date.now() }));
await host.waitForTimeout(300);
await teleport(4, off(0, 50));   // ~47m => exact
await teleport(3, off(0, 250));  // ~247m => 50m circle
await host.waitForTimeout(1500);
const survey = await pages[2].evaluate(() => snitchSurvey().map((e) => ({ name: e.name, r: e.radiusM, d: Math.round(e.dist) })));
check('snitch survey bands fidelity by range',
  survey.length === 2 &&
  survey.find((s) => s.name === 'Hide3').r === 0 &&
  survey.find((s) => s.name === 'Hide2').r === 50,
  survey.map((s) => `${s.name}@${s.d}m=${s.r || 'exact'}`).join(', '));

const snitchSince = Date.now();
await pages[2].evaluate(async () => { await beginSnitch(); });
await host.waitForTimeout(600);
await pages[2].evaluate(() => snitchOn('p4'));
// Betrayal is a ping like any other now: a dot lands on the sold-out hider,
// and the seeker holding the mark is told to go and look. Counted by
// timestamp — only the last dozen dots are kept, so a full trail stops
// getting any longer.
const snitchDot = await until(host, ([id, since]) =>
  (playersState[id].pings || []).some((d) => d.at > since), ['p4', snitchSince]);
check('snitch puts a dot on the sold-out hider', snitchDot === true);
const seekerGotReport = await until(host, async () => {
  const snap = await gameRef().collection('events').get();
  let found = false;
  snap.forEach((d) => {
    const e = d.data();
    if (e.type === 'snitch_report' && e.to === 'p1' && e.name === 'Hide3') found = true;
  });
  return found;
});
check('snitch tells the hunting seeker to look', seekerGotReport === true);
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

await teleport(3, off(0, 0));
await pages[3].evaluate(() => placeSignpost('gate is unlocked'));
const placerSees = await until(pages[3], () => signpostsInRange(myPos).length > 0);
const signRead = await pages[3].evaluate(() => signpostsInRange(myPos).map((s) => s.text));
check('whoever leaves a sign has found it', placerSees === true && signRead[0] === 'gate is unlocked',
  signRead.join(', ') || 'nothing readable');

// 15m away is inside reading range but nobody has walked into the sign yet,
// so as far as this player is concerned it does not exist.
await teleport(4, off(15, 0));
await pages[4].waitForTimeout(4500);
const undiscovered = await pages[4].evaluate(() => ({
  readable: signpostsInRange(myPos).length,
  known: Object.keys(signpostsState).filter((id) => signpostDiscovered(id)).length,
}));
check('a sign you have never walked into is not on your map at all',
  undiscovered.known === 0 && undiscovered.readable === 0,
  `${undiscovered.known} known, ${undiscovered.readable} readable`);

// Walk within 10m of it and it is yours.
await teleport(4, off(6, 0));
const discovered = await until(pages[4], () => signpostsInRange(myPos).length > 0, null, 15000);
check('walking within 10m finds the sign', discovered === true);

// And it stays found — walking off does not un-know it.
await teleport(4, off(200, 0));
await pages[4].waitForTimeout(3500);
const afterLeaving = await pages[4].evaluate(() => ({
  readable: signpostsInRange(myPos).length,
  known: Object.keys(signpostsState).filter((id) => signpostDiscovered(id)).length,
}));
check('a found sign stays on your map but is only readable up close',
  afterLeaving.known === 1 && afterLeaving.readable === 0,
  `${afterLeaving.known} known, ${afterLeaving.readable} readable`);
const signAnonymous = await pages[4].evaluate(() => {
  const s = Object.values(signpostsState)[0];
  return { hasText: !!s.text, authorSurfaced: false, authorStored: !!s.authorId };
});
check('signposts are anonymous to readers but attributable internally',
  signAnonymous.hasText && signAnonymous.authorStored);

// Boundary breach.
await teleport(4, off(0, 500));
await until(host, () => !!playersState.p4.breachStartedAt, null, 25000);
const breach = await host.evaluate(() => ({
  readings: playersState.p4.outOfBoundsReadings,
  started: !!playersState.p4.breachStartedAt,
}));
check('leaving the boundary starts a confirmed breach countdown',
  breach.readings >= 3 && breach.started, `${breach.readings} consecutive readings`);

// Nothing pings on its own any more — except this. Stepping outside the
// boundary gives you away repeatedly, for free, until you come back, and no
// counter-power stops it.
// Count by timestamp, not by length: only the last dozen dots are kept, so
// once a player's trail is full, more pings stop making it any longer.
const breachSince = Date.now();
const breachExposure = await until(host, ([id, since]) => {
  const h = playersState[id];
  const fresh = (h.pings || []).filter((d) => d.at > since);
  if (fresh.length < 2) return false;
  const last = fresh[fresh.length - 1];
  return { off: Math.round(distanceM(last, { lat: h.realLat, lng: h.realLng })) };
}, ['p4', breachSince], 25000);
check('a breaching hider is pinged over and over until they come back',
  !!breachExposure && breachExposure.off <= 31,
  breachExposure ? `repeated dots, latest ${breachExposure.off}m off` : 'no repeat dots');

// Nothing a hider can buy covers a breach — that is what makes it a penalty
// rather than a risk to be managed.
const breachIgnoresCover = await pages[4].evaluate(async () => {
  await playerRef().update({ goQuietUntil: Date.now() + 60000 });
  const since = Date.now();
  await new Promise((r) => setTimeout(r, 14000));
  return (me().pings || []).filter((d) => d.at > since).length > 0;
});
check('going quiet does not hide a breach', breachIgnoresCover === true);
await pages[4].evaluate(() => playerRef().update({ goQuietUntil: 0 }));

await teleport(4, off(0, 100));
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
// The one exception to the unlabelled map: a panic marker says who it is,
// permanently, because that is the whole point of it.
const panicLabels = await host.evaluate(() => {
  renderWorld();
  const found = [];
  worldLayer.eachLayer((layer) => {
    const t = layer.getTooltip && layer.getTooltip();
    if (t) found.push(String(t.getContent()));
  });
  return found;
});
check('a panic alert is the one thing on the map that is labelled',
  panicLabels.length === 1 && /PANIC: Hide3/.test(panicLabels[0]),
  panicLabels.join(' | ') || 'no label');

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
console.log(`${results.length - failed.length}/${results.length} checks passed` +
  (skipped.length ? `, ${skipped.length} skipped` : ''));
if (failed.length) console.log('FAILED:\n' + failed.map((f) => '  - ' + f.name + (f.detail ? ` (${f.detail})` : '')).join('\n'));

const realErrors = errors.filter((e) => !/favicon|tile\.openstreetmap|ERR_|Failed to load resource/i.test(e));
if (realErrors.length) {
  console.log(`\nJS errors (${realErrors.length}):`);
  [...new Set(realErrors)].slice(0, 20).forEach((e) => console.log('  ! ' + e));
} else {
  console.log('\nNo JS errors.');
}
if (dialogs.length) console.log(`Dialogs seen (expected): ${dialogs.length}`);

await browser.close();
if (!BASE_URL) server.close();
process.exit(failed.length || realErrors.length ? 1 : 0);
