// Simulation harness. Not a rule suite — this drives the real game through
// situations the e2e suite does not: a host who walks away, odd player
// counts, everyone acting at once, and a game left running long enough for
// anything unbounded to show itself.
//
//   node test/sim.mjs                 # all scenarios, offline store
//   node test/sim.mjs host            # one scenario by name
//   BASE_URL=http://localhost:8787 node test/sim.mjs
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(path.resolve(new URL('..', import.meta.url).pathname), 'public');
const BASE_URL = process.env.BASE_URL || null;
const PORT = 8321;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});
if (!BASE_URL) await new Promise((r) => server.listen(PORT, r));
const ORIGIN = BASE_URL || `http://localhost:${PORT}`;
const STORE = BASE_URL ? '' : 'mock=1&';

const only = process.argv[2];
const findings = [];
const notes = [];
function finding(severity, title, detail) {
  findings.push({ severity, title, detail });
  console.log(`  ${severity === 'bug' ? 'BUG ' : 'NOTE'}  ${title}\n        ${detail}`);
}
function ok(title, detail) {
  notes.push(title);
  console.log(`  ok    ${title}${detail ? '  — ' + detail : ''}`);
}

const BASE = { lat: 51.5074, lng: -0.1278 };
const off = (dE, dN) => ({
  lat: BASE.lat + dN / 111320,
  lng: BASE.lng + dE / (111320 * Math.cos(BASE.lat * Math.PI / 180)),
});
const BOUNDARY = [off(-300, -300), off(300, -300), off(300, 300), off(-300, 300)];

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});

async function until(page, fn, arg, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() > deadline) return v;
    await page.waitForTimeout(200);
  }
}

// One isolated game: its own browser context, its own mock store, its own
// game code, so scenarios cannot contaminate each other.
async function newGame(n, opts = {}) {
  const tag = 'g' + Math.random().toString(36).slice(2, 7);
  const ctx = await browser.newContext({
    permissions: ['geolocation'], geolocation: { latitude: BASE.lat, longitude: BASE.lng },
  });
  const errors = [];
  const pages = [];
  for (let i = 0; i < n; i++) {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`p${i}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`p${i} console: ${m.text()}`); });
    p.on('dialog', (d) => d.dismiss().catch(() => {}));
    await p.addInitScript(() => {
      try { localStorage.setItem('h_seen_help', '1'); localStorage.removeItem('h_name'); } catch (e) {}
    });
    const start = off((i - n / 2) * 40, (i % 3) * 50);
    await p.goto(`${ORIGIN}/?${STORE}pid=${tag}_${i}&sim=${start.lat},${start.lng}`);
    pages.push(p);
  }

  const host = pages[0];
  await host.fill('#input-name-host', 'P0');
  await host.fill('#input-area-side', '600');
  if (opts.endMode) await host.selectOption('#input-end-mode', opts.endMode);
  if (opts.lengthMin) await host.fill('#input-length', String(opts.lengthMin));
  await host.click('#btn-host');
  await host.waitForSelector('#view-lobby.active', { timeout: 20000 });
  const code = await host.textContent('#lobby-code');
  await host.evaluate((b) => setBoundary(b), BOUNDARY);

  for (let i = 1; i < n; i++) {
    await pages[i].fill('#input-name-join', 'P' + i);
    await pages[i].fill('#input-code', code);
    await pages[i].click('#btn-join');
    await pages[i].waitForSelector('#view-lobby.active', { timeout: 20000 });
  }

  const seekers = opts.seekers == null ? Math.max(1, Math.floor(n / 3)) : opts.seekers;
  await host.evaluate(([ids, ns]) => Promise.all(ids.map((id, i) =>
    playerRef(id).update({ role: i < ns ? 'seeker' : 'hider' }))),
  [pages.map((_, i) => `${tag}_${i}`), seekers]);
  for (const p of pages) await until(p, () => !!(me() && me().role));

  await host.fill('#input-headstart', '0');
  await host.dispatchEvent('#input-headstart', 'change');
  await until(host, () => gameState && gameState.headstartMs === 0);
  await until(host, () => !document.getElementById('btn-start-game').disabled);
  await host.click('#btn-start-game');
  for (const p of pages) await p.waitForSelector('#view-game.active', { timeout: 20000 });
  for (const p of pages) {
    await p.evaluate(() => { if (me().role === 'hider') declareHidden(); });
  }
  await until(host, () => gameState.status === 'active', null, 20000);

  return {
    ctx, pages, host, code, tag, errors,
    id: (i) => `${tag}_${i}`,
    close: async () => { await ctx.close(); },
  };
}

const SCENARIOS = {};
const CONFIG_EVENT_KEEP_MIN = 5;   // CONFIG.events.keepMs, in minutes

// ---------------------------------------------------------------
// 1. The host walks away
//
// Seeker release, marking people away, and ending the game all run on the
// host's client only. What happens when that client stops?
// ---------------------------------------------------------------
SCENARIOS.host = async () => {
  // Two seekers, so one is left playing after the host walks off.
  const g = await newGame(4, { seekers: 2 });
  // The host quits — a real thing to do when your battery dies or you have
  // to go home.
  await g.host.evaluate(() => quitGame());
  await g.host.waitForTimeout(500);

  // Now capture every hider. In elimination mode that should end the game.
  await g.pages[1].evaluate(async ([ids]) => {
    for (const id of ids) {
      const t = playersState[id];
      if (t && t.role === 'hider' && t.status === 'active') {
        // eslint-disable-next-line no-await-in-loop
        await confirmCapture(id);
      }
    }
  }, [[g.id(2), g.id(3)]]);

  const ended = await until(g.pages[1], () => gameState.status === 'ended', null, 14000);
  const state = await g.pages[1].evaluate(() => ({
    status: gameState.status,
    hidersLeft: Object.values(playersState)
      .filter((p) => p.role === 'hider' && p.status === 'active').length,
    hostStatus: Object.values(playersState).find((p) => p.isHost).status,
  }));
  if (!ended) {
    finding('bug', 'the game cannot end once the host stops playing',
      `every hider captured (${state.hidersLeft} left) and the game is still "${state.status}" — `
      + `tickHostChecks only runs on the host's client, and tick() returns early `
      + `for a player whose status is "${state.hostStatus}"`);
  } else {
    ok('a game still ends after the host quits');
  }
  await g.close();
  return g.errors;
};

