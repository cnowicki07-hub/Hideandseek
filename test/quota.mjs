import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

// Measures traffic for a real game. Cloudflare has no per-write quota the way
// Firestore did, so the number that matters now is bytes over a phone's mobile
// data, plus how many messages the Durable Object has to process.
//
//   node test/quota.mjs                                  offline store
//   BASE_URL=http://localhost:8787 node test/quota.mjs   real Worker
const ROOT = path.join(path.resolve(new URL('..', import.meta.url).pathname), 'public');
const BASE_URL = process.env.BASE_URL || null;
const PORT = 8140;
const T = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0]; const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'text/plain' }); r.end(fs.readFileSync(f));
});
if (!BASE_URL) await new Promise((r) => srv.listen(PORT, r));
const ORIGIN = BASE_URL || `http://localhost:${PORT}`;
const STORE_PARAM = BASE_URL ? '' : 'mock=1&';
console.log(`measuring against ${ORIGIN}${BASE_URL ? ' (real Worker)' : ' (offline store)'}\n`);

const BASE = { lat: 51.5074, lng: -0.1278 };
const off = (e, n) => ({ lat: BASE.lat + n / 111320, lng: BASE.lng + e / (111320 * Math.cos(BASE.lat * Math.PI / 180)) });
const BOUNDARY = [off(-300, -300), off(300, -300), off(300, 300), off(-300, 300)];

const b = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const ctx = await b.newContext({ permissions: ['geolocation'], geolocation: { latitude: BASE.lat, longitude: BASE.lng } });

const pages = [];
async function open(i, start) {
  const p = await ctx.newPage();
  await p.goto(`${ORIGIN}/?${STORE_PARAM}pid=p${i}&sim=${start.lat},${start.lng}`);
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

for (const p of pages) {
  await p.evaluate(() => { __storeStats.ops = 0; __storeStats.messages = 0; __storeStats.bytesSent = 0; __storeStats.bytesReceived = 0; });
}

const MEASURE_MS = 60000;
const t0 = Date.now();
// Walk everyone at a realistic pace: ~1.4 m/s, GPS pushing at 1 Hz.
const walker = setInterval(() => {
  for (const p of pages) p.evaluate(() => window.__sim.moveBy(1.4, 0)).catch(() => {});
}, 1000);
await host.waitForTimeout(MEASURE_MS);
clearInterval(walker);
const elapsed = (Date.now() - t0) / 1000;

const totals = { ops: 0, messages: 0, bytesSent: 0, bytesReceived: 0 };
let worstDown = 0;
for (const p of pages) {
  const s = await p.evaluate(() => ({ ...__storeStats }));
  totals.ops += s.ops; totals.messages += s.messages;
  totals.bytesSent += s.bytesSent; totals.bytesReceived += s.bytesReceived;
  worstDown = Math.max(worstDown, s.bytesReceived);
}

const PLAYERS = pages.length;
const scale = (90 * 60) / elapsed;
const mb = (bytes) => (bytes * scale / 1048576).toFixed(1) + ' MB';
const perGame = (n) => Math.round(n * scale).toLocaleString();

console.log(`measured window: ${elapsed.toFixed(0)}s, ${PLAYERS} players walking\n`);
console.log(`  writes sent        ${perGame(totals.ops).padStart(9)} per 90-min game`);
console.log(`  messages to the DO ${perGame(totals.messages).padStart(9)} per 90-min game`);
console.log(`  uplink, all players ${mb(totals.bytesSent).padStart(8)}`);
console.log(`  downlink, worst single phone ${mb(worstDown).padStart(8)}`);

// A phone on mobile data is the constraint worth watching. Deltas keep this
// small; broadcasting whole game state instead would multiply it by the size
// of the game.
const worstMb = worstDown * scale / 1048576;
console.log(worstMb > 50
  ? `\n  WARNING: ${worstMb.toFixed(0)} MB down per phone is a lot of mobile data.`
  : `\n  ok: comfortably small for mobile data.`);

await b.close(); if (!BASE_URL) srv.close();
process.exit(worstMb > 50 ? 1 : 0);
