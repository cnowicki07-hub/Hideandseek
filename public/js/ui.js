// UI rendering and all user interaction.
//
// Visibility rules live here and are deliberately sparse: hiders see nothing
// but themselves and the shared world (boundary, totems, cordons, signposts).
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
el('btn-locate').onclick = () => {
  if (!mapReady) return;
  if (!myPos) { toast('No GPS fix yet.'); return; }
  map.setView([myPos.lat, myPos.lng], Math.max(map.getZoom(), 17));
};

// ---------- landing ----------

el('btn-host').onclick = async () => {
  currentPlayerName = el('input-name-host').value.trim() || 'Host';
  if (!(await ensureLocation())) return;
  const sideM = parseFloat(el('input-area-side').value) || 400;
  const lengthMin = parseFloat(el('input-length').value) || 90;
  try {
    await hostCreateGame({
      areaM2: sideM * sideM,
      gameLengthMin: lengthMin,
      endConditionMode: el('input-end-mode').value,
    });
  } catch (e) { storeConnectionFailed(e); return; }
  el('lobby-code').textContent = gameCode;
  showView('view-lobby');
};

el('btn-join').onclick = async () => {
  currentPlayerName = el('input-name-join').value.trim() || 'Player';
  const code = el('input-code').value.trim();
  if (!code) { alert('Enter a game code.'); return; }
  if (!(await ensureLocation())) return;
  let ok;
  try { ok = await joinGame(code, currentPlayerName, false); }
  catch (e) { storeConnectionFailed(e); return; }
  if (ok) {
    el('lobby-code').textContent = gameCode;
    showView('view-lobby');
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

// ---------- lobby: loadout ----------

function loadoutKeys() {
  return Object.keys(POWERS).filter((k) => POWERS[k].loadout);
}

function renderLoadoutPicker() {
  const host = el('loadout-options');
  if (host.dataset.built) { updateLoadoutCount(); return; }
  host.innerHTML = '';
  loadoutKeys().forEach((key) => {
    const def = POWERS[key];
    const label = document.createElement('label');
    label.className = 'checkline';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = key;
    box.onchange = onLoadoutChange;
    label.appendChild(box);
    const span = document.createElement('span');
    span.innerHTML = `<strong>${def.label}</strong> <em>${def.cost()}</em><br><small>${def.desc}</small>`;
    label.appendChild(span);
    host.appendChild(label);
  });
  host.dataset.built = '1';
  // Sensible default so nobody starts the game with an empty loadout.
  const defaults = ['go_quiet', 'smear', 'silent_run'];
  host.querySelectorAll('input').forEach((b) => { b.checked = defaults.includes(b.value); });
  onLoadoutChange();
}

function selectedLoadout() {
  return Array.from(el('loadout-options').querySelectorAll('input:checked')).map((b) => b.value);
}

function onLoadoutChange() {
  const picked = selectedLoadout();
  if (picked.length > 4) {
    toast('Loadout is 3–4 powers.');
    // Uncheck the most recent over-pick.
    const boxes = Array.from(el('loadout-options').querySelectorAll('input:checked'));
    boxes[boxes.length - 1].checked = false;
    return;
  }
  updateLoadoutCount();
  if (playerId) playerRef().update({ loadout: selectedLoadout() }).catch(() => {});
}

function updateLoadoutCount() {
  const n = selectedLoadout().length;
  el('loadout-count').textContent = n < 3
    ? `${n} of 3–4 chosen — pick ${3 - n} more.`
    : `${n} of 3–4 chosen.`;
}

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

function renderLobbyList(players) {
  const list = el('lobby-players');
  list.innerHTML = '';
  Object.values(players).forEach((p) => {
    const li = document.createElement('li');
    const bits = [p.name];
    if (p.isHost) bits.push('(host)');
    if (p.role) bits.push('— ' + p.role);
    if (p.role === 'hider' && p.loadout && p.loadout.length >= 3) bits.push('✓');
    li.textContent = bits.join(' ');
    list.appendChild(li);
  });
}

// The lobby runs in order: everyone joins, the host assigns roles, and only
// then do hiders choose powers — picking a loadout before you know whether
// you're even a hider is meaningless.
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
  if (p.isHost) initBoundaryMap();

  const title = el('role-title');
  const note = el('role-note');
  const loadout = el('loadout-card');

  if (!p.role) {
    title.textContent = 'Waiting for roles';
    note.innerHTML = 'The host assigns roles once everyone has joined. You pick your powers after that.' +
      '<br><br>Never played? Tap <strong>How to play</strong> above.';
    loadout.style.display = 'none';
  } else if (p.role === 'seeker') {
    title.textContent = "You're a SEEKER";
    note.innerHTML =
      '<strong>Your job:</strong> find every hider before the clock runs out.<br><br>' +
      'You can see roughly where hiders are — a circle that grows the longer they stay put, ' +
      'so campers get easier to find. Hiders cannot see you at all, unless they spend a power.<br><br>' +
      'To catch someone you have to physically reach them and get them to read out their ' +
      '4-letter code. There is no tag button.<br><br>' +
      'Seekers all share the same powers, so there is nothing to choose here.';
    loadout.style.display = 'none';
  } else {
    title.textContent = "You're a HIDER";
    note.innerHTML =
      '<strong>Your job:</strong> stay unfound for as long as you can. You are scored on survival time.<br><br>' +
      'Your phone reports your position now and then. Staying still makes that report vaguer — ' +
      'but the reports pile up in the same spot, so camping forever gets you caught. ' +
      'Moving keeps the circle tight but reports more often.<br><br>' +
      'You cannot see the seekers unless you spend a power on it.<br><br>' +
      'Pick the powers you want to carry. You cannot change them once the game starts.';
    loadout.style.display = 'block';
    renderLoadoutPicker();
  }

  if (p.isHost) renderHostLobbyStatus(players);
}

function renderHostLobbyStatus(players) {
  const all = Object.values(players);
  const assigned = all.filter((x) => x.role).length;
  const seekers = all.filter((x) => x.role === 'seeker').length;
  const hiders = all.filter((x) => x.role === 'hider');

  el('roles-status').textContent = assigned
    ? `${seekers} seeker(s), ${hiders.length} hider(s).`
    : `${all.length} player(s) here. Nobody has a role yet.`;

  const waiting = hiders.filter((h) => !h.loadout || h.loadout.length < 3);
  const unassigned = all.filter((x) => !x.role);
  const blocked = !assigned || unassigned.length > 0 || waiting.length > 0;

  el('btn-start-game').disabled = blocked;
  el('ready-status').textContent = !assigned
    ? 'Assign roles before starting.'
    : unassigned.length
      ? `No role yet: ${unassigned.map((x) => x.name).join(', ')}.`
      : waiting.length
        ? `Waiting on powers: ${waiting.map((h) => h.name).join(', ')}.`
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

function renderBanners(p, now) {
  const strip = el('banner-strip');
  const items = [];

  if (isPaused()) items.push(['warn', 'Game paused by the host.']);
  if (inGrace(p)) items.push(['info', `Powers unlock in ${Math.ceil((p.graceUntil - now) / 1000)}s.`]);
  if (p.lockedOutUntil && now < p.lockedOutUntil) {
    items.push(['warn', `Locked out for ${Math.ceil((p.lockedOutUntil - now) / 1000)}s.`]);
  }
  if (p.beaconedUntil && now < p.beaconedUntil) {
    items.push(['warn', `Beaconed — you are lit up for ${Math.ceil((p.beaconedUntil - now) / 1000)}s.`]);
  }
  if (p.breachStartedAt) {
    const left = Math.ceil((CONFIG.boundary.breachTimerMs - (now - p.breachStartedAt)) / 1000);
    items.push(['danger', `OUT OF BOUNDS — eliminated in ${left}s.`]);
  } else if (boundaryWarningM != null) {
    items.push(['warn', `Approaching the boundary (${Math.round(boundaryWarningM)}m).`]);
  }
  if (p.role === 'hider' && myPos && isInsideActiveCordon(myPos, now)) {
    items.push(['danger', 'Inside a cordon — you are pinging continuously.']);
  }

  const marks = activeMarksOn(p, now);
  marks.forEach((m) => {
    const hunter = playersState[m.seekerId];
    const reading = huntBearing(playerId, m.seekerId, now);
    const dir = reading ? `${Math.round(reading.bearing)}° ±${Math.round(reading.coneHalfWidthDeg)}°` : 'no reading';
    items.push(['danger', `HUNTED by ${hunter ? hunter.name : 'a seeker'} — they are ${dir} from you.`]);
  });
  if (p.activeHunt && now < p.activeHunt.expiresAt) {
    const t = playersState[p.activeHunt.targetId];
    const reading = huntBearing(playerId, p.activeHunt.targetId, now);
    const dir = reading ? `${Math.round(reading.bearing)}° ±${Math.round(reading.coneHalfWidthDeg)}°` : 'no reading';
    const left = Math.ceil((p.activeHunt.expiresAt - now) / 60000);
    items.push(['info', `Hunting ${t ? t.name : '?'} — ${dir}, ${left} min left.`]);
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
    if (def.loadout && p.loadout && !p.loadout.includes(key)) return;
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
  if (!mapTargetCb) return;
  const cb = mapTargetCb;
  cancelMapTargeting();
  cb({ lat: e.latlng.lat, lng: e.latlng.lng });
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
    case 'tripwire':
      toast('Tripwire triggered.');
      reveals.probe = { lat: e.lat, lng: e.lng, radiusM: CONFIG.seekerPowers.tripwire.triggerRadiusM, hit: true, expiresAt: Date.now() + 60000 };
      renderWorld();
      break;
    case 'lockout': toast('A seeker has locked out your powers.'); break;
    case 'beacon': toast('You have been beaconed — your exact position is showing.'); break;
    case 'uncloaked': toast('You have been uncloaked — you are broadcasting again.'); break;
    case 'hunted': toast('You are being hunted.'); break;
    case 'hunt_cleared': toast('Your mark was cleared — they sabotaged a totem.'); break;
    case 'totem_destroyed': toast('A totem has been destroyed.'); break;
    case 'snitch_report':
      toast(`Snitch: ${e.name} located.`);
      reveals.scan = {
        points: [{ lat: e.lat, lng: e.lng, name: e.name, radiusM: e.radiusM }],
        expiresAt: Date.now() + 120000,
      };
      renderWorld();
      break;
    case 'panic':
      showPanicAlert(e);
      break;
    default: break;
  }
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

  // Cordons — everyone; hiders need to see them to get out.
  Object.values(cordonsState).forEach((c) => {
    if (now >= c.expiresAt) return;
    add(L.circle([c.lat, c.lng], {
      radius: c.radiusM, color: MAP.bruise, fillColor: MAP.bruise,
      fillOpacity: 0.12, weight: 2,
    }).bindTooltip('Cordon'));
  });

  // Totems — everyone. Grey while being sabotaged, on both roles' maps.
  Object.entries(totemsState).forEach(([id, t]) => {
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
    }).bindTooltip(totemTooltip(id, t, p, now)));
    // Precision ring: where you have to stand to sabotage.
    if (p.role === 'hider') {
      add(L.circle([t.lat, t.lng], {
        radius: totemPrecisionRadiusM(), color: MAP.totem,
        weight: 1, dashArray: '3 4', fill: false,
      }));
    }
  });

  // Totem pings — seekers only.
  if (p.role === 'seeker') {
    Object.values(totemsState).forEach((t) => {
      (t.recentPings || []).forEach((ping) => {
        const ageMs = now - ping.at;
        if (ageMs > 3 * 60000) return;
        add(L.circle([ping.lat, ping.lng], {
          radius: CONFIG.baseAccuracyRadiusM,
          color: MAP.ember, fillColor: MAP.ember,
          fillOpacity: Math.max(0.08, 0.35 - ageMs / 600000), weight: 1,
        }).bindTooltip('Totem contact'));
      });
    });
  }

  // Signposts — everyone, but only readable within range.
  Object.values(signpostsState).forEach((s) => {
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
    }).bindTooltip(tw.triggered ? 'Tripwire (sprung)' : 'Tripwire'));
  });

  if (p.role === 'seeker') renderForSeeker(p, now, add);
  if (p.role === 'hider') renderForHider(p, now, add);

  renderReveals(p, now, add);

  // Panic markers — exact, to everyone, permanently.
  panicAlerts.forEach((e) => {
    if (e.lat == null) return;
    add(L.circleMarker([e.lat, e.lng], {
      radius: 10, color: MAP.blood, fillColor: MAP.bloodDim, fillOpacity: 1,
    }).bindTooltip(`PANIC: ${e.name}`, { permanent: true }));
  });

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