// ---------------------------------------------------------------
// 2. The host closes their phone during hiding time
// ---------------------------------------------------------------
SCENARIOS.release = async () => {
  const g = await newGame(4, { seekers: 1 });
  await g.close();

  // Fresh game, stopped before the hiders declare.
  const tag = 'r' + Math.random().toString(36).slice(2, 6);
  const ctx = await browser.newContext({
    permissions: ['geolocation'], geolocation: { latitude: BASE.lat, longitude: BASE.lng } });
  const errors = [];
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`p${i}: ${e.message}`));
    p.on('dialog', (d) => d.dismiss().catch(() => {}));
    await p.addInitScript(() => { try { localStorage.setItem('h_seen_help', '1'); } catch (e) {} });
    await p.goto(`${ORIGIN}/?${STORE}pid=${tag}_${i}&sim=${BASE.lat},${BASE.lng}`);
    pages.push(p);
  }
  const host = pages[0];
  await host.fill('#input-name-host', 'H');
  await host.click('#btn-host');
  await host.waitForSelector('#view-lobby.active', { timeout: 20000 });
  const code = await host.textContent('#lobby-code');
  await host.evaluate((b) => setBoundary(b), BOUNDARY);
  for (let i = 1; i < 3; i++) {
    await pages[i].fill('#input-name-join', 'P' + i);
    await pages[i].fill('#input-code', code);
    await pages[i].click('#btn-join');
    await pages[i].waitForSelector('#view-lobby.active', { timeout: 20000 });
  }
  await host.evaluate(([ids]) => Promise.all(ids.map((id, i) =>
    playerRef(id).update({ role: i === 0 ? 'seeker' : 'hider' }))),
  [[`${tag}_0`, `${tag}_1`, `${tag}_2`]]);
  for (const p of pages) await until(p, () => !!(me() && me().role));
  await host.fill('#input-headstart', '0.1');   // 6 seconds
  await host.dispatchEvent('#input-headstart', 'change');
  await until(host, () => gameState && gameState.headstartMs === 6000);
  await until(host, () => !document.getElementById('btn-start-game').disabled);
  await host.click('#btn-start-game');
  await until(host, () => gameState.status === 'hiding');

  // The host's phone goes dark. The hiding clock should still run out.
  await host.evaluate(() => closePhone());
  const released = await until(pages[1], () => gameState.status === 'active', null, 20000);
  if (!released) {
    finding('bug', 'seekers are never released if the host closes their phone during hiding time',
      'the hiding clock is enforced only by the host\'s tick, so the game sits in "hiding" '
      + 'indefinitely and nobody can do anything');
  } else {
    ok('the seekers are released even with the host\'s phone shut');
  }
  await ctx.close();
  return errors;
};

