import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

// Living-room mode: the indoor game, played with no GPS at all. Run with:
//   node test/living-room.mjs                                  offline store
//   BASE_URL=http://localhost:8787 node test/living-room.mjs    real Worker
const ROOT = path.join(path.resolve(new URL('..', import.meta.url).pathname), 'public');
const BASE_URL = process.env.BASE_URL || null;
const PORT = 8160;
const T = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0]; const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f));
});
if (!BASE_URL) await new Promise((r) => srv.listen(PORT, r));
const ORIGIN = BASE_URL || `http://localhost:${PORT}`;
const STORE = BASE_URL ? '' : 'mock=1&';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
async function until(page, fn, arg, ms = 15000) {
  const end = Date.now() + ms; let last;
  for (;;) {
    last = await page.evaluate(fn, arg);
    if (last) return last;
    if (Date.now() > end) return last;
    await page.waitForTimeout(250);
  }
}

const b = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
const pages = [];
async function open(i) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`p${i}: ${e.message}`));
  p.on('dialog', (d) => d.dismiss().catch(() => {}));
  // No ?sim= and no geolocation permission at all — this is the point: the
  // indoor game must work on a device with no usable GPS whatsoever.
  await p.addInitScript(() => { try { localStorage.setItem('h_seen_help', '1'); } catch (e) {} });
  await p.goto(`${ORIGIN}/?${STORE}pid=p${i}`);
  pages.push(p); return p;
}

const host = await open(0);
await host.fill('#input-name-host', 'Alex');
await host.selectOption('#input-mode', 'livingroom');
await host.dispatchEvent('#input-mode', 'change');
await host.click('#btn-host');
await host.waitForSelector('#view-lobby.active', { timeout: 15000 });
check('can host indoors with no GPS at all', true);

const code = await host.textContent('#lobby-code');
const cfg = await host.evaluate(() => ({
  mode: gameState.mode,
  lengthMin: gameState.gameLengthMin,
  boundaryPoints: (gameState.boundary || []).length,
  gameLenCfg: CONFIG.gameLengthMin,
  cooldown: CONFIG.charge.globalCooldownMs,
  huntCooldown: CONFIG.hunt.noCaptureCooldownMs,
  dotLife: CONFIG.ping.lifetimeMs,
}));
check('living-room mode generates its own play area', cfg.boundaryPoints === 4, `${cfg.boundaryPoints} corners`);
check('round is compressed to about ten minutes', cfg.gameLenCfg === 10, `${cfg.gameLenCfg} min`);
check('timers scale with the shorter round',
  cfg.cooldown < 15000 && cfg.huntCooldown < 100000 && cfg.dotLife < 90000,
  `cooldown ${cfg.cooldown / 1000}s, hunt ${cfg.huntCooldown / 1000}s, dot ${cfg.dotLife / 1000}s`);

for (let i = 1; i < 4; i++) {
  const p = await open(i);
  await p.fill('#input-name-join', 'P' + i);
  await p.fill('#input-code', code);
  await p.click('#btn-join');
  await p.waitForSelector('#view-lobby.active', { timeout: 15000 });
}
await host.waitForTimeout(800);
check('others join without a location prompt',
  (await host.evaluate(() => Object.keys(playersState).length)) === 4);

// The indoor game is the same code and the same game document as the outdoor
// one — the only difference is a set of CONFIG overrides keyed off the game's
// mode. So a player who joins has to pick those up from the game itself, not
// from having chosen the mode: if this drifts, joiners silently run the
// outdoor clock inside a ten-minute round.
const joinerCfg = await pages[1].evaluate(() => ({
  mode: gameState.mode,
  gameLen: CONFIG.gameLengthMin,
  cooldown: CONFIG.charge.globalCooldownMs,
  dotLife: CONFIG.ping.lifetimeMs,
}));
check('a joining player runs the same compressed config as the host',
  joinerCfg.mode === 'livingroom'
  && joinerCfg.gameLen === cfg.gameLenCfg
  && joinerCfg.cooldown === cfg.cooldown
  && joinerCfg.dotLife === cfg.dotLife,
  `${joinerCfg.gameLen} min, cooldown ${joinerCfg.cooldown / 1000}s, dot ${joinerCfg.dotLife / 1000}s`);

