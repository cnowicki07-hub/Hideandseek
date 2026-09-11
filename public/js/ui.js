// UI rendering and all user interaction.
//
// Visibility rules live here and are deliberately sparse: hiders see nothing
// but themselves and the shared world (boundary, totems, signposts). Every
// dot of another player was paid for by someone spending charge.
// Powers are what punch temporary holes in that — see `reveals` in powers.js.

// Map palette, kept in step with css/style.css. Anything that threatens you
// is blood; the world is bruised and sickly; you are the one cold blue dot.
const MAP = {
  blood:      '#e01b26',
  bloodDim:   '#8c0a12',
  boundary:   '#7a1018',
  bruise:     '#7a2f52',
  rot:        '#6f9150',
  rotLit:     '#8fbf6a',
  totem:      '#5f7f4a',
  totemLit:   '#7ea35e',
  ash:        '#5a5454',
  ashLit:     '#8a8280',
  gloom:      '#3a2f35',
  ember:      '#c9741f',
  bone:       '#ddd6ce',
  amber:      '#d9a441',
  amberLit:   '#f0c96a',
  cold:       '#5fa8d3',
  coldDim:    '#2f6f92',
  wood:       '#6b5638',
  woodLit:    '#9a825a',
  violet:     '#8e5fa8',
  own:        '#4ade80',   // your own trail — green, so you can tell it apart
  outline:    '#16060a',   // dark ring under a dot in daylight mode
};

let currentPlayerName = '';
let worldLayer = null;
let selfMarker = null;
let mapReady = false;

// ---------- view plumbing ----------

function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function el(id) { return document.getElementById(id); }

function toast(msg) {
  const host = el('toast-host');
  if (!host) { console.log('[toast]', msg); return; }
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = msg;
  host.appendChild(node);
  setTimeout(() => node.classList.add('fade'), 3500);
  setTimeout(() => node.remove(), 4200);
}

// Asked for from inside the tap that starts a game — see requestLocation().
async function ensureLocation() {
  const r = await requestLocation();
  renderLocationStatus();
  if (!r.ok) {
    alert(r.reason + '\n\nThis game is played entirely on GPS, so it cannot start without it.');
    return false;
  }
  return true;
}

function renderLocationStatus() {
  const status = el('location-status');
  const retry = el('btn-retry-location');
  if (!status) return;
  if (usingTravelMode()) {
    el('location-card').style.display = 'none';
    return;
  }
  el('location-card').style.display = 'block';
  if (locationState === 'ok') {
    status.textContent = myPos
      ? 'Location on. You are being tracked.'
      : 'Location on, waiting for a fix.';
    status.className = 'muted';
    retry.style.display = 'none';
  } else if (locationState === 'unknown') {
    status.textContent = 'Checking…';
    status.className = 'muted';
    retry.style.display = 'none';
  } else {
    status.textContent = locationState === 'denied'
      ? 'Location is blocked. Allow it for this site in your browser settings, then tap Retry.'
      : 'No location fix yet. Step outside with a clear view of the sky and tap Retry.';
    status.className = 'warn';
    retry.style.display = 'block';
  }
}

el('input-mode').onchange = () => {
  const indoors = el('input-mode').value === 'livingroom';
  el('mode-note').textContent = indoors
    ? 'Played sitting together. Tap the map to send your token somewhere and it walks there — ' +
      'GPS cannot work indoors, so travel happens on screen. One round is about 10 minutes.'
    : 'Played on foot across a real area you draw on the map.';
  el('input-area-side').parentElement.style.opacity = indoors ? 0.4 : 1;
  el('input-length').parentElement.style.opacity = indoors ? 0.4 : 1;
};

el('btn-retry-location').onclick = async () => {
  await requestLocation();
  renderLocationStatus();
};

let boundaryWarningM = null;
function setBoundaryWarning(dist) { boundaryWarningM = dist; }

// ---------- map ----------

function initMap() {
  if (mapReady) return;
  map = L.map('map', { zoomControl: false });
  map.setView([51.5, -0.1], 15); // recentres on first real GPS fix
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  worldLayer = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
  mapReady = true;
}

let recentered = false;
function recenterOnSelf(lat, lng) {
  if (!recentered) { map.setView([lat, lng], 17); recentered = true; }
}

// The map follows you once, on the first fix, and then leaves you alone so
// you can pan around. This is how you get back.
// ---------- daylight ----------
//
// The horror theme is right at dusk and wrong at noon: outdoor testing put
// people in a bright field squinting at tiles the CSS deliberately darkens.
// Daylight mode is a legibility mode, not a second theme — same palette,
// same identity, but the grain and vignette come off, the map is left at its
// real colours, and every dot gets a dark outline so a white one does not
// vanish into a pale tile.
//
// Per player, not per game: the sun is where the player is standing, and the
// host being indoors says nothing about the rest of them. Kept in
// localStorage so it survives the rematch reload.
let daylightMode = false;
function daylight() { return daylightMode; }

function setDaylight(on) {
  daylightMode = !!on;
  document.body.classList.toggle('daylight', daylightMode);
  const btn = el('btn-daylight');
  if (btn) {
    btn.textContent = daylightMode ? '☾' : '☀';
    btn.title = daylightMode ? 'Back to the dark screen' : 'Brighten the screen for daylight';
  }
  const landing = el('btn-daylight-landing');
  if (landing) landing.textContent = daylightMode ? 'Dark mode' : 'Daylight mode';
  try { localStorage.setItem('h_daylight', daylightMode ? '1' : '0'); } catch (e) { /* private mode */ }
  if (mapReady) renderWorld();
}

try { setDaylight(localStorage.getItem('h_daylight') === '1'); }
catch (e) { setDaylight(false); }

el('btn-daylight').onclick = () => setDaylight(!daylightMode);
// Also settable before the game starts — the lobby is where people are
// already standing in the sun, squinting at a QR code.
el('btn-daylight-landing').onclick = () => setDaylight(!daylightMode);

el('btn-locate').onclick = () => {
  if (!mapReady) return;
  if (!myPos) { toast('No GPS fix yet.'); return; }
  map.setView([myPos.lat, myPos.lng], Math.max(map.getZoom(), 17));
};

// ---------- landing ----------

el('btn-host').onclick = async () => {
  currentPlayerName = el('input-name-host').value.trim() || 'Host';
  const mode = el('input-mode').value;

  // Indoors there is no GPS to ask for, and no real ground to draw over, so
  // the play area is generated and the game is ready immediately.
  if (mode === 'outdoor' && !(await ensureLocation())) return;

  const sideM = parseFloat(el('input-area-side').value) || 400;
  const lengthMin = parseFloat(el('input-length').value) || 90;
  const opts = {
    mode,
    areaM2: sideM * sideM,
    gameLengthMin: lengthMin,
    endConditionMode: el('input-end-mode').value,
  };
  if (mode === 'livingroom') {
    const centre = myPos || { lat: 51.5074, lng: -0.1278 };
    opts.boundary = squareBoundaryAround(centre, LIVING_ROOM.defaultAreaSideM);
    opts.gameLengthMin = LIVING_ROOM.gameLengthMin;
  }
  try {
    await hostCreateGame(opts);
  } catch (e) { storeConnectionFailed(e); return; }
  el('lobby-code').textContent = gameCode;
  showView('view-lobby');
};