function totemTooltip(id, t, p, now) {
  const bits = [`Totem (${Math.round(t.radiusM)}m)`];
  if (p.role === 'hider') {
    const present = freshPresenceIds(t, now).length;
    const progress = effectiveSabotageProgressS(t, now);
    const pct = Math.round((progress / t.requiredS) * 100);
    if (present >= CONFIG.totem.sabotageMinParticipants) {
      bits.push(`Sabotage ${pct}%`);
    } else if (present === 1) {
      bits.push('1 hider waiting — join them');
    }
    if (progress > 0 && present < CONFIG.totem.sabotageMinParticipants) {
      bits.push(`decays in ${Math.round(sabotageDecaySecondsLeft(t, now))}s`);
    }
    if (!present) bits.push(`needs ${CONFIG.totem.sabotageMinParticipants} hiders, ${(t.requiredS / 60).toFixed(1)} min`);
  } else if (t.placedBy === playerId) {
    bits.push('yours — tap to retire');
  }
  return bits.join(' · ');
}

function renderForSeeker(p, now, add) {
  Object.entries(playersState).forEach(([id, other]) => {
    if (other.status !== 'active' || id === playerId) return;

    // Seekers always see each other exactly.
    if (other.role === 'seeker' && other.realLat) {
      add(L.marker([other.realLat, other.realLng])
        .bindTooltip(other.name, { permanent: true, direction: 'top' }));
      return;
    }

    if (other.role !== 'hider') return;

    // A beaconed hider is lit up exactly and continuously.
    if (other.beaconedUntil && now < other.beaconedUntil && other.realLat) {
      add(L.circleMarker([other.realLat, other.realLng], {
        radius: 9, color: MAP.amber, fillColor: MAP.amberLit, fillOpacity: 0.9,
      }).bindTooltip(`${other.name} (beaconed)`, { permanent: true, direction: 'top' }));
      return;
    }

    if (!other.broadcastLat) return;

    if (other.broadcastMode === 'arc' && other.broadcastArc) {
      const a = other.broadcastArc;
      add(L.polygon(arcPolygon({ lat: other.broadcastLat, lng: other.broadcastLng },
        a.bearing, a.halfWidthDeg, a.radiusM), {
        color: MAP.blood, fillColor: MAP.bloodDim, fillOpacity: 0.15, weight: 1,
      }).bindTooltip(`${other.name} (smeared)`));
      return;
    }

    const radius = displayRadiusM(other, now);
    add(L.circle([other.broadcastLat, other.broadcastLng], {
      radius, color: MAP.blood, fillColor: MAP.bloodDim, fillOpacity: 0.22, weight: 1,
    }).bindTooltip(`${other.name} · ${Math.round(radius)}m · ${Math.round((now - other.broadcastAt) / 1000)}s ago`));
  });
}

