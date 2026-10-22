// corridorLogic.js
// Watches for a vehicle's (or a lower-priority ambulance's) route sharing a
// road with an ambulance and requests a reroute that stays off it.
//
// Priority (see priority.js) controls who avoids whom:
//   - A vehicle avoids P1 and P2 ambulances' roads, never P3's (P3 is
//     "routine" — it must not force civilian rerouting, so it's simply never
//     an obstacle to a vehicle).
//   - An ambulance only ever avoids a STRICTLY higher-priority ambulance's
//     road: P1 avoids nobody (always gets the shortest route), P2 avoids P1,
//     P3 avoids P1 and P2. This is the "high priority gets the shortest
//     possible, the other a bit longer" rule.
// P1 conflicts are rerouted on a near-instant cooldown ("absolute priority in
// the MAS queue"); P2 uses the normal cooldown. P3 never triggers a reroute —
// only a passive 'ambulance-alert' broadcast.
//
// Separately, checkViolations watches for a vehicle that stays on a P1/P2
// ambulance's immediate path after being given time to clear it, and hands
// off to violationService to flag + "fine" it.

const {
  minDistancePointToPolyline,
  haversineMeters,
  densifyPolyline,
  remainingRoute,
  samePath,
  destinationPoint,
} = require('./geoUtils');
const { getRoute, routeOverlapMeters, CLEAN_OVERLAP_METERS } = require('./routingService');
const { normalizePriority, infoFor } = require('./priority');
const { AMBULANCE_SPEED_MPS } = require('./speedModel');
const historyStore = require('./historyStore');
const violationService = require('./violationService');
const publicView = require('./publicView');

const BASE_DISC_RADIUS_METERS = 90; // repel radius around an ambulance that has no route yet
const MAX_DISC_RADIUS_METERS = 400;
const REACTION_SECONDS = 6; // disc radius grows by ambulance speed * this ("how far it travels before a vehicle can react")
const REROUTE_COOLDOWN_MS = Number(process.env.REROUTE_COOLDOWN_MS) || 15000; // env override lets tests shorten it
const PATH_SAMPLE_METERS = 20; // spacing of the points sampled along an ambulance's route
const NO_BETTER_ROUTE_BACKOFF_MS = Number(process.env.NO_BETTER_ROUTE_BACKOFF_MS) || 45000; // extra wait after an attempt that changed nothing
const ADVISORY_COOLDOWN_MS = Number(process.env.ADVISORY_COOLDOWN_MS) || 20000; // P3 alert repeat rate
const YIELD_ON_PATH_METERS = 60; // how close a vehicle must sit to an ambulance's own path to count as "blocking" it

const lastRerouteAt = {};
const lastAdvisedAt = {};

function canReroute(id, devices) {
  const last = lastRerouteAt[id] || 0;
  // Simplification: if ANY P1 ambulance is active anywhere in the system, the
  // whole corridor check runs on P1's fast cooldown rather than tracking which
  // specific ambulance is responsible for each vehicle's conflict — a real MAS
  // would tag the conflict with its priority, but this system doesn't track
  // "which ambulance caused this recheck" that granularly.
  const cooldown = hasActiveAmbulanceOfPriority(devices, 1) ? infoFor(1).rerouteCooldownMs : REROUTE_COOLDOWN_MS;
  return Date.now() - last >= cooldown;
}

function hasActiveAmbulanceOfPriority(devices, priority) {
  return Object.values(devices).some((d) => d.role === 'ambulance' && normalizePriority(d.priority) === priority);
}

// `extraCooldownMs` pushes the next allowed reroute further out — used when a
// reroute attempt found nothing better, so we don't spend 15 Google calls
// every 15 seconds re-discovering the same answer.
function markRerouted(id, extraCooldownMs = 0) {
  lastRerouteAt[id] = Date.now() + extraCooldownMs;
}