// ---------------------------------------------------------------
// 3. Odd player counts
//
// The game is written for five. What does two do? What does twelve?
// ---------------------------------------------------------------
SCENARIOS.counts = async () => {
  const allErrors = [];
  for (const [n, seekers] of [[2, 1], [3, 2], [8, 2], [12, 4]]) {
    const g = await newGame(n, { seekers });
    allErrors.push(...g.errors);

    // Everybody spends everything they have, at once.
    await Promise.all(g.pages.map((p) => p.evaluate(async () => {
      await playerRef().update({
        cooldownUntil: 0, chargeCheckpoint: 100, chargeCheckpointAt: Date.now(),
        activePower: null, activePowerExpiresAt: 0,
      });
      await new Promise((r) => setTimeout(r, 120));
      const mine = Object.keys(POWERS).filter((k) => POWERS[k].role === me().role);
      for (const k of mine) {
        const def = POWERS[k];
        const ctx = def.target === 'point' ? { point: { lat: myPos.lat + 0.002, lng: myPos.lng } }
          : def.target === 'bearing' ? { bearing: 45 }
          : def.target === 'hider'
            ? { targetId: Object.keys(playersState).find((id) => playersState[id].role === 'hider') }
            : {};
        // eslint-disable-next-line no-await-in-loop
        try { await activatePower(k, ctx); } catch (e) { /* recorded as a page error */ }
      }
    })));
    await g.host.waitForTimeout(1500);

    const health = await g.host.evaluate(() => ({
      charges: Object.values(playersState).map((p) => Math.floor(currentCharge(p))),
      statuses: Object.values(playersState).map((p) => p.status),
      dots: Object.values(playersState).reduce((a, p) => a + (p.pings || []).length, 0),
      totems: Object.keys(totemsState).length,
      status: gameState.status,
    }));
    const negative = health.charges.filter((c) => c < 0);
    if (negative.length) {
      finding('bug', `charge can go negative with ${n} players`,
        `charges after everyone spent everything: ${health.charges.join(', ')}`);
    }
    const odd = health.statuses.filter((s) => s !== 'active' && s !== 'captured');
    if (odd.length) {
      finding('note', `unexpected statuses at ${n} players`, odd.join(', '));
    }
    ok(`${n} players, ${seekers} seeker(s): everyone spent everything`,
      `${health.dots} dots, ${health.totems} totem(s), charges ${Math.min(...health.charges)}–${Math.max(...health.charges)}`);
    await g.close();
  }
  return allErrors;
};

// ---------------------------------------------------------------
// 4. Everyone captures the same hider at once
// ---------------------------------------------------------------
SCENARIOS.race = async () => {
  const g = await newGame(5, { seekers: 3 });
  const victim = g.id(4);
  await Promise.all([g.pages[0], g.pages[1], g.pages[2]].map((p) =>
    p.evaluate((id) => confirmCapture(id), victim)));
  await g.host.waitForTimeout(1200);

  const after = await g.host.evaluate(([id]) => {
    const v = playersState[id];
    return {
      role: v.role, status: v.status, charge: Math.floor(currentCharge(v)),
      convertedAt: v.convertedAt,
      lastCaptureAt: gameState.lastCaptureAt,
    };
  }, [victim]);
  if (after.role !== 'seeker') {
    finding('bug', 'a hider captured by three seekers at once did not convert',
      `role ${after.role}, status ${after.status}`);
  } else if (after.charge > CONFIG_CONVERSION + 5) {
    finding('note', 'a triple capture may credit conversion charge more than once',
      `${after.charge} charge, expected about ${CONFIG_CONVERSION}`);
  } else {
    ok('three simultaneous captures convert the hider exactly once',
      `${after.role}, ${after.charge} charge`);
  }
  await g.close();
  return g.errors;
};
const CONFIG_CONVERSION = 30;

