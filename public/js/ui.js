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
  // Both of these must happen inside the tap that got us here: iOS only
  // grants location and the screen wake lock in response to a gesture.
  const r = await requestLocation();
  keepScreenAwake();
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
  // Taken on the container rather than through Leaflet's own click, so a
  // rotated map still targets where the finger actually pointed.
  el('map').addEventListener('click', (ev) => {
    if (!mapReady || ev.target.closest('.leaflet-control')) return;
    onMapPoint(mapPointFromEvent(ev));
  });
  mapReady = true;
  applyCompass();
}

let recentered = false;
function recenterOnSelf(lat, lng) {
  if (!recentered) { map.setView([lat, lng], 17); recentered = true; }
}

// The map follows you once, on the first fix, and then leaves you alone so
// you can pan around. This is how you get back.
// ---------- phone closed ----------

function renderClosedState() {
  const on = !!phoneClosed;
  el('closed-screen').classList.toggle('on', on);
  if (!on) return;
  const mins = Math.round(CONFIG.offline.debtPerMs / 1000);
  el('closed-cost').textContent =
    `Every ${mins === 60 ? 'minute' : mins + ' seconds'} closed costs you one `
    + 'position report when you come back, paid one every '
    + `${Math.round(CONFIG.offline.debtPingIntervalMs / 1000)} seconds. Stay closed `
    + `longer than ${Math.round(CONFIG.offline.awayAfterMs / 60000)} minutes and you `
    + 'drop out of the game until the host puts you back.';
}

el('btn-open-phone').onclick = async () => {
  const btn = el('btn-open-phone');
  btn.disabled = true;
  try { await openPhone(); } finally { btn.disabled = false; }
};

// ---------- display toggles ----------
//
// Three things people asked to be able to turn on and off. All per player,
// all remembered, none of them touching a rule — this is what your screen
// shows you, not what is true.

const TOGGLES = {
  labels: { key: 'h_labels', on: true },     // names and ages on dots
  compass: { key: 'h_compass', on: false },  // turn the map to face your heading
};

function toggleOn(name) { return TOGGLES[name].on; }

function loadToggles() {
  Object.values(TOGGLES).forEach((t) => {
    try {
      const v = localStorage.getItem(t.key);
      if (v !== null) t.on = v === '1';
    } catch (e) { /* private mode — defaults stand */ }
  });
}

function setToggle(name, on) {
  const t = TOGGLES[name];
  t.on = !!on;
  try { localStorage.setItem(t.key, t.on ? '1' : '0'); } catch (e) { /* ignore */ }
  if (name === 'compass') applyCompass();
  el('btn-compass').classList.toggle('on', TOGGLES.compass.on);
  if (mapReady) renderWorld();
  if (el('key-panel').classList.contains('on')) renderKey();
}

loadToggles();

// ---------- the compass ----------
//
// Two things at once, because they answer the same question. The needle
// always shows which way you are facing. With the toggle on, the map itself
// turns so that "up" is the way you are going, which is how people actually
// read a map while walking.
//
// Rotating a Leaflet map means its own idea of where a tap landed is wrong,
// so taps are taken here first and unrotated by hand before the map ever
// sees them — see mapPointFromEvent.

let heading = null;          // degrees, 0 = north, null until the phone says

// How far the map has been turned, and how far it had to be blown up to keep
// its corners off the screen. Both are needed to read a tap back.
function mapTurn() {
  return (toggleOn('compass') && heading != null) ? -heading : 0;
}

// A rotated rectangle leaves triangles of nothing at the corners. This is the
// smallest scale that keeps the viewport covered at a given angle.
function mapCover(turnDeg, w, h) {
  if (!turnDeg || !w || !h) return 1;
  const a = Math.abs((turnDeg * Math.PI) / 180);
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
}

