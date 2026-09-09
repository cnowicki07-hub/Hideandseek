// Geo utilities. All distances in metres, all angles in degrees unless noted.

const EARTH_R = 6371000;

function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

// Haversine distance in metres between two {lat, lng} points.
function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

// Bearing in degrees (0-360, 0 = north) from a to b.
function bearingDeg(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Destination point given start, bearing (deg), distance (m).
function destinationPoint(start, bearing, dist) {
  const brng = toRad(bearing);
  const lat1 = toRad(start.lat);
  const lng1 = toRad(start.lng);
  const dR = dist / EARTH_R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(brng));
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(dR) * Math.cos(lat1),
    Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: toDeg(lat2), lng: (toDeg(lng2) + 540) % 360 - 180 };
}

// Interpolate the error cone half-width (deg) for the Hunt bearing,
// based on distance: wide far away, narrow up close.
function huntConeHalfWidthDeg(distM) {
  const { coneDegAt500m, coneDegAt100m } = CONFIG.hunt;
  if (distM >= 500) return coneDegAt500m / 2;
  if (distM <= 100) return coneDegAt100m / 2;
  const t = (distM - 100) / (500 - 100);
  return (coneDegAt100m + t * (coneDegAt500m - coneDegAt100m)) / 2;
}

// Random point-in-circle, used for totem anonymous pings and hider
// uncertainty display when we want a random point rather than a
// drawn circle (Leaflet draws the circle directly from radius, so
// this is mainly for totem pings which report a specific point).
function randomPointInRadius(center, radiusM) {
  const r = radiusM * Math.sqrt(Math.random());
  const theta = Math.random() * 2 * Math.PI;
  const bearing = toDeg(theta);
  return destinationPoint(center, bearing, r);
}