// ---------------------------------------------------------------
// 5. Left running
//
// Anything that only ever grows shows up here.
// ---------------------------------------------------------------
SCENARIOS.soak = async () => {
  const g = await newGame(4, { seekers: 2 });
  const sample = () => g.host.evaluate(() => ({
    events: Object.keys(window.__eventCount || {}).length,
    chat: Object.keys(chatState).length,
    pings: Object.values(playersState).reduce((a, p) => a + (p.pings || []).length, 0),
    track: Object.values(playersState).reduce((a, p) => a + (p.track || []).length, 0),
    handled: typeof handledEvents !== 'undefined' ? handledEvents.size : -1,
    layers: worldLayer ? worldLayer.getLayers().length : -1,
  }));

  // Count events by watching the collection directly.
  await g.host.evaluate(() => {
    window.__eventCount = {};
    gameRef().collection('events').onSnapshot((snap) => {
      snap.forEach((d) => { window.__eventCount[d.id] = 1; });
    });
  });

  const before = await sample();
  // Two minutes of ordinary play: probes, taunts, chat, walking.
  const rounds = 8;
  for (let r = 0; r < rounds; r++) {
    await Promise.all(g.pages.map((p, i) => p.evaluate(async ([idx, tick]) => {
      await playerRef().update({
        cooldownUntil: 0, chargeCheckpoint: 100, chargeCheckpointAt: Date.now(),
        activePower: null, activePowerExpiresAt: 0, tauntCooldownUntil: 0,
      });
      await new Promise((r2) => setTimeout(r2, 100));
      window.__sim.moveBy(15 * ((idx % 2) ? 1 : -1), 10 * tick);
      if (me().role === 'seeker') {
        await activatePower('probe', { point: { lat: myPos.lat + 0.003, lng: myPos.lng } });
      } else {
        await sendTaunt('again');
        await sendChat('round ' + tick);
      }
    }, [i, r])));
    await g.host.waitForTimeout(1400);
  }
  const after = await sample();

  const grew = (k) => after[k] - before[k];
  ok('two minutes of hard play',
    `events +${grew('events')}, chat +${grew('chat')}, dots ${after.pings}, `
    + `track points ${after.track}, map layers ${after.layers}`);

  // Events used to accumulate for the whole game, and a client joining late
  // was sent every one of them. The conductor prunes now — check it holds.
  const perMin = Math.round(grew('events') / 2);
  const live = await g.host.evaluate(() => {
    lastPruneAt = 0;
    pruneStaleEvents(Date.now());
    return new Promise((r) => setTimeout(
      () => r(Object.keys(eventsState).length), 800));
  });
  const projected = perMin * (CONFIG_EVENT_KEEP_MIN);
  if (live > Math.max(40, projected * 2)) {
    finding('note', 'the events collection is still growing faster than it is pruned',
      `${live} live after a prune, at about ${perMin} new events a minute`);
  } else {
    ok('event history stays bounded under load',
      `${perMin} events a minute, ${live} live after pruning — a late joiner's `
      + 'first payload does not grow with the length of the game');
  }
  if (grew('chat') > 0) {
    ok('chat is kept', `${grew('chat')} messages stored (display caps at ${120})`);
  }
  if (after.pings > 12 * Object.keys(await g.host.evaluate(() => playersState)).length) {
    finding('bug', 'ping trails are not capped per player', `${after.pings} dots stored`);
  }
  await g.close();
  return g.errors;
};

