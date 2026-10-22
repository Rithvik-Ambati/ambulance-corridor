// geoUtils.js
// Small, dependency-free geometry helpers used by the corridor logic.

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function decodePolyline(encoded) {
  let points = [];
  let index = 0,
    lat = 0,
    lng = 0;

  while (index < encoded.length) {
    let b,
      shift = 0,
      result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return points;
}

function distancePointToSegmentMeters(p, v, w) {
  const toXY = (pt, origin) => ({
    x: (pt.lng - origin.lng) * 111320 * Math.cos((origin.lat * Math.PI) / 180),
    y: (pt.lat - origin.lat) * 110540,
  });

  const origin = v;
  const P = toXY(p, origin);
  const V = { x: 0, y: 0 };
  const W = toXY(w, origin);

  const l2 = (W.x - V.x) ** 2 + (W.y - V.y) ** 2;
  if (l2 === 0) return haversineMeters(p, v);

  let t = ((P.x - V.x) * (W.x - V.x) + (P.y - V.y) * (W.y - V.y)) / l2;
  t = Math.max(0, Math.min(1, t));

  const proj = { x: V.x + t * (W.x - V.x), y: V.y + t * (W.y - V.y) };
  const dx = P.x - proj.x;
  const dy = P.y - proj.y;

  return Math.sqrt(dx * dx + dy * dy);
}

function minDistancePointToPolyline(point, polyline) {
  if (!polyline || polyline.length === 0) return Infinity;
  if (polyline.length === 1) return haversineMeters(point, polyline[0]);

  let min = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = distancePointToSegmentMeters(point, polyline[i], polyline[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

// Worst-case clearance: the smallest distance from the route to ANY of the
// given points. Used so a route is only "clear" if it stays away from every
// known ambulance, not just the nearest one.
function minDistancePointsToPolyline(points, polyline) {
  if (!points || points.length === 0) return Infinity;
  let min = Infinity;
  for (const p of points) {
    const d = minDistancePointToPolyline(p, polyline);
    if (d < min) min = d;
  }
  return min;
}

// Bearing in degrees from point a to point b.
function bearingDegrees(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Point that is `distanceMeters` away from `start`, in direction `bearingDeg`.
function destinationPoint(start, bearingDeg, distanceMeters) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const lat1 = toRad(start.lat);
  const lng1 = toRad(start.lng);
  const brng = toRad(bearingDeg);
  const d = distanceMeters / R;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

  return { lat: toDeg(lat2), lng: toDeg(lng2) };
}

// Insert points along a polyline so no two consecutive points are more than
// stepMeters apart. Google's overview polylines can have vertices hundreds of
// metres apart on straight roads, which would hide a close pass between them.
function densifyPolyline(polyline, stepMeters) {
  if (!polyline || polyline.length < 2) return polyline ? [...polyline] : [];
  const out = [polyline[0]];
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const n = Math.ceil(haversineMeters(a, b) / stepMeters);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
    }
  }
  return out;
}

// How much of a route runs closer than `thresholdMeters` to any of `points`.
// Returns { meters, runs } where `runs` are the consecutive exposed stretches
// (each an array of sample points, in travel order). This is what tells two
// routes apart when both overlap an ambulance's road: the one with less
// exposure is the better alternate, even if neither ever "clears" it.
function exposureAlongRoute(polyline, points, thresholdMeters, stepMeters = 25) {
  const samples = densifyPolyline(polyline, stepMeters);

  // Grid index: bucket the points into cells about one threshold wide, so each
  // route sample only checks the 3x3 cells around it instead of every point.
  // (Without this a 150 km route against a 150 km ambulance road is minutes of
  // work and freezes the whole server.)
  // A degree of longitude shrinks with latitude, so size the cells in metres, not
  // degrees — otherwise at e.g. London's latitude they'd be narrower than the
  // threshold and 3x3 cells would miss points.
  const cosLat = Math.max(0.01, Math.cos(((samples[0]?.lat ?? 0) * Math.PI) / 180));
  const cellLat = thresholdMeters / 110540;
  const cellLng = thresholdMeters / (111320 * cosLat);
  const cellKey = (lat, lng) => `${Math.floor(lat / cellLat)}:${Math.floor(lng / cellLng)}`;
  const grid = new Map();
  for (const p of points) {
    const k = cellKey(p.lat, p.lng);
    const bucket = grid.get(k);
    if (bucket) bucket.push(p);
    else grid.set(k, [p]);
  }

  const isExposed = (s) => {
    const ci = Math.floor(s.lat / cellLat);
    const cj = Math.floor(s.lng / cellLng);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const bucket = grid.get(`${ci + di}:${cj + dj}`);
        if (!bucket) continue;
        for (const p of bucket) if (haversineMeters(s, p) < thresholdMeters) return true;
      }
    }
    return false;
  };

  let meters = 0;
  const runs = [];
  let run = null;
  for (let i = 0; i < samples.length; i++) {
    if (isExposed(samples[i])) {
      if (i > 0) meters += haversineMeters(samples[i - 1], samples[i]);
      if (!run) runs.push((run = []));
      run.push(samples[i]);
    } else {
      run = null;
    }
  }
  return { meters, runs };
}

// The part of a route still ahead of `position`: from the closest point on the
// route onward. Used so an ambulance's already-travelled road isn't avoided.
function remainingRoute(polyline, position) {
  if (!polyline || polyline.length < 2) return polyline || [];
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = distancePointToSegmentMeters(position, polyline[i], polyline[i + 1]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return [position, ...polyline.slice(bestIdx + 1)];
}

// Total length of a polyline in metres.
function pathLengthMeters(polyline) {
  let total = 0;
  for (let i = 1; i < (polyline?.length || 0); i++) total += haversineMeters(polyline[i - 1], polyline[i]);
  return total;
}

// Two polylines are the same path if they have the same vertex count and endpoints.
function samePath(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return false;
  return (
    a[0].lat === b[0].lat &&
    a[0].lng === b[0].lng &&
    a[a.length - 1].lat === b[b.length - 1].lat &&
    a[a.length - 1].lng === b[b.length - 1].lng
  );
}

module.exports = {
  haversineMeters,
  densifyPolyline,
  remainingRoute,
  samePath,
  pathLengthMeters,
  exposureAlongRoute,
  decodePolyline,
  minDistancePointToPolyline,
  minDistancePointsToPolyline,
  bearingDegrees,
  destinationPoint,
};
