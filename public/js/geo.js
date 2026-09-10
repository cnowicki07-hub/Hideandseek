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

// ---------- polygon helpers (boundary) ----------

// Project lat/lng to local metres about an origin. Fine for play areas of a
// few km — avoids pulling in a projection library.
function toLocalM(origin, p) {
  return {
    x: (p.lng - origin.lng) * 111320 * Math.cos(toRad(origin.lat)),
    y: (p.lat - origin.lat) * 111320,
  };
}

function polygonAreaM2(points) {
  if (!points || points.length < 3) return 0;
  const o = points[0];
  const pts = points.map((p) => toLocalM(o, p));
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

function pointInPolygon(point, points) {
  if (!points || points.length < 3) return true;
  const o = points[0];
  const pts = points.map((p) => toLocalM(o, p));
  const q = toLocalM(o, point);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const intersects = (pts[i].y > q.y) !== (pts[j].y > q.y) &&
      q.x < ((pts[j].x - pts[i].x) * (q.y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distancePointToSegmentM(q, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(q.x - a.x, q.y - a.y);
  let t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
}

// Shortest distance from a point to the polygon outline, in metres.
function distanceToPolygonEdgeM(point, points) {
  if (!points || points.length < 3) return Infinity;
  const o = points[0];
  const pts = points.map((p) => toLocalM(o, p));
  const q = toLocalM(o, point);
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    best = Math.min(best, distancePointToSegmentM(q, pts[i], pts[(i + 1) % pts.length]));
  }
  return best;
}

function polygonLongestDiagonalM(points) {
  let best = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      best = Math.max(best, distanceM(points[i], points[j]));
    }
  }
  return best;
}

function polygonCentroid(points) {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

// A square boundary of a given side around a centre — used by living-room
// mode, where the host has no real ground to draw over.
function squareBoundaryAround(centre, sideM) {
  const h = sideM / 2;
  return [
    destinationPoint(destinationPoint(centre, 0, h), 270, h),
    destinationPoint(destinationPoint(centre, 0, h), 90, h),
    destinationPoint(destinationPoint(centre, 180, h), 90, h),
    destinationPoint(destinationPoint(centre, 180, h), 270, h),
  ];
}

// Vertices of a pie wedge — the Probe's sweep and the Hunt's error cone.
function arcPolygon(center, bearing, halfWidthDeg, radiusM, steps) {
  const pts = [[center.lat, center.lng]];
  const n = steps || 16;
  for (let i = 0; i <= n; i++) {
    const b = bearing - halfWidthDeg + (2 * halfWidthDeg * i) / n;
    const p = destinationPoint(center, b, radiusM);
    pts.push([p.lat, p.lng]);
  }
  return pts;
}

// Uniform random point inside a circle. Every inaccurate reading in the
// game is built on this: the 30m error on a ping, the snitch's range bands,
// and a totem's anonymous report.
function randomPointInRadius(center, radiusM) {
  const r = radiusM * Math.sqrt(Math.random());
  const theta = Math.random() * 2 * Math.PI;
  const bearing = toDeg(theta);
  return destinationPoint(center, bearing, r);
}