el('btn-join').onclick = async () => {
  // A blank name used to silently become "Player", which is how a scanned
  // join produced a nameless player in a real game. Names are how capture
  // works, so an unnamed player is not a player.
  currentPlayerName = el('input-name-join').value.trim();
  if (!currentPlayerName) {
    alert('Put your name in first — the seekers have to be able to say it.');
    el('input-name-join').focus();
    return;
  }
  const code = el('input-code').value.trim();
  if (!code) { alert('Enter a game code.'); return; }
  let ok;
  try { ok = await joinGame(code, currentPlayerName, false); }
  catch (e) { storeConnectionFailed(e); return; }
  if (ok) {
    el('lobby-code').textContent = gameCode;
    showView('view-lobby');
    // Only outdoor games need GPS; ask once the mode is known.
    if (!usingTravelMode()) await ensureLocation();
  }
};

// ---------- lobby: boundary drawing ----------

let boundaryMap = null;
let boundaryPoints = [];
let boundaryShape = null;

function initBoundaryMap() {
  if (boundaryMap) return;
  boundaryMap = L.map('boundary-map', { zoomControl: true });
  boundaryMap.setView([51.5, -0.1], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }).addTo(boundaryMap);
  boundaryMap.on('click', (e) => {
    boundaryPoints.push({ lat: e.latlng.lat, lng: e.latlng.lng });
    drawBoundaryDraft();
  });
  // Centre on the host's own position so they are drawing over real ground.
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => boundaryMap.setView([pos.coords.latitude, pos.coords.longitude], 16),
      () => {}, { enableHighAccuracy: true, timeout: 8000 });
  }
  setTimeout(() => boundaryMap.invalidateSize(), 200);
}

function drawBoundaryDraft() {
  if (boundaryShape) boundaryMap.removeLayer(boundaryShape);
  if (!boundaryPoints.length) { boundaryShape = null; updateBoundaryInfo(); return; }
  const latlngs = boundaryPoints.map((p) => [p.lat, p.lng]);
  boundaryShape = boundaryPoints.length >= 3
    ? L.polygon(latlngs, { color: MAP.boundary, weight: 2 })
    : L.polyline(latlngs, { color: MAP.boundary, weight: 2 });
  boundaryShape.addTo(boundaryMap);
  updateBoundaryInfo();
}

function updateBoundaryInfo() {
  const info = el('boundary-info');
  if (boundaryPoints.length < 3) {
    info.textContent = `${boundaryPoints.length} corner(s) — need at least 3.`;
    return;
  }
  const area = polygonAreaM2(boundaryPoints);
  const mVal = computeM(area);
  info.textContent = `${(area / 10000).toFixed(1)} ha · M = ${Math.round(mVal)}m · ` +
    `totem radius ${Math.round(totemRadiusM(mVal))}m · ` +
    `sabotage ${(totemSabotageSeconds(totemRadiusM(mVal)) / 60).toFixed(1)} min`;
}

el('btn-boundary-locate').onclick = () => {
  if (!navigator.geolocation) { toast('No GPS on this device.'); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => boundaryMap.setView([pos.coords.latitude, pos.coords.longitude], 17),
    () => toast('Could not get your location — check location permission.'),
    { enableHighAccuracy: true, timeout: 10000 });
};

el('btn-boundary-undo').onclick = () => { boundaryPoints.pop(); drawBoundaryDraft(); };
el('btn-boundary-clear').onclick = () => { boundaryPoints = []; drawBoundaryDraft(); };
el('btn-boundary-save').onclick = async () => {
  if (boundaryPoints.length < 3) { alert('Drop at least 3 corners first.'); return; }
  const r = await setBoundary(boundaryPoints);
  toast(`Boundary set — ${(r.areaM2 / 10000).toFixed(1)} ha.`);
  updateHeadstartInfo();
};

function updateHeadstartInfo() {
  const g = gameState;
  if (!g) return;
  const field = el('input-headstart');
  // Don't fight the host while they are typing in it.
  if (field && document.activeElement !== field) {
    field.value = ((g.headstartMs || 0) / 60000).toFixed(1).replace(/\.0$/, '');
  }
  const mins = ((g.headstartMs || 0) / 60000).toFixed(1).replace(/\.0$/, '');
  el('headstart-info').textContent = g.headstartMs
    ? `Hiders get a ${mins} min head start before seekers are released.`
    : 'No head start — seekers are released immediately.';
}

el('input-headstart').onchange = async () => {
  const mins = parseFloat(el('input-headstart').value);
  if (isNaN(mins) || mins < 0) return;
  await gameRef().update({ headstartMs: Math.round(mins * 60000) });
  toast(mins ? `Head start set to ${mins} min.` : 'Head start removed.');
};

// ---------- lobby: host start ----------

el('btn-assign-roles').onclick = async () => {
  const numSeekers = parseInt(el('input-num-seekers').value, 10) || 1;
  await assignRolesRandom(numSeekers);
  toast('Roles assigned.');
};

el('btn-start-game').onclick = async () => {
  await startGame();
};

// A scannable join link beats five people typing a five-letter code in a
// dark field.
let qrRenderedFor = null;
function renderJoinQr() {
  if (!gameCode || qrRenderedFor === gameCode) return;
  const holder = el('qr-holder');
  if (!holder || typeof qrcodegen === 'undefined') return;

  const url = `${location.origin}/?join=${gameCode}`;
  try {
    const qr = qrcodegen(0, 'M');
    qr.addData(url);
    qr.make();
    holder.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 8, scalable: true });
    el('join-link').textContent = url;
    qrRenderedFor = gameCode;
  } catch (e) {
    console.warn('qr failed', e);
    holder.innerHTML = '';
    el('join-link').textContent = url;
  }
}

// The lobby list doubles as the host's role controls: for the host every row
// is a button that cycles that player unassigned -> seeker -> hider, so roles
// can be set deliberately as well as rolled.
const ROLE_CYCLE = [null, 'seeker', 'hider'];

function renderLobbyList(players) {
  const list = el('lobby-players');
  const iAmHost = !!(players[playerId] && players[playerId].isHost);
  list.innerHTML = '';
  Object.entries(players).forEach(([id, p]) => {
    if (p.status === 'kicked') return;
    const li = document.createElement('li');
    const label = `${p.name}${p.isHost ? ' (host)' : ''}`;
    const role = p.role ? p.role : 'no role';

    if (!iAmHost) {
      li.textContent = `${label} — ${role}`;
      list.appendChild(li);
      return;
    }

    li.className = 'row-pick';
    const btn = document.createElement('button');
    btn.className = 'role-pick secondary role-' + (p.role || 'none');
    btn.innerHTML = `<span>${label}</span><span class="role-tag">${role}</span>`;
    btn.title = 'Tap to change this player\'s role';
    btn.setAttribute('aria-label', `${p.name} — ${role}. Tap to change their role.`);
    btn.onclick = async () => {
      const next = ROLE_CYCLE[(ROLE_CYCLE.indexOf(p.role || null) + 1) % ROLE_CYCLE.length];
      btn.disabled = true;
      try { await setPlayerRole(id, next); } finally { btn.disabled = false; }
    };
    li.appendChild(btn);

    // The host cannot kick themselves — there would be nobody left holding
    // the controls.
    if (id !== playerId) {
      const kick = document.createElement('button');
      kick.className = 'kick-btn secondary';
      kick.textContent = '✕';
      kick.title = `Remove ${p.name} from the game`;
      kick.setAttribute('aria-label', `Remove ${p.name} from the game`);
      kick.onclick = async () => {
        if (!confirm(`Remove ${p.name} from the game?`)) return;
        kick.disabled = true;
        try { await kickPlayer(id); toast(`${p.name} removed.`); }
        finally { kick.disabled = false; }
      };
      li.appendChild(kick);
    }
    list.appendChild(li);
  });
}