function renderForHider(p, now, add) {
  // Hiders see nothing about other players by default. Read the sweep (and
  // Uncloak's forced broadcast) is the only default-visibility exception.
  if (!revealActive('sweep', now)) return;
  const coverage = CONFIG.hiderPowers.read_the_sweep.seekerCoverageRadiusM;
  Object.entries(playersState).forEach(([id, other]) => {
    if (other.role !== 'seeker' || other.status !== 'active' || !other.realLat) return;
    if (isSeekerDark(other, now)) return;
    add(L.circle([other.realLat, other.realLng], {
      radius: coverage, color: MAP.gloom, fillColor: MAP.gloom,
      fillOpacity: 0.18, weight: 1,
    }));
    add(L.circleMarker([other.realLat, other.realLng], {
      radius: 6, color: MAP.gloom, fillColor: MAP.ashLit, fillOpacity: 1,
    }).bindTooltip(other.name));
  });
}

function renderReveals(p, now, add) {
  if (revealActive('scan', now)) {
    reveals.scan.points.forEach((pt) => {
      if (pt.radiusM) {
        add(L.circle([pt.lat, pt.lng], {
          radius: pt.radiusM, color: MAP.rot, fillColor: MAP.rotLit,
          fillOpacity: 0.25, weight: 2,
        }).bindTooltip(pt.name, { permanent: true, direction: 'top' }));
      } else {
        add(L.circleMarker([pt.lat, pt.lng], {
          radius: 9, color: MAP.rot, fillColor: MAP.rotLit, fillOpacity: 0.9,
        }).bindTooltip(pt.name, { permanent: true, direction: 'top' }));
      }
    });
    if (reveals.scan.origin) {
      add(L.circle([reveals.scan.origin.lat, reveals.scan.origin.lng], {
        radius: reveals.scan.radiusM, color: MAP.rot, fill: false, weight: 1, dashArray: '4 4',
      }));
    }
  }

  if (revealActive('probe', now)) {
    add(L.circle([reveals.probe.lat, reveals.probe.lng], {
      radius: reveals.probe.radiusM,
      color: reveals.probe.hit ? MAP.rot : MAP.ash,
      fillColor: reveals.probe.hit ? MAP.rotLit : MAP.ashLit,
      fillOpacity: 0.2, weight: 2,
    }).bindTooltip(reveals.probe.hit ? 'Hider present' : 'Empty'));
  }

  if (revealActive('backtrace', now) && reveals.backtrace.lat) {
    const b = reveals.backtrace;
    const from = { lat: b.lat, lng: b.lng };
    const to = destinationPoint(from, b.bearing, Math.max(150, 0.1 * M));
    add(L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
      color: MAP.cold, weight: 3, dashArray: '8 5',
    }).bindTooltip(`${b.name} heading ${Math.round(b.bearing)}°`));
  }

  if (revealActive('disarm', now)) {
    reveals.disarm.points.forEach((pt) => {
      add(L.circleMarker([pt.lat, pt.lng], {
        radius: 7, color: MAP.ash, fillColor: MAP.bone, fillOpacity: 0.9,
      }).bindTooltip('Tripwire destroyed'));
    });
  }

  if (revealActive('snitch', now)) {
    reveals.snitch.entries.forEach((e) => {
      if (e.radiusM) {
        add(L.circle([e.lat, e.lng], {
          radius: e.radiusM, color: MAP.violet, fillColor: MAP.violet,
          fillOpacity: 0.2, weight: 2,
        }).bindTooltip(e.name, { permanent: true, direction: 'top' }));
      } else {
        add(L.circleMarker([e.lat, e.lng], {
          radius: 8, color: MAP.violet, fillColor: MAP.violet, fillOpacity: 0.9,
        }).bindTooltip(e.name, { permanent: true, direction: 'top' }));
      }
    });
  }

  // Hunt cone, drawn from whoever holds the reading.
  const marks = activeMarksOn(p, now);
  const cones = [];
  if (p.activeHunt && now < p.activeHunt.expiresAt) cones.push(p.activeHunt.targetId);
  marks.forEach((m) => cones.push(m.seekerId));
  if (p.realLat) {
    cones.forEach((otherId) => {
      const reading = huntBearing(playerId, otherId, now);
      if (!reading) return;
      add(L.polygon(arcPolygon({ lat: p.realLat, lng: p.realLng },
        reading.bearing, reading.coneHalfWidthDeg, Math.max(200, 0.2 * M)), {
        color: MAP.blood, fillColor: MAP.bloodDim, fillOpacity: 0.1,
        weight: 1, dashArray: '5 5',
      }));
    });
  }
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

    <h4>Nobody's position is exact</h4>
    <p>Seekers don't see hiders as dots. They see a <em>circle</em> that the
       hider is somewhere inside. The circle grows the longer someone stays
       still, and snaps tight again when they move — but moving reports you
       more often. That trade is the whole game.</p>

    <h4>Getting caught</h4>
    <p>There is no tag button. A seeker has to physically find you and ask for
       the <strong>4-letter code</strong> shown at the top of your screen. You read
       it out, they type it in, and you switch sides and start seeking.</p>

    <h4>Powers</h4>
    <p>Everything costs <em>charge</em>, shown as ⚡ at the top. It refills slowly
       on its own, and there's a cooldown after each use, so you can't chain them.
       Tap and hold a power to read what it does.</p>

    <h4>Staying safe</h4>
    <p>Stay inside the boundary — step outside and a countdown starts, and you're
       out if it finishes. The <strong>Help</strong> button is not part of the game:
       it tells everyone exactly where you are and ends your round. Use it if
       something goes actually wrong. It is not an emergency service — call one
       of those if you need one.</p>`;

  if (role === 'seeker') {
    return `
      <h4>You're a seeker</h4>
      <p>Find every hider before the clock runs out. You broadcast your own
         position constantly, so hiders who spend a power can see you coming.</p>
      <p>Your circles are your leads: a stack of circles in the same place means
         someone is sitting still there. A drifting line of them means someone is
         on the move.</p>
      <p>If nobody's been caught for a while, you can start a <strong>Hunt</strong> —
         you get a bearing to one hider, refreshed every 30 seconds. They get told,
         and they get a bearing back to you, so it becomes a chase.</p>
      ${common}`;
  }

  if (role === 'hider') {
    return `
      <h4>You're a hider</h4>
      <p>Survive. You're scored on how long you last, so there's no shame in
         being boring — but the game punishes sitting in one spot forever,
         because your reports pile up in the same place.</p>
      <p>You can't see the seekers at all unless you spend a power on it.
         That blankness is deliberate.</p>
      <p>Two things to know that aren't obvious. <strong>Totems</strong> are
         watchtowers seekers can drop; standing inside one gets you reported
         anonymously. Two hiders standing at one together can destroy it.
         And if you're being hunted, you can <strong>Snitch</strong> — sell out
         another hider to get the seeker off you. They're never told it was you.</p>
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

// A rematch link carries ?join=CODE. The name is remembered from last time so
// nobody has to retype it between rounds.
(function autoJoinFromUrl() {
  const code = new URLSearchParams(location.search).get('join');
  if (!code) return;
  currentPlayerName = rememberedName() || 'Player';
  el('input-name-join').value = currentPlayerName;
  joinGame(code, currentPlayerName, false)
    .then((ok) => {
      if (!ok) return;
      el('lobby-code').textContent = gameCode;
      showView('view-lobby');
    })
    .catch(storeConnectionFailed);
})();