// ---------------------------------------------------------------
// 6. Balance: how findable is a hider, really?
//
// Not a rule check — a measurement. A seeker with charge to burn works a
// half of the map at a time; how long does it take to close on somebody who
// is spending everything they have to stay hidden?
// ---------------------------------------------------------------
SCENARIOS.balance = async () => {
  const g = await newGame(3, { seekers: 1 });
  const rounds = 14;
  const log = [];

  for (let r = 0; r < rounds; r++) {
    // Hider defends on a budget: go quiet when it is affordable, decoy
    // occasionally, otherwise just keep walking.
    await g.pages[1].evaluate(async ([tick]) => {
      const p = me();
      if (p.status !== 'active') return;
      window.__sim.moveBy(30 * Math.cos(tick), 30 * Math.sin(tick));
      if (currentCharge(p) >= 35 && tick % 4 === 0) {
        await activatePower('decoy', { bearing: (tick * 57) % 360 });
      } else if (currentCharge(p) >= 20 && tick % 2 === 0) {
        await activatePower('go_quiet', {});
      }
    }, [r]);

    const before = await g.host.evaluate(([id]) => (playersState[id].pings || []).length, [g.id(1)]);
    const spent = await g.pages[0].evaluate(async () => {
      const p = me();
      if (currentCharge(p) < CONFIG.seekerPowers.probe.cost) return null;
      const target = Object.values(playersState).find((x) => x.role === 'hider' && x.realLat);
      if (!target) return null;
      await activatePower('probe', { point: { lat: target.realLat, lng: target.realLng } });
      return true;
    });
    await g.host.waitForTimeout(900);
    if (spent) {
      const got = await g.host.evaluate(([id, n]) => {
        const dots = playersState[id].pings || [];
        if (dots.length <= n && !(dots.length === CONFIG.ping.maxStored)) return { hit: false };
        const d = dots[dots.length - 1];
        return { hit: true, off: Math.round(distanceM(d,
          { lat: playersState[id].realLat, lng: playersState[id].realLng })) };
      }, [g.id(1), before]);
      log.push(got);
    }
    await g.host.waitForTimeout(600);
  }

  const attempts = log.length;
  const hits = log.filter((l) => l.hit).length;
  const offs = log.filter((l) => l.hit).map((l) => l.off);
  const mean = offs.length ? Math.round(offs.reduce((a, b) => a + b, 0) / offs.length) : 0;
  ok('a seeker probing a defended hider',
    `${hits}/${attempts} probes landed a dot, mean error ${mean}m`);
  // Reported as a measurement, not a defect: a hider's powers are designed to
  // degrade a reading rather than deny it, and the charge cost is what limits
  // how often a seeker can take one.
  if (attempts) {
    notes.push('balance');
    console.log(`        Go quiet eats one ping outright and a decoy relocates the rest; `
      + `neither stops a seeker learning roughly where to look, which is the `
      + `intended shape. The limiter is the ${30} charge a probe costs.`);
  }
  await g.close();
  return g.errors;
};

// ---------------------------------------------------------------
// 7. Degenerate play areas
// ---------------------------------------------------------------
SCENARIOS.geometry = async () => {
  const ctx = await browser.newContext({
    permissions: ['geolocation'], geolocation: { latitude: BASE.lat, longitude: BASE.lng } });
  const errors = [];
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.dismiss().catch(() => {}));
  await p.addInitScript(() => { try { localStorage.setItem('h_seen_help', '1'); } catch (e) {} });
  await p.goto(`${ORIGIN}/?${STORE}pid=geo0&sim=${BASE.lat},${BASE.lng}`);
  await p.fill('#input-name-host', 'G');
  await p.click('#btn-host');
  await p.waitForSelector('#view-lobby.active', { timeout: 20000 });

  const shapes = await p.evaluate(([o]) => {
    const at = (dE, dN) => ({
      lat: o.lat + dN / 111320,
      lng: o.lng + dE / (111320 * Math.cos(o.lat * Math.PI / 180)),
    });
    const cases = {
      collinear: [at(0, 0), at(100, 0), at(200, 0)],
      tiny: [at(0, 0), at(3, 0), at(3, 3), at(0, 3)],
      hairpin: [at(0, 0), at(500, 1), at(0, 2), at(500, 3)],
      huge: [at(-50000, -50000), at(50000, -50000), at(50000, 50000), at(-50000, 50000)],
    };
    const out = {};
    Object.entries(cases).forEach(([name, pts]) => {
      const area = polygonAreaM2(pts);
      const m = computeM(area);
      out[name] = {
        area: Math.round(area), m: Math.round(m),
        jitter: pingJitterM(m), totem: totemRadiusM(m),
        tripwire: tripwireRadiusM(m),
        headstartMin: +(headstartMsFor(polygonLongestDiagonalM(pts), 90) / 60000).toFixed(1),
        insideCentre: pointInPolygon(at(1, 1), pts),
        finite: Number.isFinite(area) && Number.isFinite(m),
      };
    });
    return out;
  }, [BASE]);

  Object.entries(shapes).forEach(([name, s]) => {
    if (!s.finite || Number.isNaN(s.jitter) || Number.isNaN(s.totem)) {
      finding('bug', `a ${name} boundary produces nonsense`, JSON.stringify(s));
    }
  });
  // Degenerate areas make every rule sit on its floor — a 3m boundary gives
  // a 1m totem. The lobby has to refuse them.
  const refused = await p.evaluate(([o]) => {
    const at = (dE, dN) => ({
      lat: o.lat + dN / 111320,
      lng: o.lng + dE / (111320 * Math.cos(o.lat * Math.PI / 180)),
    });
    return Promise.all([
      setBoundary([at(0, 0), at(100, 0), at(200, 0)]),
      setBoundary([at(0, 0), at(3, 0), at(3, 3), at(0, 3)]),
      setBoundary([at(0, 0), at(400, 0), at(400, 400), at(0, 400)]),
    ]);
  }, [BASE]);
  if (!refused[0].rejected || !refused[1].rejected) {
    finding('bug', 'a boundary with no room in it can still be saved',
      `flat: ${refused[0].rejected ? 'refused' : 'accepted'}, `
      + `3m: ${refused[1].rejected ? 'refused' : 'accepted'}`);
  } else if (refused[2].rejected) {
    finding('bug', 'a perfectly ordinary 400m boundary was refused',
      JSON.stringify(refused[2]));
  } else {
    ok('flat and desk-sized boundaries are refused, a real one is not',
      `M=0 and M=${Math.round(refused[1].M)} refused, M=${Math.round(refused[2].M)} accepted`);
  }
  ok('a 100km boundary stays finite',
    `M=${shapes.huge.m}m, jitter ${shapes.huge.jitter}m, head start ${shapes.huge.headstartMin} min`);
  await ctx.close();
  return errors;
};

