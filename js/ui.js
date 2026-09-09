// UI rendering and all user interaction.
//
// Visibility rules live here and are deliberately sparse: hiders see nothing
// but themselves and the shared world (boundary, totems, cordons, signposts).
// Powers are what punch temporary holes in that — see `reveals` in powers.js.

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

// ---------- landing ----------

el('btn-host').onclick = async () => {
  currentPlayerName = el('input-name-host').value.trim() || 'Host';
  const sideM = parseFloat(el('input-area-side').value) || 400;
  const lengthMin = parseFloat(el('input-length').value) || 90;
  await hostCreateGame({
    areaM2: sideM * sideM,
    gameLengthMin: lengthMin,
    endConditionMode: el('input-end-mode').value,
  });
  el('lobby-code').textContent = gameCode;
  el('host-controls').style.display = 'block';
  showView('view-lobby');
  renderLoadoutPicker();
  initBoundaryMap();
};

el('btn-join').onclick = async () => {
  currentPlayerName = el('input-name-join').value.trim() || 'Player';
  const code = el('input-code').value.trim();
  if (!code) { alert('Enter a game code.'); return; }
  const ok = await joinGame(code, currentPlayerName, false);
  if (ok) {
    el('lobby-code').textContent = gameCode;
    showView('view-lobby');
    renderLoadoutPicker();
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
    ? L.polygon(latlngs, { color: '#e67e22', weight: 2 })
    : L.polyline(latlngs, { color: '#e67e22', weight: 2 });
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
  const mins = Math.round((g.headstartMs || 0) / 60000);
  el('headstart-info').textContent = g.headstartMs
    ? `Hiders get a ${mins} min head start before seekers are released.`
    : 'No head start (draw a boundary to compute one).';
}

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
  const unassigned = Object.values(playersState).some((p) => !p.role);
  if (unassigned && !confirm('Some players have no role yet. Start anyway?')) return;
  await startGame();
};

function renderLobbyList(players) {
  const list = el('lobby-players');
  list.innerHTML = '';
  Object.values(players).forEach((p) => {
    const li = document.createElement('li');
    const bits = [p.name];
    if (p.isHost) bits.push('(host)');
    if (p.role) bits.push('— ' + p.role);
    li.textContent = bits.join(' ');
    list.appendChild(li);
  });
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
  if (g.status === 'active') {
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

  renderLobbyList(players);
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
  renderBanners(p, now);
  refreshPowerButtons(p, now);
  refreshActionButtons(p, now);
}

// ---------- banners ----------

function renderBanners(p, now) {
  const strip = el('banner-strip');
  const items = [];

  if (isPaused()) items.push(['warn', 'Game paused by the host.']);
  if (inHeadstart()) {
    const left = Math.ceil((gameState.seekersReleaseAt - now) / 1000);
    items.push(['info', playerRole === 'seeker'
      ? `Held at the start line — released in ${left}s.`
      : `Head start — seekers released in ${left}s.`]);
  }
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
      color: '#e67e22', weight: 2, fill: false, dashArray: '6 6',
    }));
  }

  // Cordons — everyone; hiders need to see them to get out.
  Object.values(cordonsState).forEach((c) => {
    if (now >= c.expiresAt) return;
    add(L.circle([c.lat, c.lng], {
      radius: c.radiusM, color: '#8e44ad', fillColor: '#8e44ad',
      fillOpacity: 0.12, weight: 2,
    }).bindTooltip('Cordon'));
  });

  // Totems — everyone. Grey while being sabotaged, on both roles' maps.
  Object.entries(totemsState).forEach(([id, t]) => {
    if (t.status !== 'active') return;
    const sabotaging = isBeingSabotaged(t, now);
    add(L.circle([t.lat, t.lng], {
      radius: t.radiusM,
      color: sabotaging ? '#7f8c8d' : '#16a085',
      fillColor: sabotaging ? '#95a5a6' : '#1abc9c',
      fillOpacity: sabotaging ? 0.08 : 0.15, weight: 2,
    }));
    add(L.circleMarker([t.lat, t.lng], {
      radius: 6, color: sabotaging ? '#7f8c8d' : '#16a085',
      fillColor: sabotaging ? '#bdc3c7' : '#1abc9c', fillOpacity: 1,
    }).bindTooltip(totemTooltip(id, t, p, now)));
    // Precision ring: where you have to stand to sabotage.
    if (p.role === 'hider') {
      add(L.circle([t.lat, t.lng], {
        radius: totemPrecisionRadiusM(), color: '#16a085',
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
          color: '#d35400', fillColor: '#e67e22',
          fillOpacity: Math.max(0.08, 0.35 - ageMs / 600000), weight: 1,
        }).bindTooltip('Totem contact'));
      });
    });
  }

  // Signposts — everyone, but only readable within range.
  Object.values(signpostsState).forEach((s) => {
    add(L.circleMarker([s.lat, s.lng], {
      radius: 4, color: '#795548', fillColor: '#a1887f', fillOpacity: 1,
    }));
  });

  // Own tripwires — the placing seeker only. Hidden from everyone else.
  Object.values(tripwiresState).forEach((tw) => {
    if (tw.placedBy !== playerId) return;
    add(L.circle([tw.lat, tw.lng], {
      radius: CONFIG.seekerPowers.tripwire.triggerRadiusM,
      color: tw.triggered ? '#7f8c8d' : '#2c3e50',
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
      radius: 10, color: '#c0392b', fillColor: '#e74c3c', fillOpacity: 1,
    }).bindTooltip(`PANIC: ${e.name}`, { permanent: true }));
  });

  // Self — always exact, always visible.
  if (p.realLat) {
    if (!selfMarker) {
      selfMarker = L.circleMarker([p.realLat, p.realLng], {
        radius: 8, color: '#2980b9', fillColor: '#3498db', fillOpacity: 1,
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
        radius: 9, color: '#f39c12', fillColor: '#f1c40f', fillOpacity: 0.9,
      }).bindTooltip(`${other.name} (beaconed)`, { permanent: true, direction: 'top' }));
      return;
    }

    if (!other.broadcastLat) return;

    if (other.broadcastMode === 'arc' && other.broadcastArc) {
      const a = other.broadcastArc;
      add(L.polygon(arcPolygon({ lat: other.broadcastLat, lng: other.broadcastLng },
        a.bearing, a.halfWidthDeg, a.radiusM), {
        color: '#c0392b', fillColor: '#e74c3c', fillOpacity: 0.15, weight: 1,
      }).bindTooltip(`${other.name} (smeared)`));
      return;
    }

    const radius = displayRadiusM(other, now);
    add(L.circle([other.broadcastLat, other.broadcastLng], {
      radius, color: '#c0392b', fillColor: '#e74c3c', fillOpacity: 0.22, weight: 1,
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
      radius: coverage, color: '#2c3e50', fillColor: '#34495e',
      fillOpacity: 0.18, weight: 1,
    }));
    add(L.circleMarker([other.realLat, other.realLng], {
      radius: 6, color: '#2c3e50', fillColor: '#7f8c8d', fillOpacity: 1,
    }).bindTooltip(other.name));
  });
}