function applyCompass() {
  const pane = document.getElementById('map');
  if (!pane) return;
  const turn = mapTurn();
  const cover = mapCover(turn, pane.offsetWidth, pane.offsetHeight);
  pane.style.transformOrigin = '50% 50%';
  pane.style.transform = turn ? `rotate(${turn}deg) scale(${cover.toFixed(4)})` : '';
  const needle = document.querySelector('.compass-needle');
  // North-up: the needle shows your heading. Heading-up: the map is already
  // turned, so north is what moves and the needle sits still at the top.
  if (needle) needle.style.transform = `rotate(${heading == null ? 0 : heading + turn}deg)`;
}

function onHeading(deg) {
  if (deg == null || Number.isNaN(deg)) return;
  const next = (deg + 360) % 360;
  // Ignore sub-degree jitter, or the map shivers in your hand.
  if (heading != null && Math.abs(((next - heading + 540) % 360) - 180) < 2) return;
  heading = next;
  applyCompass();
}

// iOS needs permission for the compass, and only grants it from a tap.
async function askForCompass() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) { toast('This phone has no compass.'); return false; }
  if (typeof DOE.requestPermission === 'function') {
    try {
      const r = await DOE.requestPermission();
      if (r !== 'granted') { toast('Compass permission refused.'); return false; }
    } catch (e) { toast('Compass unavailable.'); return false; }
  }
  window.addEventListener('deviceorientation', (e) => {
    // iOS reports a true compass heading directly; everyone else gives the
    // rotation from north as alpha, which counts the other way round.
    if (typeof e.webkitCompassHeading === 'number') onHeading(e.webkitCompassHeading);
    else if (typeof e.alpha === 'number') onHeading(360 - e.alpha);
  }, true);
  return true;
}

el('btn-compass').onclick = async () => {
  if (toggleOn('compass')) { setToggle('compass', false); return; }
  if (!(await askForCompass())) return;
  setToggle('compass', true);
};

