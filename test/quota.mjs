import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

// Measures how many Firestore writes a real game would cost, against the
// free Spark quota. Run with:  node test/quota.mjs
// Writing position on every GPS fix once cost ~88,000 writes per game and
// would have died ~20 minutes in, so this is worth re-running after any
// change to how often the client writes.
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PORT = 8140;
const T = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0]; const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(PORT, r));

const BASE = { lat: 51.5074, lng: -0.1278 };
const off = (e, n) => ({ lat: BASE.lat + n / 111320, lng: BASE.lng + e / (111320 * Math.cos(BASE.lat * Math.PI / 180)) });
const BOUNDARY = [off(-300, -300), off(300, -300), off(300, 300), off(-300, 300)];

const b = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const ctx = await b.newContext({ permissions: ['geolocation'], geolocation: { latitude: BASE.lat, longitude: BASE.lng } });

const pages = [];
async function open(i, start) {
  const p = await ctx.newPage();
  await p.goto(`http://localhost:${PORT}/?mock=1&pid=p${i}&sim=${start.lat},${start.lng}`);
  pages.push(p); return p;
}

const host = await open(0, off(0, 0));
await host.fill('#input-name-host', 'H'); await host.click('#btn-host');
await host.waitForSelector('#view-lobby.active');
const code = await host.textContent('#lobby-code');
await host.evaluate((x) => setBoundary(x), BOUNDARY);
for (let i = 1; i < 5; i++) {
  const p = await open(i, off(i * 30, i * 20));
  await p.fill('#input-name-join', 'P' + i); await p.fill('#input-code', code); await p.click('#btn-join');
  await p.waitForSelector('#view-lobby.active');
}
await host.evaluate(() => Promise.all([
  playerRef('p0').update({ role: 'seeker' }), playerRef('p1').update({ role: 'seeker' }),
  playerRef('p2').update({ role: 'hider' }), playerRef('p3').update({ role: 'hider' }),
  playerRef('p4').update({ role: 'hider' }),
]));
await host.waitForTimeout(600);
await host.click('#btn-start-game');
await host.evaluate(() => gameRef().update({ seekersReleaseAt: Date.now() - 1 }));
for (const p of pages) await p.waitForSelector('#view-game.active');
await host.waitForTimeout(2000);

// Reset counters, then run a measured window with everyone walking.
for (const p of pages) await p.evaluate(() => { __dbStats.writes = 0; __dbStats.docReads = 0; });

const MEASURE_MS = 60000;
const t0 = Date.now();
// Walk everyone at a realistic pace: ~1.4 m/s, GPS pushing at 1 Hz.
const walker = setInterval(async () => {
  for (const p of pages) {
    p.evaluate(() => window.__sim.moveBy(1.4, 0)).catch(() => {});
  }
}, 1000);
await host.waitForTimeout(MEASURE_MS);
clearInterval(walker);
const elapsed = (Date.now() - t0) / 1000;

let writes = 0;
for (const p of pages) writes += await p.evaluate(() => __dbStats.writes);

const PLAYERS = pages.length;
const GAME_S = 90 * 60;
const scale = GAME_S / elapsed;
const projWrites = Math.round(writes * scale);
// Firestore bills one read per changed document per listening client. Every
// client here subscribes to the players collection, so a write costs one
// read on each. The harness's own read counter can't be used: it re-emits
// every listener on every write, which real Firestore does not.
const projReads = projWrites * PLAYERS;

console.log(`measured window: ${elapsed.toFixed(0)}s, ${PLAYERS} players walking\n`);
console.log(`  writes  ${projWrites.toLocaleString().padStart(9)} per 90-min game   (measured)`);
console.log(`  reads   ${projReads.toLocaleString().padStart(9)} per 90-min game   (estimated: writes x ${PLAYERS} listeners)`);
console.log('\nFirestore Spark free tier: 20,000 writes/day, 50,000 reads/day');
const verdict = (label, projected, limit) => console.log(projected > limit
  ? `  FAIL ${label}: over by ${(projected - limit).toLocaleString()}`
  : `  ok   ${label}: ${(limit - projected).toLocaleString()} spare`);
verdict('writes', projWrites, 20000);
verdict('reads ', projReads, 50000);

await b.close(); srv.close();
process.exit(projWrites > 20000 || projReads > 50000 ? 1 : 0);