function renderReveals(p, now, add) {
  if (revealActive('scan', now)) {
    reveals.scan.points.forEach((pt) => {
      if (pt.radiusM) {
        add(L.circle([pt.lat, pt.lng], {
          radius: pt.radiusM, color: '#27ae60', fillColor: '#2ecc71',
          fillOpacity: 0.25, weight: 2,
        }).bindTooltip(pt.name, { permanent: true, direction: 'top' }));
      } else {
        add(L.circleMarker([pt.lat, pt.lng], {
          radius: 9, color: '#27ae60', fillColor: '#2ecc71', fillOpacity: 0.9,
        }).bindTooltip(pt.name, { permanent: true, direction: 'top' }));
      }
    });
    if (reveals.scan.origin) {
      add(L.circle([reveals.scan.origin.lat, reveals.scan.origin.lng], {
        radius: reveals.scan.radiusM, color: '#27ae60', fill: false, weight: 1, dashArray: '4 4',
      }));
    }
  }

  if (revealActive('probe', now)) {
    add(L.circle([reveals.probe.lat, reveals.probe.lng], {
      radius: reveals.probe.radiusM,
      color: reveals.probe.hit ? '#27ae60' : '#7f8c8d',
      fillColor: reveals.probe.hit ? '#2ecc71' : '#bdc3c7',
      fillOpacity: 0.2, weight: 2,
    }).bindTooltip(reveals.probe.hit ? 'Hider present' : 'Empty'));
  }

  if (revealActive('backtrace', now) && reveals.backtrace.lat) {
    const b = reveals.backtrace;
    const from = { lat: b.lat, lng: b.lng };
    const to = destinationPoint(from, b.bearing, Math.max(150, 0.1 * M));
    add(L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
      color: '#2980b9', weight: 3, dashArray: '8 5',
    }).bindTooltip(`${b.name} heading ${Math.round(b.bearing)}°`));
  }

  if (revealActive('disarm', now)) {
    reveals.disarm.points.forEach((pt) => {
      add(L.circleMarker([pt.lat, pt.lng], {
        radius: 7, color: '#7f8c8d', fillColor: '#ecf0f1', fillOpacity: 0.9,
      }).bindTooltip('Tripwire destroyed'));
    });
  }

  if (revealActive('snitch', now)) {
    reveals.snitch.entries.forEach((e) => {
      if (e.radiusM) {
        add(L.circle([e.lat, e.lng], {
          radius: e.radiusM, color: '#9b59b6', fillColor: '#8e44ad',
          fillOpacity: 0.2, weight: 2,
        }).bindTooltip(e.name, { permanent: true, direction: 'top' }));
      } else {
        add(L.circleMarker([e.lat, e.lng], {
          radius: 8, color: '#9b59b6', fillColor: '#8e44ad', fillOpacity: 0.9,
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
        color: '#c0392b', fillColor: '#e74c3c', fillOpacity: 0.1,
        weight: 1, dashArray: '5 5',
      }));
    });
  }
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
