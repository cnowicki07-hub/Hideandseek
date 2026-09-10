// Simulated GPS, enabled with ?sim=<lat>,<lng>.
//
// Replaces the geolocation watch with a position this tab controls, so a
// player can be walked around from the console or from a test driver. Works
// against either backend — including a real Worker, which is how the game
// gets exercised without five people outdoors.

(function () {
  const simParam = new URLSearchParams(location.search).get('sim');
  if (!simParam) return;

  const [lat, lng] = simParam.split(',').map(Number);
  const pos = { lat: lat || 51.5, lng: lng || -0.1 };
  const watchers = [];

  function payload() {
    return {
      coords: { latitude: pos.lat, longitude: pos.lng, accuracy: 5 },
      timestamp: Date.now(),
    };
  }

  function push() { watchers.forEach((cb) => cb(payload())); }

  navigator.geolocation.watchPosition = function (cb) {
    watchers.push(cb);
    setTimeout(push, 0);
    return watchers.length;
  };
  navigator.geolocation.getCurrentPosition = function (cb) { cb(payload()); };

  window.__sim = {
    pos,
    setPos(newLat, newLng) { pos.lat = newLat; pos.lng = newLng; push(); },
    // Move by metres east/north — convenient for driving distance rules.
    moveBy(eastM, northM) {
      pos.lat += northM / 111320;
      pos.lng += eastM / (111320 * Math.cos(pos.lat * Math.PI / 180));
      push();
    },
    push,
  };

  setInterval(push, 1000);
})();