// The lobby runs in order: everyone joins, the host assigns roles, and only
// then the game starts. Everyone gets their role's full set of powers —
// there is nothing to choose.
function renderLobby(players) {
  const p = players[playerId];
  if (!p) return;
  renderLobbyList(players);
  renderJoinQr();
  renderLocationStatus();
  maybeShowFirstRunHelp();

  // Driven by the player document rather than set once at host time, so a
  // rematch host still gets their controls after the page reloads.
  el('host-controls').style.display = p.isHost ? 'block' : 'none';
  // The boundary is generated indoors, so there is nothing to draw.
  const boundaryCard = el('boundary-map').closest('.card');
  if (boundaryCard) boundaryCard.style.display = usingTravelMode() ? 'none' : 'block';
  if (p.isHost && !usingTravelMode()) initBoundaryMap();

  const title = el('role-title');
  const note = el('role-note');

  if (!p.role) {
    title.textContent = 'Waiting for roles';
    note.innerHTML = 'The host assigns roles once everyone has joined.'
      + '<br><br>Never played? Tap <strong>How to play</strong> above.';
  } else if (p.role === 'seeker') {
    title.textContent = "You're a SEEKER";
    note.innerHTML =
      '<strong>Your job:</strong> find every hider before the clock runs out.<br><br>'
      + 'Hiders are invisible. Nothing appears on your map unless you pay for it — '
      + '<strong>Scan</strong> tells you roughly which directions they are in, '
      + '<strong>Probe</strong> sweeps half the map and pins whoever is in it. '
      + 'What you get back is only good to about 30m, so someone standing still '
      + 'can look like they are moving.<br><br>'
      + 'To catch someone you have to physically reach them and get them to read '
      + 'out their 4-letter code. There is no tag button.<br><br>'
      + 'You are always carrying <strong>I SEE YOU</strong>: get within 20m of a '
      + 'hider and their whole screen tells them they may no longer run. It '
      + 'costs nothing and tells you nothing — it just means the last 20m is '
      + 'a walk, for both of you.';
  } else {
    title.textContent = "You're a HIDER";
    note.innerHTML =
      '<strong>Your job:</strong> stay unfound. You are scored on survival time.<br><br>'
      + 'You are invisible by default — your phone never gives you away on its own. '
      + 'You only appear when a seeker spends a power to find you, and even then '
      + 'the dot they get is up to 30m out.<br><br>'
      + '<strong>Go quiet</strong> eats the next ping aimed at you. '
      + '<strong>Decoy</strong> sends that ping somewhere you are not. '
      + '<strong>Seeker scan</strong> is your only way of ever seeing them.<br><br>'
      + 'One rule you enforce yourself: if <strong>I SEE YOU</strong> fills your '
      + "screen, a seeker is within 20m and you can no longer run. Walk until "
      + "it clears. You can hide, but you can't run.";
  }

  if (p.isHost) renderHostLobbyStatus(players);
}

function renderHostLobbyStatus(players) {
  // Removed players are gone from the lobby's arithmetic entirely — otherwise
  // a kicked stranger with no role would hold the Start button down forever.
  const all = Object.values(players).filter((x) => x.status !== 'kicked');
  const assigned = all.filter((x) => x.role).length;
  const seekers = all.filter((x) => x.role === 'seeker').length;
  const hiders = all.filter((x) => x.role === 'hider').length;
  const unassigned = all.filter((x) => !x.role);

  el('roles-status').textContent = assigned
    ? `${seekers} seeker(s), ${hiders} hider(s).`
    : `${all.length} player(s) here. Nobody has a role yet.`;

  // Hand-assignment makes a one-sided game possible in a way the random
  // deal never did, so both sides have to actually exist before starting.
  const lopsided = !seekers || !hiders;
  el('btn-start-game').disabled = !assigned || unassigned.length > 0 || lopsided;
  el('ready-status').textContent = !assigned
    ? 'Assign roles before starting — tap a player, or roll them.'
    : unassigned.length
      ? `No role yet: ${unassigned.map((x) => x.name).join(', ')}.`
      : !seekers
        ? 'Nobody is seeking. Tap a player to make them a seeker.'
        : !hiders
          ? 'Nobody is hiding. Tap a player to make them a hider.'
          : 'Everyone is ready. Starting begins hiding time.';
}

// ---------- game status ----------

function renderGameStatus(g) {
  if (g.status === 'lobby') {
    updateHeadstartInfo();
    if (boundaryMap && g.boundary && !boundaryPoints.length) {
      boundaryPoints = g.boundary.slice();
      drawBoundaryDraft();
    }
  }
  if (g.status === 'active' || g.status === 'hiding') {
    if (!el('view-game').classList.contains('active')) {
      showView('view-game');
      initMap();
      setTimeout(() => map.invalidateSize(), 200);
      buildActionButtons();
    }
    updateTimer(g);
  }
  if (g.status === 'ended') {
    showView('view-end');
    renderScoreboard();
    renderEndActions();
  }
}

let timerInterval = null;
function updateTimer(g) {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    if (!gameState) return;
    const remainingMs = Math.max(0, gameLengthMs - elapsedGameMs());
    const mins = Math.floor(remainingMs / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    el('timer').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  }, 1000);
}

// ---------- players ----------

function renderPlayers(players) {
  const p = players[playerId];
  if (!p) return;
  if (p.role && p.role !== playerRole) {
    const wasHider = playerRole === 'hider';
    playerRole = p.role;
    if (wasHider && p.role === 'seeker') toast('You have been captured — you are a seeker now.');
    buildPowerButtons();
    buildActionButtons();
  }

  if (!gameState || gameState.status === 'lobby') renderLobby(players);
  refreshHud();

  if (!el('view-game').classList.contains('active') || !mapReady) return;
  if (p.realLat) recenterOnSelf(p.realLat, p.realLng);
  renderWorld();
}

function refreshHud() {
  const p = me();
  if (!p) return;
  const now = Date.now();
  el('charge-value').textContent = Math.floor(currentCharge(p));
  el('my-code').textContent = p.captureCode || '----';
  el('hud-role').textContent = p.status === 'active' ? (p.role || '—') : p.status.replace('_', ' ');
  renderHidingBar(p, now);
  renderBanners(p, now);
  renderISeeYou(p, now);
  refreshPowerButtons(p, now);
  refreshActionButtons(p, now);
}

// ---------- banners ----------

