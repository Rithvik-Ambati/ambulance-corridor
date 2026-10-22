// publicView.js
// What other clients are allowed to see of a device. The raw device record
// holds things no other phone should receive (driving-licence number, holder
// name and date of birth, client id) and very large things they don't need
// (every route candidate's full polyline). Everything that leaves the server
// through a broadcast goes through here.
//
// Route geometry is NOT sent in the periodic update. An ambulance's update
// carries a short `routeKey` fingerprint instead; a client that doesn't have
// that geometry cached asks for it once ('get-route' -> 'route-geometry').
// Without this, every GPS tick from every phone re-sent every route — on
// mobile data that is tens of KB per second per phone.

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Short fingerprint that changes whenever the route's shape changes.
function routeKeyOf(route) {
  const p = route?.polyline;
  if (!p?.length) return null;
  const mid = p[p.length >> 1];
  const last = p[p.length - 1];
  return hashString(`${p.length}|${p[0].lat},${p[0].lng}|${mid.lat},${mid.lng}|${last.lat},${last.lng}`);
}

// What any client may see of any device (including other people's).
function publicDevice(d) {
  return {
    role: d.role,
    label: d.label,
    priority: d.priority,
    lat: d.lat,
    lng: d.lng,
    lastUpdate: d.lastUpdate,
    speedMps: d.speedMps,
    origin: d.origin,
    destination: d.destination,
    // Only ambulances' routes are drawn for everyone else; a vehicle's own
    // route reaches its own phone through 'route-update' / 'reroute'.
    routeKey: d.role === 'ambulance' ? routeKeyOf(d.currentRoute) : null,
  };
}

function publicDevices(devices) {
  const out = {};
  for (const [id, d] of Object.entries(devices)) out[id] = publicDevice(d);
  return out;
}

function broadcast(io, devices) {
  io.emit('devices-update', publicDevices(devices));
}

// Operator/debug view (GET /devices, behind the admin token): full routes so a
// test can inspect them, but never the licence details or client id.
function adminDevices(devices) {
  const out = {};
  for (const [id, d] of Object.entries(devices)) {
    const { dl, clientId, routeRequestId, _lastIndiaWarnAt, ...rest } = d; // eslint-disable-line no-unused-vars
    out[id] = { ...rest, dl: dl ? { verification: dl.verification?.status || null } : null };
  }
  return out;
}

module.exports = { publicDevice, publicDevices, adminDevices, broadcast, routeKeyOf };