await host.evaluate(() => Promise.all([
  playerRef('p0').update({ role: 'seeker' }), playerRef('p1').update({ role: 'hider' }),
  playerRef('p2').update({ role: 'hider' }), playerRef('p3').update({ role: 'hider' }),
]));
for (let i = 0; i < 4; i++) await until(pages[i], () => !!(me() && me().role));
await until(host, () => !document.getElementById('btn-start-game').disabled);
await host.click('#btn-start-game');
await until(host, () => gameState.status === 'hiding');

const starts = await host.evaluate(() => Object.fromEntries(
  Object.entries(playersState).map(([k, v]) => [k, v.realLat != null])));
check('everyone is given a starting position', Object.values(starts).every(Boolean),
  JSON.stringify(starts));

const scattered = await host.evaluate(() => {
  const hiders = Object.values(playersState).filter((p) => p.role === 'hider');
  let maxGap = 0;
  for (let i = 0; i < hiders.length; i++) {
    for (let j = i + 1; j < hiders.length; j++) {
      maxGap = Math.max(maxGap, distanceM(
        { lat: hiders[i].realLat, lng: hiders[i].realLng },
        { lat: hiders[j].realLat, lng: hiders[j].realLng }));
    }
  }
  return Math.round(maxGap);
});
check('hiders are scattered, not stacked', scattered > 20, `${scattered}m apart at widest`);

// Walk a token and confirm it actually travels rather than teleporting.
const before = await pages[1].evaluate(() => ({ ...travelPos }));
const target = await pages[1].evaluate(() => {
  const b = gameState.boundary;
  const dest = { lat: b[1].lat, lng: b[1].lng };
  setTravelDestination(dest);
  return dest;
});
const moved = await until(pages[1], (t) => {
  const gone = distanceM(travelPos, t);
  return gone < 5 ? { arrived: true } : null;
}, target, 30000);
const after = await pages[1].evaluate(() => ({ ...travelPos }));
const travelled = await pages[1].evaluate(([a, bb]) => Math.round(distanceM(a, bb)), [before, after]);
check('tapping the map makes the token travel', !!(moved && moved.arrived) && travelled > 50,
  `${travelled}m covered`);

const seenByHost = await until(host, ([id, t]) => {
  const p = playersState[id];
  return p && p.realLat != null && distanceM({ lat: p.realLat, lng: p.realLng }, t) < 30;
}, ['p1', target], 20000);
check('travel is visible to the other players', !!seenByHost);

for (let i = 1; i < 4; i++) await pages[i].evaluate(() => declareHidden());
await until(host, () => gameState.status === 'active', null, 20000);
check('hiding and early release work indoors too',
  (await host.evaluate(() => gameState.status)) === 'active');

await pages[0].evaluate(async () => {
  await playerRef().update({ cooldownUntil: 0, chargeCheckpoint: 100, chargeCheckpointAt: Date.now(), activePower: null });
  await activatePower('scan', {});
});
const scan = await pages[0].evaluate(() => reveals.scan && reveals.scan.bearings.length);
check('seeker powers work indoors', typeof scan === 'number', `scan glowed for ${scan} hider(s)`);

// And a paid-for reading actually lands on a token, indoors, on the shorter
// clock — the whole point of the mode is that nothing else changes.
await pages[0].evaluate(async () => {
  await playerRef().update({ cooldownUntil: 0, chargeCheckpoint: 100, chargeCheckpointAt: Date.now(), activePower: null });
  // Aim the sweep straight at a hider, so this checks the plumbing rather
  // than where the tokens happened to scatter.
  const hider = Object.values(playersState).find((x) => x.role === 'hider' && x.realLat != null);
  await activatePower('probe', { point: { lat: hider.realLat, lng: hider.realLng } });
});
const probed = await until(host, () => Object.values(playersState)
  .some((p) => (p.pings || []).length > 0));
check('a probe still puts dots on the map indoors', probed === true);

console.log('\n' + '='.repeat(56));
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
const real = errors.filter((e) => !/tile\.openstreetmap|Failed to load resource|ERR_/i.test(e));
console.log(real.length ? 'JS errors:\n  ' + [...new Set(real)].join('\n  ') : 'No JS errors.');
await b.close(); if (!BASE_URL) srv.close();
process.exit(failed.length || real.length ? 1 : 0);