// During hiding, the only thing that matters is whether you're hidden yet.
function renderHidingBar(p, now) {
  const bar = el('hiding-bar');
  if (!isHiding()) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';

  const left = Math.max(0, Math.ceil(((gameState.hidingEndsAt || 0) - now) / 1000));
  const mins = Math.floor(left / 60);
  const secs = left % 60;
  const clock = `${mins}:${String(secs).padStart(2, '0')}`;
  const remaining = hidersStillHiding();
  const btn = el('btn-declare-hidden');

  if (p.role === 'hider') {
    if (p.declaredHiddenAt) {
      el('hiding-text').innerHTML =
        `<strong>You're hidden.</strong> Seekers released in ${clock}` +
        (remaining.length ? `, or sooner — waiting on ${remaining.length} other(s).` : '.');
      btn.disabled = true;
      btn.textContent = 'Hidden ✓';
    } else {
      el('hiding-text').innerHTML =
        `<strong>GO HIDE.</strong> Seekers released in ${clock}. ` +
        `Tap when you're in place — if everyone does, they come early.`;
      btn.disabled = false;
      btn.textContent = "I'm hidden";
    }
  } else {
    el('hiding-text').innerHTML = remaining.length
      ? `<strong>Held at the start line.</strong> ${clock} left, or until all hiders are set. ` +
        `${remaining.length} still moving.`
      : `<strong>Everyone is hidden.</strong> Releasing you now…`;
    btn.style.display = 'none';
  }
}

// Nothing here changes the game. The overlay is inert and lets every tap
// through; what it changes is what the player is allowed to do with their
// legs, and only they can enforce that.
let iSeeYouShowing = false;
function renderISeeYou(p, now) {
  const on = iSeeYouActive(p, now);
  if (on === iSeeYouShowing) return;
  iSeeYouShowing = on;
  el('i-see-you').classList.toggle('on', on);
  if (on) toast('A seeker is on top of you. WALK.');
}

function renderBanners(p, now) {
  const strip = el('banner-strip');
  const items = [];

  if (isPaused()) items.push(['warn', 'Game paused by the host.']);
  if (inGrace(p)) items.push(['info', `Powers unlock in ${Math.ceil((p.graceUntil - now) / 1000)}s.`]);
  if (p.lockedOutUntil && now < p.lockedOutUntil) {
    items.push(['warn', `Locked out for ${Math.ceil((p.lockedOutUntil - now) / 1000)}s.`]);
  }
  if (p.breachStartedAt) {
    const left = Math.ceil((CONFIG.boundary.breachTimerMs - (now - p.breachStartedAt)) / 1000);
    items.push(['danger', `OUT OF BOUNDS — eliminated in ${left}s.`]);
  } else if (boundaryWarningM != null) {
    items.push(['warn', `Approaching the boundary (${Math.round(boundaryWarningM)}m).`]);
  }

  // Being hunted is a countdown now, not a direction. You know exactly when
  // your position goes out, which is what makes spending Go quiet or a Decoy
  // a decision rather than a guess.
  const marks = activeMarksOn(p, now);
  marks.forEach((m) => {
    const hunter = playersState[m.seekerId];
    const secs = Math.max(0, Math.ceil((huntNextPingAt(m) - now) / 1000));
    items.push(['danger',
      `HUNTED by ${hunter ? hunter.name : 'a seeker'} — your position goes out in ${secs}s.`]);
  });
  const totemBanner = totemStatusBanner(p, now);
  if (totemBanner) items.push(totemBanner);

  if (p.activeHunt && now < p.activeHunt.expiresAt) {
    const t = playersState[p.activeHunt.targetId];
    const mark = t && (t.huntedBy || {})[playerId];
    const due = mark ? Math.max(0, Math.ceil((huntNextPingAt(mark) - now) / 1000)) : null;
    const left = Math.ceil((p.activeHunt.expiresAt - now) / 60000);
    items.push(['info', `Hunting ${t ? t.name : '?'} — next reading`
      + (due == null ? ' shortly' : ` in ${due}s`) + `, ${left} min left.`]);
  }

  strip.innerHTML = '';
  items.forEach(([kind, text]) => {
    const d = document.createElement('div');
    d.className = 'banner ' + kind;
    d.textContent = text;
    strip.appendChild(d);
  });
}

// ---------- power buttons ----------

function buildPowerButtons() {
  const host = el('power-buttons');
  host.innerHTML = '';
  const p = me();
  if (!p || !p.role) return;
  Object.entries(POWERS).forEach(([key, def]) => {
    if (def.role !== p.role) return;
    const b = document.createElement('button');
    b.className = 'power';
    b.dataset.power = key;
    b.innerHTML = `<span class="pname">${def.label}</span><span class="pcost">${def.cost()}</span>`;
    b.title = def.desc;
    b.onclick = () => requestPower(key);
    host.appendChild(b);
  });
}

function refreshPowerButtons(p, now) {
  const host = el('power-buttons');
  if (!host.children.length && p.role) buildPowerButtons();
  Array.from(host.children).forEach((b) => {
    const reason = powerBlockedReason(b.dataset.power, p, now);
    b.disabled = !!reason;
    b.classList.toggle('blocked', !!reason);
    b.title = reason || POWERS[b.dataset.power].desc;
  });
}

// ---------- action buttons ----------

function buildActionButtons() {
  const host = el('action-buttons');
  host.innerHTML = '';
  const p = me();
  if (!p) return;

  const add = (id, label, handler, cls) => {
    const b = document.createElement('button');
    b.id = id; b.textContent = label; b.onclick = handler;
    if (cls) b.className = cls;
    host.appendChild(b);
    return b;
  };

  if (p.role === 'seeker') {
    add('act-capture', 'Capture', openCaptureModal, 'primary');
    add('act-hunt', 'Hunt', openHuntPicker);
  }
  if (p.role === 'hider') {
    add('act-snitch', 'Snitch', beginSnitch);
  }
  add('act-sign', 'Signs', openSignpostModal);
  add('act-menu', 'Menu', openMenu);
}

function refreshActionButtons(p, now) {
  const capture = el('act-capture');
  if (capture) capture.disabled = isHiding();

  const hunt = el('act-hunt');
  if (hunt) {
    const ok = huntAvailable(now) && !(p.activeHunt && now < p.activeHunt.expiresAt) && !inGrace(p);
    hunt.disabled = !ok;
    const at = huntAvailableAt(now);
    hunt.textContent = ok ? 'Hunt'
      : (p.activeHunt && now < p.activeHunt.expiresAt) ? 'Hunting'
      : `Hunt ${at ? Math.max(0, Math.ceil((at - now) / 60000)) + 'm' : ''}`;
  }
  const snitch = el('act-snitch');
  if (snitch) {
    const reason = snitchAvailableReason(p, now);
    snitch.disabled = !!reason;
    snitch.title = reason || 'Sell out another hider.';
  }
  const sign = el('act-sign');
  if (sign) {
    const n = signpostsInRange(myPos, now).length;
    sign.textContent = n ? `Signs (${n})` : 'Signs';
  }
}

// ---------- targeting ----------

let mapTargetCb = null;

