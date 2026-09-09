// UI rendering. Views: #view-landing, #view-lobby, #view-game, #view-end.

let currentPlayerName = '';
let hiderMarkers = {}; // playerId -> {marker, circle}
let seekerMarkers = {};

function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function initMap() {
  map = L.map('map', { zoomControl: false });
  map.setView([51.5, -0.1], 15); // recentres on first real GPS fix
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
}

let recentered = false;
function recenterOnSelf(lat, lng) {
  if (!recentered) { map.setView([lat, lng], 17); recentered = true; }
}

// ---------- Landing / Lobby ----------

document.getElementById('btn-host').onclick = async () => {
  currentPlayerName = document.getElementById('input-name-host').value.trim() || 'Host';
  const sideM = parseFloat(document.getElementById('input-area-side').value) || 400;
  const lengthMin = parseFloat(document.getElementById('input-length').value) || 90;
  await hostCreateGame(sideM * sideM, lengthMin);
  document.getElementById('lobby-code').textContent = gameCode;
  document.getElementById('host-controls').style.display = 'block';
  showView('view-lobby');
};

document.getElementById('btn-join').onclick = async () => {
  currentPlayerName = document.getElementById('input-name-join').value.trim() || 'Player';
  const code = document.getElementById('input-code').value.trim();
  const ok = await joinGame(code, currentPlayerName, false);
  if (ok) {
    document.getElementById('lobby-code').textContent = gameCode;
    showView('view-lobby');
  }
};

document.getElementById('btn-assign-roles').onclick = async () => {
  const numSeekers = parseInt(document.getElementById('input-num-seekers').value, 10) || 1;
  await assignRolesRandom(numSeekers);
};

document.getElementById('btn-start-game').onclick = async () => {
  await startGame();
};

// ---------- Lobby player list ----------

function renderLobbyList(players) {
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  Object.values(players).forEach((p) => {
    const li = document.createElement('li');
    li.textContent = `${p.name}${p.role ? ' — ' + p.role : ''}`;
    list.appendChild(li);
  });
}

// ---------- Game view ----------

function renderGameStatus(g) {
  if (g.status === 'active') {
    if (!document.getElementById('view-game').classList.contains('active')) {
      showView('view-game');
    }
    if (!map) initMap();
    updateTimer(g.startedAt, g.gameLengthMin);
  }
  if (g.status === 'ended') {
    showView('view-end');
  }
}

let timerInterval = null;
function updateTimer(startedAt, lengthMin) {
  if (timerInterval) return;
  const endsAt = startedAt + lengthMin * 60000;
  timerInterval = setInterval(() => {
    const remainingMs = Math.max(0, endsAt - Date.now());
    const mins = Math.floor(remainingMs / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    document.getElementById('timer').textContent =
      `${mins}:${secs.toString().padStart(2, '0')}`;
    if (remainingMs <= 0) clearInterval(timerInterval);
  }, 1000);
}

function renderPlayers(players) {
  const me = players[playerId];
  if (!me) return;
  if (me.role && me.role !== playerRole) {
    playerRole = me.role;
    if (document.getElementById('view-game').classList.contains('active')) {
      // role changed mid-game (conversion) — nothing extra needed, rendering below adapts
    }
  }
  if (!playerRole && me.role) playerRole = me.role;

  renderLobbyList(players);
  updateChargeDisplay(me);
  updateMyCode(me);

  if (!document.getElementById('view-game').classList.contains('active')) return;
  if (!map) return;

  if (me.realLat && me.realLng) recenterOnSelf(me.realLat, me.realLng);

  // Clear stale markers each pass — simplest correct approach at this player count.
  Object.values(hiderMarkers).forEach((m) => map.removeLayer(m.circle));
  Object.values(seekerMarkers).forEach((m) => map.removeLayer(m.marker));
  hiderMarkers = {}; seekerMarkers = {};

  Object.entries(players).forEach(([id, p]) => {
    if (p.status !== 'active') return;

    if (p.role === 'seeker') {
      // Seekers see all seekers (teammates, always exact).
      if (playerRole === 'seeker' && p.realLat) {
        const marker = L.marker([p.realLat, p.realLng])
          .addTo(map).bindTooltip(p.name, { permanent: true, direction: 'top' });
        seekerMarkers[id] = { marker };
      }
    }

    if (p.role === 'hider') {
      // Seekers see hider broadcast circles (fuzzy per uncertainty). Hiders see nothing by default.
      if (playerRole === 'seeker' && p.broadcastLat) {
        const circle = L.circle([p.broadcastLat, p.broadcastLng], {
          radius: p.broadcastRadiusM || CONFIG.baseAccuracyRadiusM,
          color: '#c0392b', fillColor: '#e74c3c', fillOpacity: 0.25,
        }).addTo(map);
        hiderMarkers[id] = { circle };
      }
    }
  });

  // Everyone always sees their own true position.
  if (me.realLat) {
    if (!window._selfMarker) {
      window._selfMarker = L.circleMarker([me.realLat, me.realLng], {
        radius: 8, color: '#2980b9', fillColor: '#3498db', fillOpacity: 1,
      }).addTo(map);
    } else {
      window._selfMarker.setLatLng([me.realLat, me.realLng]);
    }
  }
}

function updateChargeDisplay(me) {
  const el = document.getElementById('charge-value');
  if (el) el.textContent = Math.floor(currentCharge(me));
}

function updateMyCode(me) {
  const el = document.getElementById('my-code');
  if (el && me.captureCode) el.textContent = me.captureCode;
}

// ---------- Capture modal ----------

document.getElementById('btn-open-capture').onclick = () => {
  document.getElementById('capture-modal').style.display = 'flex';
};
document.getElementById('btn-cancel-capture').onclick = () => {
  document.getElementById('capture-modal').style.display = 'none';
};
document.getElementById('btn-confirm-capture').onclick = async () => {
  const code = document.getElementById('input-capture-code').value;
  const result = await attemptCaptureByCode(code);
  document.getElementById('capture-modal').style.display = 'none';
  if (result.ok) {
    alert(`Captured ${result.name}! They're now a seeker.`);
  } else {
    alert('No matching hider with that code.');
  }
};

showView('view-landing');