// ---------------------------------------------------------------
// 8. Solo
//
// The living-room game with nobody else in the room. The thing worth
// watching is fairness: a bot is driven by the one client that is open, and
// that client is holding every true position in memory. It must not use
// them.
// ---------------------------------------------------------------
async function soloGameUp(role, bots, sideM) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.dismiss().catch(() => {}));
  await p.addInitScript(() => { try { localStorage.setItem('h_seen_help', '1'); } catch (e) {} });
  // No geolocation permission at all — solo is indoors, like living room.
  await p.goto(`${ORIGIN}/?${STORE}pid=solo${Math.random().toString(36).slice(2, 6)}`);
  await p.fill('#input-name-host', 'You');
  await p.selectOption('#input-mode', 'solo');
  await p.dispatchEvent('#input-mode', 'change');
  await p.selectOption('#input-solo-role', role);
  await p.fill('#input-solo-bots', String(bots));
  if (sideM) {
    await p.fill('#input-area-side', String(sideM));
    await p.dispatchEvent('#input-area-side', 'input');
  }
  await p.click('#btn-host');
  await p.waitForSelector('#view-lobby.active', { timeout: 20000 });
  return { ctx, p, errors };
}

SCENARIOS.solo = async () => {
  const errors = [];
  const { ctx, p, errors: e1 } = await soloGameUp('hider', 4);
  errors.push(...e1);

  const lobby = await p.evaluate(() => ({
    solo: gameState.solo,
    mode: gameState.mode,
    roles: Object.values(playersState).map((x) => x.role).sort().join(','),
    bots: Object.values(playersState).filter((x) => x.isBot).length,
    qr: document.getElementById('qr-holder').closest('.card').style.display,
    canStart: !document.getElementById('btn-start-game').disabled,
  }));
  if (lobby.mode !== 'livingroom' || !lobby.solo) {
    finding('bug', 'solo is not the living-room game underneath',
      `mode ${lobby.mode}, solo ${lobby.solo}`);
  } else if (!lobby.canStart || lobby.bots !== 4) {
    finding('bug', 'a solo game is not ready to start on its own',
      `${lobby.bots} bots, start ${lobby.canStart ? 'enabled' : 'disabled'}`);
  } else {
    ok('solo sets itself up with nothing to wait for',
      `${lobby.bots} opponents, roles ${lobby.roles}, QR hidden`);
  }

  await p.click('#btn-start-game');
  await p.waitForSelector('#view-game.active', { timeout: 20000 });
  await p.waitForTimeout(1500);
  await p.evaluate(() => declareHidden());
  await until(p, () => gameState.status === 'active', null, 30000);

  // Bots must not act before the seekers are released — they are driven from
  // this client, so none of the usual gates apply to them automatically.
  const early = await p.evaluate(() => Object.values(playersState)
    .filter((x) => x.isBot).reduce((a, x) => a + (x.pings || []).length, 0));

  // Let it play.
  let caught = 0;
  for (let r = 0; r < 12; r++) {
    await p.waitForTimeout(2500);
    const s = await p.evaluate(() => ({
      status: gameState.status,
      moved: Object.values(playersState).filter((x) => x.isBot && x.realLat != null).length,
      spent: Object.values(playersState).filter((x) => x.isBot && currentCharge(x) < 99).length,
      dots: Object.values(playersState).reduce((a, x) => a + (x.pings || []).length, 0),
      mine: (me().pings || []).length,
      converted: Object.values(playersState).filter((x) => x.convertedAt).length,
      stale: Object.values(playersState).filter((x) => x.isBot && playerUnavailable(x)).length,
    }));
    caught = s.converted;
    if (s.status === 'ended') break;
  }
  const final = await p.evaluate(() => ({
    moved: Object.values(playersState).filter((x) => x.isBot && x.realLat != null).length,
    spent: Object.values(playersState).filter((x) => x.isBot && currentCharge(x) < 99).length,
    dots: Object.values(playersState).reduce((a, x) => a + (x.pings || []).length, 0),
    stale: Object.values(playersState).filter((x) => x.isBot && playerUnavailable(x)).length,
    tracks: Object.values(playersState).filter((x) => x.isBot && (x.track || []).length > 1).length,
  }));

  if (final.moved < 4) {
    finding('bug', 'some bots never moved', `${final.moved} of 4 have a position`);
  } else if (!final.spent) {
    finding('bug', 'no bot ever spent any charge', 'they are standing about doing nothing');
  } else if (final.stale) {
    finding('bug', 'bots are being treated as phones that went dark',
      `${final.stale} would be greyed out — they need a heartbeat`);
  } else {
    ok('bots walk, spend and stay in contact',
      `${final.moved} moving, ${final.spent} have spent, ${final.dots} dots on the map, `
      + `${final.tracks} with a replay track`);
  }
  if (early > 0) {
    finding('bug', 'bot seekers act during hiding time',
      `${early} dots before the seekers were released — real seekers are held`);
  } else {
    ok('bot seekers are held at the start line like everyone else');
  }
  await ctx.close();

  // And the other way round: the human seeking, with proximity capture.
  const solo2 = await soloGameUp('seeker', 3);
  errors.push(...solo2.errors);
  await solo2.p.click('#btn-start-game');
  await solo2.p.waitForSelector('#view-game.active', { timeout: 20000 });
  await until(solo2.p, () => gameState.status === 'active', null, 40000);

  const capture = await solo2.p.evaluate(() => {
    const btn = document.getElementById('act-capture');
    const before = { label: btn.textContent, disabled: btn.disabled, reach: captureInReach(Date.now()).length };
    // Stand on top of somebody and see whether the game notices.
    const victim = Object.entries(playersState).find(([, x]) => x.role === 'hider' && x.realLat);
    window.__sim = window.__sim || {};
    travelPos = { lat: victim[1].realLat, lng: victim[1].realLng };
    myPos = { ...travelPos };
    refreshHud();
    return {
      before,
      after: { reach: captureInReach(Date.now()).length,
        label: document.getElementById('act-capture').textContent },
      victim: victim[0],
    };
  });
  if (capture.before.reach !== 0 || capture.after.reach === 0) {
    finding('bug', 'proximity capture does not track who is actually in reach',
      `${capture.before.reach} at range, ${capture.after.reach} standing on them`);
  } else {
    ok('the human seeker can only take somebody they have reached',
      `"${capture.before.label}" at range, "${capture.after.label}" up close`);
  }
  const took = await solo2.p.evaluate(async ([id]) => {
    await confirmCapture(id);
    await new Promise((r) => setTimeout(r, 500));
    return playersState[id].role;
  }, [capture.victim]);
  if (took !== 'seeker') {
    finding('bug', 'catching a bot does not convert it', `role is ${took}`);
  } else {
    ok('a caught bot changes sides like anybody else');
  }
  await solo2.ctx.close();
  return errors;
};