function beginMapTargeting(prompt, cb) {
  mapTargetCb = cb;
  const p = el('targeting-prompt');
  p.textContent = prompt + ' (tap here to cancel)';
  p.classList.add('active');
  p.onclick = cancelMapTargeting;
}

function cancelMapTargeting() {
  mapTargetCb = null;
  const p = el('targeting-prompt');
  p.classList.remove('active');
}

function onMapClick(e) {
  const point = { lat: e.latlng.lat, lng: e.latlng.lng };
  if (mapTargetCb) {
    const cb = mapTargetCb;
    cancelMapTargeting();
    cb(point);
    return;
  }
  // Living-room mode: tapping open map sends your token walking.
  if (usingTravelMode() && isPlaying() && me() && me().status === 'active') {
    setTravelDestination(point);
    renderWorld();
  }
}

function beginPlayerTargeting(title, options, cb) {
  el('target-title').textContent = title;
  const list = el('target-list');
  list.innerHTML = '';
  options.forEach((o) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = o.label;
    b.onclick = () => { el('target-modal').style.display = 'none'; cb(o.id); };
    li.appendChild(b);
    list.appendChild(li);
  });
  el('target-modal').style.display = 'flex';
}

el('btn-cancel-target').onclick = () => { el('target-modal').style.display = 'none'; };

function openHuntPicker() {
  const options = Object.entries(playersState)
    .filter(([, p]) => p.role === 'hider' && p.status === 'active')
    .map(([id, p]) => ({ id, label: p.name }));
  if (!options.length) { toast('No active hiders.'); return; }
  beginPlayerTargeting('Choose your quarry', options, activateHunt);
}

// ---------- capture ----------

let pendingCapture = null;

function openCaptureModal() {
  pendingCapture = null;
  el('input-capture-code').value = '';
  el('capture-confirm').style.display = 'none';
  el('btn-confirm-capture').textContent = 'Check code';
  el('capture-modal').style.display = 'flex';
}

el('btn-cancel-capture').onclick = () => { el('capture-modal').style.display = 'none'; };

el('btn-confirm-capture').onclick = async () => {
  if (!pendingCapture) {
    const code = el('input-capture-code').value.trim();
    if (code.length !== 4) { toast('Codes are 4 letters.'); return; }
    const target = await lookupCaptureTarget(code);
    if (!target) { toast('No active hider with that code.'); return; }
    pendingCapture = target;
    el('capture-name').textContent = target.name;
    el('capture-confirm').style.display = 'block';
    el('btn-confirm-capture').textContent = 'Confirm capture';
    return;
  }
  const result = await confirmCapture(pendingCapture.id);
  el('capture-modal').style.display = 'none';
  pendingCapture = null;
  if (result.ok) toast(`Captured ${result.name} — they are a seeker now.`);
};

// ---------- snitch ----------

function showSnitchSurvey(entries) {
  const list = el('snitch-list');
  list.innerHTML = '';
  if (!entries.length) {
    list.innerHTML = '<li class="muted">Nobody within range.</li>';
  }
  entries.forEach((e) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    const fidelity = e.radiusM === 0 ? 'exact' : `within ${e.radiusM}m`;
    b.textContent = `${e.name} — ${fidelity}`;
    b.onclick = () => snitchOn(e.id);
    li.appendChild(b);
    list.appendChild(li);
  });
  el('snitch-modal').style.display = 'flex';
  setTimeout(hideSnitchSurvey, CONFIG.snitch.displayMs);
}

function hideSnitchSurvey() {
  el('snitch-modal').style.display = 'none';
  reveals.snitch = null;
  renderWorld();
}

el('btn-cancel-snitch').onclick = hideSnitchSurvey;

// ---------- signposts ----------

function openSignpostModal() {
  const list = el('signpost-list');
  list.innerHTML = '';
  const here = signpostsInRange(myPos, Date.now());
  if (!here.length) list.innerHTML = '<li class="muted">No signs within reading distance.</li>';
  here.forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s.text;
    list.appendChild(li);
  });
  el('input-signpost').value = '';
  el('signpost-modal').style.display = 'flex';
}

el('btn-cancel-signpost').onclick = () => { el('signpost-modal').style.display = 'none'; };
el('btn-place-signpost').onclick = async () => {
  await placeSignpost(el('input-signpost').value);
  el('signpost-modal').style.display = 'none';
};

// ---------- panic / quit / menu ----------
// Panic is long-press, Quit is buried in a menu behind a confirm. They must
// never be confusable under stress (design doc Section 12).

let panicTimer = null;
const panicBtn = el('btn-panic');

function beginPanicHold(e) {
  e.preventDefault();
  panicBtn.classList.add('holding');
  panicTimer = setTimeout(() => {
    panicBtn.classList.remove('holding');
    el('input-panic-msg').value = '';
    el('panic-modal').style.display = 'flex';
  }, 1200);
}

function cancelPanicHold() {
  clearTimeout(panicTimer);
  panicBtn.classList.remove('holding');
}

panicBtn.addEventListener('touchstart', beginPanicHold, { passive: false });
panicBtn.addEventListener('mousedown', beginPanicHold);
['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach((ev) =>
  panicBtn.addEventListener(ev, cancelPanicHold));

el('btn-cancel-panic').onclick = () => { el('panic-modal').style.display = 'none'; };
el('btn-confirm-panic').onclick = async () => {
  el('panic-modal').style.display = 'none';
  await sendPanic(el('input-panic-msg').value);
  toast('Panic alert sent to everyone.');
};

function openMenu() {
  const host = el('host-live-controls');
  host.innerHTML = '';
  const p = me();
  if (p && p.isHost) {
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label; b.className = 'secondary';
      b.onclick = async () => { await fn(); el('menu-modal').style.display = 'none'; };
      host.appendChild(b);
    };
    if (isPaused()) mk('Resume game', resumeGame); else mk('Pause game', pauseGame);
    mk('End game now', async () => { if (confirm('End the game for everyone?')) await endGameNow(); });

    // A stranger is not always spotted in the lobby, so the kick has to
    // survive into the game itself.
    Object.entries(playersState)
      .filter(([id, x]) => id !== playerId && x.status === 'active')
      .forEach(([id, x]) => {
        mk(`Remove ${x.name}`, async () => {
          if (!confirm(`Remove ${x.name} from the game?`)) return;
          await kickPlayer(id);
          toast(`${x.name} removed.`);
        });
      });
    const flagged = Object.values(playersState)
      .filter((x) => x.status === 'active' && offlineFlagged(x));
    if (flagged.length) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = 'No contact: ' + flagged.map((x) => x.name).join(', ');
      host.appendChild(note);
    }
  }
  el('menu-modal').style.display = 'flex';
}

el('btn-cancel-menu').onclick = () => { el('menu-modal').style.display = 'none'; };
el('btn-quit').onclick = async () => {
  if (!confirm('Quit? This locks your survival time and takes you off the map.')) return;
  await quitGame();
  el('menu-modal').style.display = 'none';
  toast('You have withdrawn.');
};

// ---------- events ----------