function canAdvise(id) {
  return Date.now() - (lastAdvisedAt[id] || 0) >= ADVISORY_COOLDOWN_MS;
}
function markAdvised(id) {
  lastAdvisedAt[id] = Date.now();
}

// Called on disconnect so these tables don't grow forever over a long session.
function forget(id) {
  delete lastRerouteAt[id];
  delete lastAdvisedAt[id];
  violationService.forget(id);
}

// Where a device's route should start from: its manual Start point if one was
// set (so a laptop test isn't routed from wherever the laptop physically is),
// otherwise live GPS. Null if it has neither.
function routeStartFor(device) {
  if (device.originIsManual && device.origin) return device.origin;
  if (device.lat != null && device.lng != null) return { lat: device.lat, lng: device.lng };
  return device.origin || null;
}

// Everything a device's route should stay off: every ambulance with priority
// <= maxPriority (numerically — i.e. AT LEAST as urgent as maxPriority),
// using its live position and the road it still has ahead of it (densified so
// a close pass between two route vertices isn't missed). An ambulance with no
// route yet is treated as a disc around its position that grows with its
// speed (falling back to the standard ambulance speed assumption if it hasn't
// reported real GPS speed yet), so it still repels routes even before it sets
// a destination. `excludeId` skips a device's own entry.
//
// maxPriority = 2 (the default) is "avoid every emergency ambulance, not
// routine ones" — what a plain vehicle uses. An ambulance instead passes
// maxPriority = (its own priority - 1), so it only avoids strictly
// higher-priority ambulances; maxPriority = 0 short-circuits to "avoid
// nothing" (a P1 ambulance).
function getAvoidPoints(devices, excludeId = null, { maxPriority = 2 } = {}) {
  if (maxPriority < 1) return [];
  const points = [];
  for (const [id, d] of Object.entries(devices)) {
    if (id === excludeId || d.role !== 'ambulance') continue;
    if (normalizePriority(d.priority) > maxPriority) continue;
    // Live GPS if it has any, otherwise where its route starts (an ambulance
    // that has set a route but hasn't sent a position yet still counts).
    const position = d.lat != null && d.lng != null ? { lat: d.lat, lng: d.lng } : d.origin;
    if (!position) continue;
    points.push(position);

    if (d.currentRoute?.polyline?.length > 1) {
      points.push(...densifyPolyline(remainingRoute(d.currentRoute.polyline, position), PATH_SAMPLE_METERS));
    } else {
      const speed = typeof d.speedMps === 'number' ? d.speedMps : AMBULANCE_SPEED_MPS;
      const radius = Math.min(MAX_DISC_RADIUS_METERS, BASE_DISC_RADIUS_METERS + speed * REACTION_SECONDS);
      for (const frac of [1 / 3, 2 / 3, 1]) {
        for (let bearing = 0; bearing < 360; bearing += 45) {
          points.push(destinationPoint(position, bearing, radius * frac));
        }
      }
    }
  }
  return points;
}