// A tap on a rotated map lands somewhere else entirely as far as Leaflet is
// concerned, and the trap is that getBoundingClientRect on a rotated element
// returns the box around the rotation, not the element — for a quarter turn
// its width and height swap. The centre is the one point rotation and scaling
// both leave alone, so everything is measured from there, undone, and handed
// back in the element's own unrotated coordinates.
function mapPointFromEvent(ev) {
  const pane = el('map');
  const box = pane.getBoundingClientRect();
  const w = pane.offsetWidth;          // layout size — a transform never moves this
  const h = pane.offsetHeight;
  const turn = mapTurn();
  const cover = mapCover(turn, w, h);

  let x = (ev.clientX - (box.left + box.width / 2)) / cover;
  let y = (ev.clientY - (box.top + box.height / 2)) / cover;
  if (turn) {
    const a = (turn * Math.PI) / 180;   // turn it back by the same angle
    const rx = x * Math.cos(a) + y * Math.sin(a);
    const ry = -x * Math.sin(a) + y * Math.cos(a);
    x = rx; y = ry;
  }
  return map.containerPointToLatLng(L.point(x + w / 2, y + h / 2));
}

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
  // Every distance rule stretches from the area you draw, so the host gets
  // to see what they are choosing while they are still choosing it.
  info.innerHTML = `${(area / 10000).toFixed(1)} ha · M = ${Math.round(mVal)}m`
    + `<br>Readings wrong by up to <strong>${pingJitterM(mVal)}m</strong>`
    + ` · tripwires catch at ${tripwireRadiusM(mVal)}m`
    + ` · disarm clears ${disarmRadiusM(mVal)}m`
    + `<br>Totems ${totemRadiusM(mVal)}m wide, `
    + `${(totemSabotageSeconds(totemRadiusM(mVal)) / 60).toFixed(1)} min to sabotage`
    + ` · boundary warning at ${boundaryWarningZoneM(mVal)}m`;
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
  if (r.rejected) {
    alert(`That area is too small to play in — every distance in the game would `
      + `collapse to its minimum. Draw at least ${r.minM}m across.`);
    return;
  }
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
  const now = Date.now();
  Object.entries(players).forEach(([id, p]) => {
    if (p.status === 'kicked') return;
    const li = document.createElement('li');
    const away = p.status === 'away';
    const closed = !away && playerUnavailable(p, now);
    const label = `${p.name}${p.isHost ? ' (host)' : ''}`;
    const role = (away ? 'dropped out' : closed ? 'phone closed' : null)
      || (p.role ? p.role : 'no role');
    if (away || closed) li.classList.add('is-away');

    if (!iAmHost) {
      li.textContent = `${label} — ${role}`;
      list.appendChild(li);
      return;
    }

    li.classList.add('row-pick');
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
    safely('replay', renderReplay);
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

  // What you owe for going dark, and when the next instalment goes out.
  if (p.pingDebt > 0) {
    const due = Math.max(0, Math.ceil(((p.nextDebtPingAt || 0) - now) / 1000));
    items.push(['warn', `${p.pingDebt} position report(s) owed for time offline`
      + ` — next in ${due}s.`]);
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

// A description that quotes a distance is a function, so it quotes the
// distance in THIS game rather than one from a 600m map.
function powerDesc(def) {
  if (!def) return '';
  return typeof def.desc === 'function' ? def.desc() : def.desc;
}

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
    b.title = powerDesc(def);
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
    b.title = reason || powerDesc(POWERS[b.dataset.power]);
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
    add('act-taunt', 'Taunt', openTauntModal);
    add('act-chat', 'Hiders', openChat);
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
  const taunt = el('act-taunt');
  if (taunt) {
    const reason = tauntAvailableReason(p, now);
    taunt.disabled = !!reason;
    taunt.title = reason || 'Set off a firework. Costs nothing, tells them nothing.';
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

function onMapPoint(latlng) {
  const point = { lat: latlng.lat, lng: latlng.lng };
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

    // Greyed-out players are waiting on exactly this.
    Object.entries(playersState)
      .filter(([, x]) => x.status === 'away')
      .forEach(([id, x]) => {
        mk(`Put ${x.name} back in`, async () => {
          await reinstatePlayer(id);
          toast(`${x.name} is back in the game.`);
        });
      });
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
  const close = document.createElement('button');
  close.className = 'secondary';
  close.textContent = 'Close my phone';
  close.onclick = async () => {
    if (!confirm('Close your phone? You stop reporting, and every minute costs '
      + 'you a position report when you come back.')) return;
    el('menu-modal').style.display = 'none';
    await closePhone();
  };
  host.appendChild(close);

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
    case 'went_away': toast(`${e.name} has dropped out — no contact.`); break;
    case 'reinstated': toast('The host has put you back in the game.'); break;
    case 'player_reinstated': toast(`${e.name} is back in the game.`); break;
    // Everyone sees a taunt, including the person who set it off.
    case 'taunt': fireFirework(e); break;
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

// ---------- the key ----------
//
// Every colour on the map was already carrying information and nothing said
// so. This says so. It is built from the same MAP palette and the same CONFIG
// the map draws from, so it cannot drift out of date, and it reads the
// distances for THIS game rather than quoting a 600m map at people.

function keyRow(swatchClass, style, name, note) {
  return `<div class="key-row"><span class="key-swatch ${swatchClass}" style="${style}"></span>`
    + `<span><span class="key-name">${name}</span> <span class="key-note">${note}</span></span></div>`;
}

function renderKey() {
  const p = me();
  const seeker = p && p.role === 'seeker';
  const them = seeker ? 'a hider' : 'a seeker';
  const rows = [];

  rows.push('<h4>Dots — somebody\'s position, when it was taken</h4>');
  rows.push(keyRow('fade', '', 'White → red → gone',
    `How old the reading is. White is seconds old and worth running at; red is `
    + `five minutes; it fades to nothing at ten.`));
  rows.push(keyRow('dot', `background:${MAP.own}`, 'Green',
    'Yours. What you have given away so far.'));
  rows.push(keyRow('ring', '', 'Yellow ring',
    'That phone was closed when the reading was taken — it is where they '
    + 'were, not where they are.'));
  rows.push(keyRow('dot', 'background:#fff;border:2px solid #16060a', 'Thick edge',
    'Exact. A tripwire, a totem or a panic alert — no fuzz on it at all.'));
  rows.push(`<div class="key-row"><span class="key-swatch" style="background:none"></span>`
    + `<span class="key-note">Everything else is wrong by up to `
    + `<strong>${pingJitterM()}m</strong>, rolled fresh each time — which is why a `
    + `still player can look like a moving one.</span></div>`);

  rows.push('<h4>On the ground</h4>');
  rows.push(keyRow('outline', `color:${MAP.boundary}`, 'Dashed red outline',
    'The boundary. Step outside and a countdown starts.'));
  rows.push(keyRow('', `background:${MAP.totemLit}`, 'Green circle',
    `A totem, ${totemRadiusM()}m across. Seekers see anyone inside it. Two hiders `
    + 'standing at the middle can destroy it.'));
  rows.push(keyRow('outline', `color:${MAP.gloom}`, 'Faint dashed circle',
    seeker ? `Your tripwire, ${tripwireRadiusM()}m across. Only you can see it.`
      : 'Not shown to you — tripwires are hidden until you walk into one.'));
  rows.push(keyRow('dot', `background:${MAP.woodLit}`, 'Small brown dot',
    'A signpost you have found. Walk within '
    + `${CONFIG.signposts.discoverRadiusM}m of one and it appears on your map for good.`));
  rows.push(keyRow('dot', `background:${MAP.coldDim};border:2px solid ${MAP.cold}`, 'Blue marker',
    'You.'));

  rows.push('<h4>Only while a power is running</h4>');
  rows.push(keyRow('', `background:${MAP.cold};opacity:0.4`, 'Blue wedge',
    'Where your last Probe swept.'));
  rows.push(keyRow('', 'background:linear-gradient(90deg,#ff4d4d,#4dd2ff,#a94dff)',
    'Glow at the screen edge',
    `A Scan. One colour per ${seeker ? 'hider' : 'player'}, showing roughly which `
    + 'way they are — never how far.'));
  rows.push(keyRow('dot', `background:${MAP.violet}`, 'Violet dot',
    'A hider the Snitch surveyed for you.'));

  el('key-body').innerHTML = rows.join('')
    + `<div class="key-toggle"><span>Names and ages on dots</span>`
    + `<button class="secondary" id="btn-toggle-labels">${toggleOn('labels') ? 'On' : 'Off'}</button></div>`
    + `<div class="key-toggle"><span>Turn the map to face the way I am going</span>`
    + `<button class="secondary" id="btn-toggle-compass">${toggleOn('compass') ? 'On' : 'Off'}</button></div>`;

  el('btn-toggle-labels').onclick = () => setToggle('labels', !toggleOn('labels'));
  el('btn-toggle-compass').onclick = async () => {
    if (toggleOn('compass')) { setToggle('compass', false); return; }
    if (await askForCompass()) setToggle('compass', true);
  };
}

function setKeyOpen(on) {
  el('key-panel').classList.toggle('on', on);
  el('btn-key').classList.toggle('on', on);
  if (on) renderKey();
}

el('btn-key').onclick = () => setKeyOpen(!el('key-panel').classList.contains('on'));
el('btn-close-key').onclick = () => setKeyOpen(false);

// ---------- a sign, found ----------

let signQueue = [];
function showFoundSign(text) {
  signQueue.push(text);
  if (el('sign-found').classList.contains('on')) return;
  nextFoundSign();
}

function nextFoundSign() {
  const text = signQueue.shift();
  if (text == null) { el('sign-found').classList.remove('on'); return; }
  el('sign-found-text').textContent = text;
  el('sign-found').classList.add('on');
}

el('btn-close-sign').onclick = nextFoundSign;

// ---------- fireworks ----------
//
// Drawn over the map rather than into it, which is how it leaves no trace:
// there is nothing on the map to remove, only DOM that deletes itself. If
// the firework is off screen the message still shows, pinned to the edge
// nearest it, so a taunt from the far side of the park still lands.

const FIREWORK_PATTERNS = {
  burst:  { sparks: 26, spread: 110, life: 1500, jitter: 0.45 },
  ring:   { sparks: 22, spread: 90,  life: 1700, jitter: 0.05 },
  willow: { sparks: 18, spread: 120, life: 2300, jitter: 0.35, droop: 70 },
  comet:  { sparks: 14, spread: 150, life: 1300, jitter: 0.8, arc: 55 },
  spiral: { sparks: 24, spread: 100, life: 1900, jitter: 0.2, twist: 300 },
};

function fireFirework(e) {
  const layer = el('firework-layer');
  if (!layer || !mapReady) return;
  const pat = FIREWORK_PATTERNS[e.shape] || FIREWORK_PATTERNS.burst;
  const box = el('map').getBoundingClientRect();
  const pt = map.latLngToContainerPoint([e.lat, e.lng]);
  const onScreen = pt.x >= 0 && pt.y >= 0 && pt.x <= box.width && pt.y <= box.height;
  const x = Math.max(28, Math.min(box.width - 28, pt.x));
  const y = Math.max(40, Math.min(box.height - 40, pt.y));

  const node = document.createElement('div');
  node.className = 'firework';
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.style.color = e.colour || '#ff4d4d';

  const flash = document.createElement('i');
  flash.className = 'flash';
  node.appendChild(flash);

  for (let i = 0; i < pat.sparks; i++) {
    const spark = document.createElement('i');
    spark.className = 'spark' + (e.shape === 'willow' ? ' willow' : '');
    const base = (360 / pat.sparks) * i + (pat.twist ? (i / pat.sparks) * pat.twist : 0);
    const ang = ((base + (e.shape === 'comet' ? pat.arc : 0)) * Math.PI) / 180;
    const reach = pat.spread * (1 - pat.jitter * Math.random());
    spark.style.setProperty('--dx', `${Math.cos(ang) * reach}px`);
    spark.style.setProperty('--dy', `${Math.sin(ang) * reach + (pat.droop || 0)}px`);
    spark.style.setProperty('--life', `${pat.life}ms`);
    spark.style.animationDelay = `${Math.random() * 120}ms`;
    node.appendChild(spark);
  }

  const label = document.createElement('div');
  label.className = 'firework-label';
  label.style.left = `${x}px`;
  label.style.top = `${y}px`;
  label.textContent = (e.message ? `${e.name}: ${e.message}` : `${e.name}!`)
    + (onScreen ? '' : ' ↑');
  layer.appendChild(node);
  layer.appendChild(label);

  // Five seconds, then gone, and nothing written down anywhere.
  setTimeout(() => { node.remove(); label.remove(); }, CONFIG.taunt.durationMs);
}

// ---------- taunts ----------

const TAUNT_LINES = [
  'Over here!', 'Still here.', 'Getting warmer?', 'Missed me.',
  'Nice try.', 'Too slow.', 'Behind you.', "You'll never.",
];

function openTauntModal() {
  const reason = tauntAvailableReason(me());
  if (reason) { toast(reason); return; }
  const list = el('taunt-list');
  list.innerHTML = '';
  TAUNT_LINES.forEach((line) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = line;
    b.onclick = async () => { el('taunt-modal').style.display = 'none'; await sendTaunt(line); };
    li.appendChild(b);
    list.appendChild(li);
  });
  el('input-taunt').value = '';
  el('taunt-modal').style.display = 'flex';
}

el('btn-cancel-taunt').onclick = () => { el('taunt-modal').style.display = 'none'; };
el('btn-send-taunt').onclick = async () => {
  const msg = el('input-taunt').value.trim();
  el('taunt-modal').style.display = 'none';
  await sendTaunt(msg);
};

// ---------- hider chat ----------

let chatUnread = 0;
let chatSeenAt = Date.now();

function renderChat() {
  const p = me();
  const log = el('chat-log');
  const open = el('chat-modal').style.display === 'flex';
  if (!p || p.role !== 'hider') { chatUnread = 0; refreshChatButton(); return; }

  const msgs = chatMessages();
  chatUnread = msgs.filter((m) => m.at > chatSeenAt && m.from !== playerId).length;
  refreshChatButton();
  if (!open) return;

  log.innerHTML = '';
  if (!msgs.length) {
    log.innerHTML = '<li class="empty">Nothing yet. The seekers cannot read this.</li>';
  }
  msgs.forEach((m) => {
    const li = document.createElement('li');
    if (m.from === playerId) li.className = 'mine';
    const who = document.createElement('span');
    who.className = 'who';
    const mins = Math.round((Date.now() - m.at) / 60000);
    who.textContent = `${m.from === playerId ? 'You' : m.name} · ${mins < 1 ? 'just now' : mins + 'm ago'}`;
    li.appendChild(who);
    li.appendChild(document.createTextNode(m.text));
    log.appendChild(li);
  });
  log.scrollTop = log.scrollHeight;
  chatSeenAt = Date.now();
  chatUnread = 0;
  refreshChatButton();
}

function refreshChatButton() {
  const b = el('act-chat');
  if (b) b.textContent = chatUnread ? `Hiders (${chatUnread})` : 'Hiders';
}

function openChat() {
  el('chat-modal').style.display = 'flex';
  renderChat();
}

el('btn-close-chat').onclick = () => { el('chat-modal').style.display = 'none'; };
el('btn-send-chat').onclick = async () => {
  const box = el('input-chat');
  const text = box.value;
  box.value = '';
  if (await sendChat(text)) renderChat();
};
el('input-chat').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el('btn-send-chat').click();
});

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
      radius: tripwireRadiusM(),
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

    // Labels are a display choice now, not a rule. Off, the colour carries
    // everything; on, the freshest dot per player says who and how long ago,
    // which is what people kept asking the map for.
    const newest = dots[dots.length - 1];
    dots.forEach((dot) => {
      const look = pingAppearance(dot, now);
      if (!look) return;
      const fill = isSelf ? MAP.own : look.color;
      // A dot made while that phone was closed is not where they are, it is
      // where they were when it went dark. Ringed in yellow so nobody runs
      // half a mile at a reading that was never live.
      if (dot.stale) {
        add(L.circleMarker([dot.lat, dot.lng], {
          radius: CONFIG.ping.dotRadiusPx + 5,
          color: MAP.amber, fill: false,
          weight: 2, opacity: look.opacity, dashArray: '3 3',
        }));
      }
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
      if (toggleOn('labels') && dot === newest) {
        add(L.marker([dot.lat, dot.lng], {
          icon: L.divIcon({
            className: 'dot-label' + (isSelf ? ' mine' : '') + (dot.stale ? ' stale' : ''),
            html: `${isSelf ? 'You' : other.name} · ${Math.round((now - dot.at) / 1000)}s`
              + (dot.stale ? ' · stale' : (dot.exact ? ' · exact' : '')),
            iconSize: null,
          }),
          interactive: false,
          keyboard: false,
        }));
      }
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

    <h4>Reading the map</h4>
    <p>Tap <strong>KEY</strong> on the right of the map for what every colour
       means — it is built from this game's own numbers, so it tells you the
       real distances rather than a rule of thumb. The same panel turns
       <strong>names and ages on dots</strong> on and off, and turns the map so
       that <strong>up is the way you are facing</strong> if you would rather
       read it that way. The <strong>☀</strong> button lifts the whole screen
       for bright sunlight.</p>

    <h4>Closing your phone</h4>
    <p>A ninety-minute game outlives some batteries. <strong>Menu → Close my
       phone</strong> stops you reporting entirely. A phone that locks itself in
       a pocket ends up in the same place, and the game treats them the same.</p>
    <p>It is not free. While you are dark, anyone who pays to find you gets your
       <em>last known</em> position, ringed in yellow so they know it is stale —
       and every minute you are closed costs you one position report when you
       come back, paid out one every thirty seconds. Fifteen minutes dark and you
       drop out of the game until the host puts you back in.</p>

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
      <p>Hiders can talk to each other and set off fireworks at you. You cannot
         read the one and you learn nothing from the other — a firework is five
         seconds of somebody being pleased with themselves, and it leaves
         nothing on the map. Do not go running at one.</p>
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
      <p>You have two things no seeker has. <strong>Hiders</strong> is a chat
         only the hiding side can read — use it to coordinate, or to warn
         somebody a seeker just walked past you. <strong>Taunt</strong> sets off
         a firework where you stand: everybody sees it, for five seconds, and
         then it is gone leaving nothing behind. It costs no charge and gives
         away nothing anyone can use, and it is scored on its own ladder at the
         end. It is there purely so you can be insufferable about surviving.</p>
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
  away: 'lost contact',
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

// ---------- the walk-through ----------
//
// The one time the game shows true positions. For ninety minutes nobody saw
// anything they had not paid for; at the end everybody gets to see where
// everyone actually went, which is where the stories come from — who walked
// straight past whom, who sat in the same bush the whole time.

let replayMap = null;

function renderReplay() {
  const holder = el('replay-map');
  if (!holder || typeof L === 'undefined') return;
  const tracks = Object.entries(playersState)
    .map(([id, p]) => ({ id, p, track: (p.track || []) }))
    .filter((t) => t.track.length > 1);

  if (!tracks.length) {
    holder.style.display = 'none';
    el('replay-legend').innerHTML =
      '<span class="replay-key">Nobody moved far enough to draw.</span>';
    return;
  }
  holder.style.display = 'block';

  if (!replayMap) {
    replayMap = L.map('replay-map', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(replayMap);
  }
  replayMap.eachLayer((l) => { if (l instanceof L.Polyline || l instanceof L.CircleMarker) replayMap.removeLayer(l); });

  const bounds = [];
  if (gameState && gameState.boundary && gameState.boundary.length >= 3) {
    L.polygon(gameState.boundary.map((q) => [q.lat, q.lng]), {
      color: MAP.boundary, weight: 2, fill: false, dashArray: '6 6',
    }).addTo(replayMap);
    gameState.boundary.forEach((q) => bounds.push([q.lat, q.lng]));
  }

  const legend = [];
  tracks.forEach(({ id, p, track }) => {
    const colour = playerColour(id);
    const line = track.map((pt) => [pt.lat, pt.lng]);
    line.forEach((pt) => bounds.push(pt));
    L.polyline(line, { color: colour, weight: 3, opacity: 0.85 }).addTo(replayMap);
    // Hollow at the start, solid where they finished.
    L.circleMarker(line[0], { radius: 5, color: colour, fill: false, weight: 2 }).addTo(replayMap);
    L.circleMarker(line[line.length - 1], {
      radius: 6, color: colour, fillColor: colour, fillOpacity: 1,
    }).addTo(replayMap);
    legend.push(`<span class="replay-key"><i style="background:${colour}"></i>`
      + `${p.name} · ${p.role || '—'}</span>`);
  });

  // Every sign anyone left, whether or not you ever found it.
  Object.values(signpostsState).forEach((sp) => {
    bounds.push([sp.lat, sp.lng]);
    L.circleMarker([sp.lat, sp.lng], {
      radius: 5, color: MAP.wood, fillColor: MAP.woodLit, fillOpacity: 1,
    }).addTo(replayMap).bindTooltip(sp.text || 'A sign', { direction: 'top' });
  });
  if (Object.keys(signpostsState).length) {
    legend.push(`<span class="replay-key"><i style="background:${MAP.woodLit}"></i>`
      + `signposts — tap to read</span>`);
  }

  el('replay-legend').innerHTML = legend.join('');
  if (bounds.length) replayMap.fitBounds(bounds, { padding: [20, 20] });
  setTimeout(() => replayMap.invalidateSize(), 120);
}

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

  // Bravado, ranked on its own ladder so it never competes with surviving.
  const taunts = Object.values(playersState)
    .filter((x) => (x.tauntScore || 0) > 0)
    .sort((a, b) => b.tauntScore - a.tauntScore);
  const tauntLine = el('taunt-board');
  if (tauntLine) {
    tauntLine.innerHTML = taunts.length
      ? '<strong>Fireworks:</strong> ' + taunts
        .map((x) => `${x.name} ×${x.tauntScore}`).join(' · ')
      : 'Nobody set anything off. Disappointing.';
  }

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