function onGameEvent(e) {
  switch (e.type) {
    case 'tripwire': toast('Tripwire triggered — exact position on your map.'); break;
    case 'lockout': toast('A seeker has locked out your powers.'); break;
    case 'pinged': toast('You have just been pinged.'); break;
    case 'go_quiet_used': toast('Go quiet absorbed a ping. You are visible again.'); break;
    case 'hunted':
      toast('You are being hunted — your position goes out every three minutes.');
      break;
    case 'hunt_cleared': toast('Your mark was cleared — they sabotaged a totem.'); break;
    case 'totem_destroyed': toast('A totem has been destroyed.'); break;
    case 'snitch_report': toast(`Someone sold out ${e.name}.`); break;
    case 'kicked': handleBeingKicked(); break;
    case 'panic':
      showPanicAlert(e);
      break;
    default: break;
  }
}

// Being removed is the one state change that should stop the app dead: keep
// ticking and the client would go on writing positions into a game it is no
// longer part of. Said out loud, once, then back to the start.
let kickHandled = false;
function handleBeingKicked() {
  if (kickHandled) return;
  kickHandled = true;
  stopPlaying();
  showView('view-landing');
  alert('The host has removed you from this game.');
}

let panicAlerts = [];
function showPanicAlert(e) {
  panicAlerts.push(e);
  alert(`PANIC — ${e.name}\n${e.message || 'No message.'}\n\nTheir exact position is now on your map.`);
  renderWorld();
}

// ---------- world rendering ----------

function renderWorld() {
  if (!mapReady || !worldLayer) return;
  const p = me();
  if (!p) return;
  const now = Date.now();
  worldLayer.clearLayers();

  const add = (layer) => layer.addTo(worldLayer);

  // Boundary — everyone.
  if (gameState && gameState.boundary && gameState.boundary.length >= 3) {
    add(L.polygon(gameState.boundary.map((q) => [q.lat, q.lng]), {
      color: MAP.boundary, weight: 2, fill: false, dashArray: '6 6',
    }));
  }

  // Totems — everyone. Grey while being sabotaged, on both roles' maps.
  Object.values(totemsState).forEach((t) => {
    if (t.status !== 'active') return;
    const sabotaging = isBeingSabotaged(t, now);
    add(L.circle([t.lat, t.lng], {
      radius: t.radiusM,
      color: sabotaging ? MAP.ash : MAP.totem,
      fillColor: sabotaging ? MAP.ashLit : MAP.totemLit,
      fillOpacity: sabotaging ? 0.08 : 0.15, weight: 2,
    }));
    add(L.circleMarker([t.lat, t.lng], {
      radius: 6, color: sabotaging ? MAP.ash : MAP.totem,
      fillColor: sabotaging ? MAP.ashLit : MAP.totemLit, fillOpacity: 1,
    }));
    // Precision ring: where you have to stand to sabotage.
    if (p.role === 'hider') {
      add(L.circle([t.lat, t.lng], {
        radius: totemPrecisionRadiusM(), color: MAP.totem,
        weight: 1, dashArray: '3 4', fill: false,
      }));
    }
  });

  // Totem contacts — seekers only. Exact, and anonymous: they age like any
  // other dot but carry no name, so a stack of them means somebody is camping
  // and a drifting line means somebody walked through.
  if (p.role === 'seeker') {
    Object.values(totemsState).forEach((t) => {
      (t.recentPings || []).forEach((ping) => {
        const look = pingAppearance(ping, now);
        if (!look) return;
        add(L.circleMarker([ping.lat, ping.lng], {
          radius: CONFIG.ping.dotRadiusPx,
          color: daylight() ? MAP.outline : look.color, fillColor: look.color,
          fillOpacity: look.opacity * 0.8, opacity: look.opacity,
          weight: 2, dashArray: '2 3',
        }));
      });
    });
  }

  // Signposts — only the ones you have walked into. An undiscovered sign is
  // not on your map at all, so leaving one somewhere out of the way is a
  // genuine gamble that anybody ever finds it.
  Object.entries(signpostsState).forEach(([id, s]) => {
    if (!signpostDiscovered(id)) return;
    add(L.circleMarker([s.lat, s.lng], {
      radius: 4, color: MAP.wood, fillColor: MAP.woodLit, fillOpacity: 1,
    }));
  });

  // Own tripwires — the placing seeker only. Hidden from everyone else.
  Object.values(tripwiresState).forEach((tw) => {
    if (tw.placedBy !== playerId) return;
    add(L.circle([tw.lat, tw.lng], {
      radius: CONFIG.seekerPowers.tripwire.triggerRadiusM,
      color: tw.triggered ? MAP.ash : MAP.gloom,
      fill: false, weight: 1, dashArray: '2 4',
    }));
  });

  renderTrails(p, now, add);
  renderReveals(p, now, add);
  renderScanGlow();

  // Panic markers — exact, to everyone, permanently.
  panicAlerts.forEach((e) => {
    if (e.lat == null) return;
    add(L.circleMarker([e.lat, e.lng], {
      radius: 10, color: MAP.blood, fillColor: MAP.bloodDim, fillOpacity: 1,
    }).bindTooltip(`PANIC: ${e.name}`, { permanent: true }));
  });

  // Where your token is heading, indoors.
  if (usingTravelMode() && travelPos && travelDest) {
    add(L.polyline([[travelPos.lat, travelPos.lng], [travelDest.lat, travelDest.lng]], {
      color: MAP.cold, weight: 2, dashArray: '4 6', opacity: 0.8,
    }));
    add(L.circleMarker([travelDest.lat, travelDest.lng], {
      radius: 5, color: MAP.cold, fill: false, weight: 2,
    }));
  }

  // Self — always exact, always visible.
  if (p.realLat) {
    if (!selfMarker) {
      selfMarker = L.circleMarker([p.realLat, p.realLng], {
        radius: 8, color: MAP.cold, fillColor: MAP.coldDim, fillOpacity: 1,
      }).addTo(map);
    } else {
      selfMarker.setLatLng([p.realLat, p.realLng]);
    }
  }
}

// Sabotage state used to hang off the totem as a map label. The map carries
// no labels any more, so it reads out in the banner strip instead — and only
// while you are actually standing at the totem, which is the only time it
// tells you anything you can act on.
function totemStatusBanner(p, now) {
  if (!myPos) return null;
  const precision = totemPrecisionRadiusM();
  const entry = Object.entries(totemsState).find(([, t]) =>
    t.status === 'active' && distanceM(myPos, { lat: t.lat, lng: t.lng }) <= precision);
  if (!entry) return null;
  const t = entry[1];

  if (p.role !== 'hider') {
    return t.placedBy === playerId ? ['info', 'Your totem — tap it to retire it.'] : null;
  }

  const present = freshPresenceIds(t, now).length;
  const progress = effectiveSabotageProgressS(t, now);
  if (present >= CONFIG.totem.sabotageMinParticipants) {
    const pct = Math.round((progress / t.requiredS) * 100);
    return ['info', `Sabotaging this totem — ${pct}%. Stay put.`];
  }
  if (progress > 0) {
    return ['warn', `Sabotage held at ${Math.round((progress / t.requiredS) * 100)}%`
      + ` — decays in ${Math.round(sabotageDecaySecondsLeft(t, now))}s.`
      + ` Needs ${CONFIG.totem.sabotageMinParticipants} hiders here.`];
  }
  if (present === 1) return ['info', 'Another hider is waiting here — stay and start it.'];
  return ['info', `Needs ${CONFIG.totem.sabotageMinParticipants} hiders standing here`
    + ` for ${(t.requiredS / 60).toFixed(1)} min.`];
}