// Shared by the vehicle loop and the ambulance-priority loop: if `dev`'s
// current route shares more than CLEAN_OVERLAP_METERS of road with anything
// in avoidPoints, request a better route and push it out. Returns true if a
// reroute (or a "nothing better exists" backoff) happened.
async function rerouteIfExposed(id, dev, devices, io, { maxPriority, reason, historyExtra = {} }) {
  if (!canReroute(id, devices)) return false;

  const avoidPoints = getAvoidPoints(devices, id, { maxPriority });
  if (avoidPoints.length === 0) return false;

  const currentPath = dev.currentRoute.polyline;
  const start = routeStartFor(dev);
  // Same start/end coordinates getRoute is given, so trigger and chooser exempt the same stretch.
  const overlapBefore = routeOverlapMeters(currentPath, avoidPoints, start, dev.destination);
  if (overlapBefore <= CLEAN_OVERLAP_METERS) return false;

  markRerouted(id);

  const destination = dev.destination;
  const requestId = dev.routeRequestId;
  try {
    const newRoute = await getRoute({
      vehicleId: id,
      origin: start,
      destination,
      avoidPoints,
      force: true,
      incumbent: dev.currentRoute,
    });

    // The device changed destination (or cleared its trip, or left) while this
    // was being computed — this route is for a trip that no longer exists.
    if (devices[id] !== dev || dev.routeRequestId !== requestId || dev.destination !== destination) return false;

    if (newRoute && (newRoute.keptIncumbent || samePath(newRoute.polyline, currentPath))) {
      // Nothing better exists — don't fire a "reroute" alert for a route that
      // hasn't changed, and don't spend another round of Google calls on it soon.
      markRerouted(id, NO_BETTER_ROUTE_BACKOFF_MS);
      console.log(`[corridor] no better route for ${id} — best available still shares ${Math.round(overlapBefore)}m of road`);
      return true;
    }
    if (!newRoute) return false;

    devices[id].currentRoute = newRoute;
    io.to(id).emit('reroute', { reason, route: newRoute });
    publicView.broadcast(io, devices);
    io.emit('corridor-event', { vehicleId: id, overlapBefore, reason, timestamp: Date.now() });

    historyStore.record({
      vehicleId: id,
      vehicleLabel: dev.label,
      sharedRoadBeforeMeters: Math.round(overlapBefore),
      sharedRoadAfterMeters: typeof newRoute.exposureMeters === 'number' ? Math.round(newRoute.exposureMeters) : null,
      usedDetour: !!newRoute.usedDetour,
      reason,
      ...historyExtra,
    });

    console.log(
      `[corridor] rerouted ${id} (${reason}) — shared road ${Math.round(overlapBefore)}m -> ${Math.round(newRoute.exposureMeters ?? 0)}m, ${newRoute.distanceMeters}m long`
    );
    return true;
  } catch (err) {
    console.error(`[corridor] reroute failed for ${id}:`, err.message);
    return false;
  }
}

// Vehicles avoiding P1/P2 ambulances.
async function checkVehicles(devices, io) {
  const vehicles = Object.entries(devices).filter(
    ([, d]) => d.role === 'vehicle' && d.currentRoute && d.destination && routeStartFor(d)
  );
  for (const [id, vehicle] of vehicles) {
    await rerouteIfExposed(id, vehicle, devices, io, { maxPriority: 2, reason: 'ambulance-corridor' });
  }
}

// Ambulances avoiding a STRICTLY higher-priority ambulance's road (P1 is
// exempt — nothing outranks it).
async function checkAmbulancePriorityConflicts(devices, io) {
  const ambulances = Object.entries(devices).filter(
    ([, d]) => d.role === 'ambulance' && d.currentRoute && d.destination && routeStartFor(d)
  );
  for (const [id, amb] of ambulances) {
    const myPriority = normalizePriority(amb.priority);
    if (myPriority <= 1) continue; // P1: nothing outranks it
    await rerouteIfExposed(id, amb, devices, io, {
      maxPriority: myPriority - 1,
      reason: 'higher-priority-ambulance',
      historyExtra: { ambulancePriority: myPriority },
    });
  }
}