// ---------------------------------------------------------------
// 9. Solo at a size and a place of your choosing
//
// Solo is the mode you would test the scaling in, so it has to let you set
// an area and put it somewhere — it used to force a 400m square in London
// with no way to change either.
// ---------------------------------------------------------------
SCENARIOS.soloscale = async () => {
  const errors = [];

  // The landing form previews what a size does to the rules before you
  // commit to anything.
  const { ctx, p, errors: e1 } = await soloGameUp('hider', 2, 1200);
  errors.push(...e1);

  const preview = await p.evaluate(() => {
    const out = {};
    ['150', '600', '1500'].forEach((side) => {
      document.getElementById('input-area-side').value = side;
      updateAreaPreview();
      out[side] = document.getElementById('area-preview').textContent;
    });
    return out;
  });
  const moves = ['150', '600', '1500'].map((k) => /wrong by up to (\d+)m/.exec(preview[k]))
    .map((m) => (m ? Number(m[1]) : null));
  if (moves.some((v) => v == null) || !(moves[0] < moves[1] && moves[1] <= moves[2])) {
    finding('bug', 'the landing form does not preview what a size does to the rules',
      JSON.stringify(moves));
  } else {
    ok('a size can be tried against the rules before hosting anything',
      `150m → ${moves[0]}m error, 600m → ${moves[1]}m, 1500m → ${moves[2]}m`);
  }

  const hosted = await p.evaluate(() => ({
    M: Math.round(gameState.M),
    jitter: pingJitterM(),
    drawable: document.getElementById('boundary-map').closest('.card').style.display,
  }));
  if (Math.abs(hosted.M - 1200) > 5) {
    finding('bug', 'solo ignores the size you asked for',
      `asked for 1200m, got M=${hosted.M}`);
  } else if (hosted.drawable !== 'block') {
    finding('bug', 'solo gives you no way to move or redraw the play area',
      'the boundary card is hidden');
  } else {
    ok('solo honours the size you set and lets you redraw it',
      `M=${hosted.M}, readings wrong by ${hosted.jitter}m, boundary map shown`);
  }

  // Put the area somewhere else entirely and check the game goes with it.
  const moved = await p.evaluate(async () => {
    const away = { lat: 55.9533, lng: -3.1883 };   // nowhere near the default
    const pts = squareBoundaryAround(away, 900);
    boundaryPoints = pts.slice();
    const r = await setBoundary(pts);
    updateBoundaryInfo();
    return { M: Math.round(r.M), rejected: !!r.rejected, away };
  });
  await p.click('#btn-start-game');
  await p.waitForSelector('#view-game.active', { timeout: 20000 });
  await p.waitForTimeout(2500);
  const placed = await p.evaluate(([away]) => {
    const bots = Object.values(playersState).filter((x) => x.isBot && x.realLat != null);
    return {
      M: Math.round(M),
      jitter: pingJitterM(),
      meAway: myPos ? Math.round(distanceM(myPos, away)) : null,
      bots: bots.length,
      allThere: bots.every((x) => distanceM({ lat: x.realLat, lng: x.realLng }, away) < 1200),
    };
  }, [moved.away]);

  if (moved.rejected || Math.abs(placed.M - 901) > 10) {
    finding('bug', 'redrawing the solo play area does not take',
      `M=${placed.M}, rejected ${moved.rejected}`);
  } else if (!placed.bots || !placed.allThere || placed.meAway == null || placed.meAway > 1200) {
    finding('bug', 'the game does not start where the area was drawn',
      `you ${placed.meAway}m away, ${placed.bots} bots, all inside: ${placed.allThere}`);
  } else {
    ok('the game starts wherever you put the area',
      `M=${placed.M}, readings wrong by ${placed.jitter}m, `
      + `you and all ${placed.bots} opponents inside it`);
  }
  await ctx.close();
  return errors;
};

// ---------------------------------------------------------------

const names = only ? [only] : Object.keys(SCENARIOS);
const allErrors = [];
for (const name of names) {
  console.log(`\n--- ${name} ---`);
  try {
    const errs = await SCENARIOS[name]();
    (errs || []).forEach((e) => allErrors.push(`${name}: ${e}`));
  } catch (e) {
    finding('bug', `the ${name} scenario threw`, e.message);
  }
}

console.log('\n' + '='.repeat(64));
const real = allErrors.filter((e) => !/tile\.openstreetmap|Failed to load resource|ERR_/i.test(e));
const bugs = findings.filter((f) => f.severity === 'bug');
console.log(`${notes.length} checks came back clean`);
console.log(`${bugs.length} bug(s), ${findings.length - bugs.length} note(s)`);
if (real.length) console.log('JS errors:\n  ' + [...new Set(real)].join('\n  '));
await browser.close();
if (!BASE_URL) server.close();
process.exit(0);