// Everything anyone sees of another player is their trail of paid-for pings:
// a dot per reading, white when fresh, shading to red over five minutes, then
// fading out over five more. A faint line joins consecutive dots — which,
// because reported positions are fuzzy, will sometimes draw a confident
// journey for somebody who never moved.
function renderTrails(p, now, add) {
  Object.entries(playersState).forEach(([id, other]) => {
    const isSelf = id === playerId;

    // You always see your own trail, in green, so you know what you have been
    // giving away. Otherwise you only ever see the other side.
    if (!isSelf) {
      const wantRole = p.role === 'hider' ? 'seeker' : 'hider';
      if (other.role !== wantRole) return;
    }

    const dots = livePings(other, now);
    if (!dots.length) return;

    for (let k = 1; k < dots.length; k++) {
      const a = dots[k - 1];
      const b = dots[k];
      const look = pingAppearance(b, now);
      if (!look) continue;
      add(L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
        color: isSelf ? MAP.own : look.color,
        opacity: look.opacity * 0.35,
        weight: CONFIG.ping.trailWidthPx,
      }));
    }

    // No label of any kind. Colour already says how old a reading is and
    // green already says it is yours; a name over a dot would hand out
    // identity the ping itself never carried.
    dots.forEach((dot) => {
      const look = pingAppearance(dot, now);
      if (!look) return;
      const fill = isSelf ? MAP.own : look.color;
      add(L.circleMarker([dot.lat, dot.lng], {
        radius: CONFIG.ping.dotRadiusPx,
        // In daylight the tiles are left bright, and a white dot on a pale
        // tile is no dot at all — so the ring goes dark and the fill keeps
        // carrying the age.
        color: daylight() ? MAP.outline : fill,
        fillColor: fill,
        fillOpacity: look.opacity,
        opacity: look.opacity,
        weight: daylight() ? 2 : (dot.exact ? 2 : 1),
      }));
    });
  });
}

function renderReveals(p, now, add) {
  // The Probe wave, shown briefly so you can see what you just swept.
  if (revealActive('probe', now)) {
    const r = reveals.probe;
    add(L.polygon(arcPolygon(r.origin, r.bearing, r.halfWidthDeg, r.radiusM), {
      color: MAP.cold, fillColor: MAP.cold, fillOpacity: 0.08,
      weight: 1, dashArray: '6 6',
    }));
  }

  if (revealActive('disarm', now)) {
    reveals.disarm.points.forEach((pt) => {
      add(L.circleMarker([pt.lat, pt.lng], {
        radius: 7, color: MAP.ash, fillColor: MAP.bone, fillOpacity: 0.9,
      }));
    });
  }

  if (revealActive('snitch', now)) {
    reveals.snitch.entries.forEach((e) => {
      add(L.circleMarker([e.lat, e.lng], {
        radius: 8, color: MAP.violet, fillColor: MAP.violet, fillOpacity: 0.9,
      }));
    });
  }

  // No hunt cone. A hunt reports as ordinary dots on the hunted player's
  // trail, which is what lets Go quiet and Decoy answer it.
}

// ---------- Scan: direction only, at the edge of the screen ----------
// One glow per hider, each its own colour, so it says how many and roughly
// which way — and refuses to say anything more.
function renderScanGlow() {
  const host = el('scan-glow');
  if (!host) return;
  const now = Date.now();
  if (!revealActive('scan', now)) { host.innerHTML = ''; host.style.display = 'none'; return; }

  host.style.display = 'block';
  host.innerHTML = '';
  reveals.scan.bearings.forEach((b) => {
    const wedge = document.createElement('div');
    wedge.className = 'scan-wedge';
    wedge.style.background = 'conic-gradient(from ' + (b.bearing - 28)
      + 'deg, transparent 0deg, ' + b.color + ' 28deg, transparent 56deg)';
    host.appendChild(wedge);
  });
}

// ---------- how to play ----------
// Written for someone handed a phone in a park with no idea what this is.
// Tailored to your role once you have one, because the two roles play
// almost nothing alike.

function howToPlayHtml(role) {
  const common = `
    <h4>The short version</h4>
    <p>Hiders scatter across a marked area and try not to get found.
       Seekers go looking. Everything runs on your phone's GPS, so
       <strong>keep the screen on and the app open</strong> — if you lock your
       phone, it stops reporting you.</p>

    <h4>The map is empty, and staying empty costs money</h4>
    <p>Nobody shows up on the map on their own. <em>Every dot you ever see was
       paid for</em> — somebody spent a power to make it appear. Between those
       moments, everyone is invisible.</p>

    <h4>Reading a dot</h4>
    <p>A dot is where someone was when they got found out — and it is only
       accurate to about 30 metres, rolled fresh every time. Two dots on
       somebody standing perfectly still can land 60m apart, so a faint smear
       between dots is a hint about direction, never proof.</p>
    <p>Dots age in colour. <strong>White</strong> is seconds old and worth
       running at. It shades to <strong>red</strong> over five minutes, then
       fades away over five more. Your own dots are <strong>green</strong>, so
       you can see exactly what you have given away.</p>

    <h4>Getting caught</h4>
    <p>There is no tag button. A seeker has to physically find you and ask for
       the <strong>4-letter code</strong> shown at the top of your screen. You read
       it out, they type it in, and you switch sides and start seeking.</p>

    <h4>Powers</h4>
    <p>Everything costs <em>charge</em>, shown as ⚡ at the top. It refills on its
       own at about 15 a minute, and there is a cooldown after each use, so you
       cannot chain them. You have your whole side's set — there is nothing to
       choose in advance. Tap and hold a power to read what it does.</p>

    <h4>Staying safe</h4>
    <p>Stay inside the boundary. Step outside and a countdown starts, you are out
       if it finishes — and while you are out there the game gives your position
       away again and again, for free, and no power stops it. The
       <strong>Help</strong> button is not part of the game: it tells everyone
       exactly where you are and ends your round. Use it if something goes
       actually wrong. It is not an emergency service — call one of those if you
       need one.</p>`;

  if (role === 'seeker') {
    return `
      <h4>You're a seeker</h4>
      <p>Find every hider before the clock runs out. Hiders cannot see you at all
         unless they pay for it, and you cannot see them until you pay for it.
         Charge is the whole game.</p>
      <p>Two powers do the finding, and they work as a pair.
         <strong>Scan</strong> is cheap and vague: a coloured glow at the edge of
         your screen for each hider, telling you how many there are and roughly
         which way — no distance, no dots. <strong>Probe</strong> is your big
         spend: tap the map and a wave sweeps that entire half of the world out
         to the boundary, putting a dot on everyone it passes. Scan first to pick
         the half, then Probe it.</p>
      <p><strong>Tripwires</strong> cost almost nothing and are the only exact
         reading in the game — but you have to guess where somebody will walk.
         Line the gates and paths.</p>
      <p>You also carry <strong>I SEE YOU</strong>, which costs nothing and is
         always on. Any hider who comes within 20m of you gets it across their
         whole screen, and from that moment <em>they are not allowed to run</em>
         — only walk — until they are clear of you. It tells you nothing and
         does nothing on its own. It just means that once you are close, they
         cannot simply sprint away from you.</p>
      <p>If nobody's been caught for a while, you can start a <strong>Hunt</strong>
         on one hider. It costs no charge, and for ten minutes their position is
         reported to you every three minutes — four readings, free. They are told
         it is happening and they know when each one is due, so expect them to
         spend <strong>Go quiet</strong> on one of them and a <strong>Decoy</strong>
         to poison the rest. Hunt someone you can already close on.</p>
      ${common}`;
  }

  if (role === 'hider') {
    return `
      <h4>You're a hider</h4>
      <p>Survive. You're scored on how long you last. Sitting still is genuinely
         safe now — nothing reports you for it — so the danger is not time, it is
         a seeker deciding to spend on the half of the map you are in.</p>
      <p>You can't see the seekers at all unless you spend on
         <strong>Seeker scan</strong>, which pins every one of them, exactly. It
         is expensive and it is your only window.</p>
      <p>Your two saves are worth understanding.
         <strong>Go quiet</strong> eats the next ping aimed at you — a wave washes
         straight over you and reports nothing. <strong>Decoy</strong> is louder:
         for three minutes, anything that pings you pings a fake you instead,
         walking away on a bearing you choose. The seeker gets a real dot, in the
         wrong place, moving.</p>
      <p>Get within 20m of a seeker and <strong>I SEE YOU</strong> fills your
         screen. Everything still works — you can read the map, spend powers,
         do anything you could do a second ago. What changes is you:
         <em>you can hide, but you can't run</em>. While it is up you walk.
         Nobody's phone can make you, which is exactly why it is on yours.</p>
      <p>If a seeker starts a <strong>Hunt</strong> on you, you are told, and
         from then on your position goes out to them every three minutes for ten
         minutes. The banner counts down to each one, so you can see the reading
         coming: <strong>Go quiet</strong> eats one outright, a
         <strong>Decoy</strong> sends the whole run of them somewhere you are
         not. You can also <strong>Snitch</strong> while hunted — sell out
         another hider to get the seeker off you. They're never told it was
         you.</p>
      <p>One more that isn't obvious. <strong>Totems</strong> are watchtowers
         seekers can drop; standing inside one reports you anonymously and
         exactly. Two hiders standing at one together can destroy it.</p>
      ${common}`;
  }

  return `<h4>Two roles</h4>
    <p>The host decides who hides and who seeks. You'll be told in a moment, and
       this page will explain your side of it.</p>
    ${common}`;
}