// P3 ("routine") ambulances never force a reroute — just a passive,
// rate-limited broadcast when one is sharing a vehicle's road.
function checkP3Advisories(devices, io) {
  const p3s = Object.entries(devices).filter(
    ([, d]) => d.role === 'ambulance' && normalizePriority(d.priority) === 3 && (d.currentRoute || d.lat != null)
  );
  if (p3s.length === 0) return;

  const vehicles = Object.entries(devices).filter(([, d]) => d.role === 'vehicle' && d.currentRoute && d.destination);
  if (vehicles.length === 0) return;

  for (const [ambId, amb] of p3s) {
    if (!canAdvise(ambId)) continue;
    const position = amb.lat != null && amb.lng != null ? { lat: amb.lat, lng: amb.lng } : amb.origin;
    if (!position) continue;
    const ahead = amb.currentRoute?.polyline?.length > 1 ? densifyPolyline(remainingRoute(amb.currentRoute.polyline, position), PATH_SAMPLE_METERS) : [position];

    const affected = vehicles.filter(([, veh]) => {
      const overlap = routeOverlapMeters(veh.currentRoute.polyline, ahead, routeStartFor(veh), veh.destination);
      return overlap > CLEAN_OVERLAP_METERS;
    });
    if (affected.length === 0) continue;

    markAdvised(ambId);
    io.emit('ambulance-alert', {
      ambulanceId: ambId,
      label: amb.label,
      priority: 3,
      message: `${amb.label} (Priority 3 — routine) is on a shared road. Please clear the lane if convenient — this is an advisory only, no civilian rerouting is being forced.`,
      timestamp: Date.now(),
    });
    console.log(`[corridor] P3 advisory broadcast for ${amb.label} (${affected.length} vehicle(s) sharing its road)`);
  }
}

// A vehicle that stays within YIELD_ON_PATH_METERS of a P1/P2 ambulance's own
// immediate path, within violationService.YIELD_ZONE_METERS of the ambulance's
// live position, for longer than violationService.YIELD_GRACE_SECONDS, is
// treated as having failed to give way.
function checkViolations(devices, io) {
  const eligibleAmbulances = Object.entries(devices)
    .filter(([, d]) => d.role === 'ambulance' && infoFor(normalizePriority(d.priority)).violationEligible && d.lat != null && d.lng != null)
    .map(([id, d]) => [id, d]);
  if (eligibleAmbulances.length === 0) return;

  const vehicles = Object.entries(devices).filter(([, d]) => d.role === 'vehicle' && d.lat != null && d.lng != null);

  for (const [vehId, veh] of vehicles) {
    const vehPos = { lat: veh.lat, lng: veh.lng };
    let blocking = null;

    for (const [ambId, amb] of eligibleAmbulances) {
      const ambPos = { lat: amb.lat, lng: amb.lng };
      if (haversineMeters(ambPos, vehPos) > violationService.YIELD_ZONE_METERS) continue;

      const ahead = amb.currentRoute?.polyline?.length > 1 ? remainingRoute(amb.currentRoute.polyline, ambPos) : [ambPos];
      if (minDistancePointToPolyline(vehPos, ahead) <= YIELD_ON_PATH_METERS) {
        blocking = { id: ambId, label: amb.label, priority: normalizePriority(amb.priority) };
        break;
      }
    }

    if (!blocking) {
      violationService.clearConflict(vehId);
      continue;
    }

    const violation = violationService.noteConflict(vehId, veh, blocking);
    if (violation) {
      violationService.flagAndNotify(violation).then((v) => {
        io.to(vehId).emit('violation', v);
        io.emit('violation-logged', {
          id: v.id,
          vehicleLabel: v.vehicleLabel,
          ambulanceLabel: v.ambulanceLabel,
          fineInr: v.fineInr,
          timestamp: v.timestamp,
        });
        console.log(
          `[violation] ${v.vehicleLabel} did not give way to ${v.ambulanceLabel} — fine ${v.fineInr != null ? '₹' + v.fineInr : 'N/A (DL not verified)'}, ${v.sentToCops}`
        );
      });
    }
  }
}

/**
 * Called whenever any device's position updates (and when an ambulance or
 * higher-priority-avoiding ambulance sets a route). Runs, in order: vehicle
 * corridor checks, ambulance-vs-ambulance priority checks, P3 advisories, and
 * failed-to-give-way violation detection.
 */
async function checkAllCorridors(devices, io) {
  if (!Object.values(devices).some((d) => d.role === 'ambulance')) return;

  await checkVehicles(devices, io);
  await checkAmbulancePriorityConflicts(devices, io);
  checkP3Advisories(devices, io);
  checkViolations(devices, io);
}

module.exports = {
  checkAllCorridors,
  getAvoidPoints,
  routeStartFor,
  markRerouted,
  forget,
};