function openHowToPlay() {
  const p = me();
  el('how-body').innerHTML = howToPlayHtml(p && p.role);
  el('how-modal').style.display = 'flex';
}

el('btn-how-landing').onclick = openHowToPlay;
el('btn-how-lobby').onclick = openHowToPlay;
el('btn-close-how').onclick = () => { el('how-modal').style.display = 'none'; };

// Shown once, the first time a player reaches a live game, so nobody starts
// running with no idea what the screen means.
function maybeShowFirstRunHelp() {
  try {
    if (localStorage.getItem('h_seen_help')) return;
    localStorage.setItem('h_seen_help', '1');
  } catch (e) { return; }
  openHowToPlay();
}

// ---------- scoreboard ----------

const OUTCOME_LABEL = {
  active: 'survived',
  captured: 'found',
  boundary_eliminated: 'out of bounds',
  offline_eliminated: 'lost contact',
  quit: 'withdrew',
  kicked: 'removed',
  panicked: 'panic',
};

function renderEndActions() {
  const p = me();
  const nextCode = gameState && gameState.nextGameCode;
  const btn = el('btn-next-game');
  const note = el('next-game-note');

  if (nextCode) {
    btn.textContent = 'Join the next round';
    btn.disabled = false;
    btn.onclick = () => goToGame(nextCode);
    note.textContent = `The host has opened a new round — code ${nextCode}.`;
    return;
  }

  if (p && p.isHost) {
    btn.textContent = 'Play again';
    btn.disabled = false;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Setting up…';
      try {
        goToGame(await createNextGame());
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Play again';
        toast('Could not start another round.');
      }
    };
    note.textContent = 'Same boundary and settings. Everyone else gets a button to follow you in.';
    return;
  }

  btn.textContent = 'Waiting for the host';
  btn.disabled = true;
  note.textContent = 'The host can open another round from this screen.';
}

el('btn-declare-hidden').onclick = () => declareHidden();

el('btn-back-start').onclick = backToStart;

function renderScoreboard() {
  const list = el('scoreboard');
  list.innerHTML = '';
  const now = Date.now();

  // Only players who were ever hiders have a survival time. Someone who
  // started as a seeker was never being scored.
  const scored = Object.values(playersState)
    .filter((p) => p.role === 'hider' || p.convertedAt)
    .map((p) => ({
      name: p.name,
      ms: p.survivalMs != null ? p.survivalMs : survivalMsFor(p, now),
      // A converted hider is now a seeker, but was caught to get there.
      outcome: p.convertedAt ? 'found' : (OUTCOME_LABEL[p.status] || p.status),
      survived: p.status === 'active' && p.role === 'hider',
    }))
    .sort((a, b) => b.ms - a.ms);

  scored.forEach((r) => {
    const li = document.createElement('li');
    const mins = Math.floor(r.ms / 60000);
    const secs = Math.floor((r.ms % 60000) / 1000);
    li.innerHTML = `<strong>${r.name}</strong> — ${mins}m ${secs}s ` +
      `<span class="muted">(${r.outcome})</span>`;
    list.appendChild(li);
  });

  const seekers = Object.values(playersState)
    .filter((p) => p.role === 'seeker' && !p.convertedAt)
    .map((p) => p.name);
  const survivors = scored.filter((r) => r.survived).map((r) => r.name);

  el('end-summary').textContent =
    (survivors.length ? `Survived to the end: ${survivors.join(', ')}. ` : 'Every hider was found. ') +
    (seekers.length ? `Seekers: ${seekers.join(', ')}.` : '');
}

showView('view-landing');

// A scanned QR and a rematch link both arrive as ?join=CODE. This used to
// join immediately, which walked straight past the name field — outdoor
// testing produced players with no names — and past the location prompt with
// it, since that is asked from inside the join tap. So the link only fills
// the form in: joining still goes through the button, one code path, name and
// GPS permission included.
(function prefillJoinFromUrl() {
  const code = new URLSearchParams(location.search).get('join');
  if (!code) return;
  el('input-code').value = code.toUpperCase();
  const known = rememberedName();
  if (known) el('input-name-join').value = known;

  const prompt = el('join-prompt');
  prompt.textContent = known
    ? `Joining game ${code.toUpperCase()} — check your name and tap Join.`
    : `Joining game ${code.toUpperCase()} — what should everyone call you?`;
  prompt.style.display = 'block';

  // Put them at the join card with the cursor where the missing bit is.
  el('input-name-join').scrollIntoView({ block: 'center' });
  if (!known) el('input-name-join').focus();
})();
