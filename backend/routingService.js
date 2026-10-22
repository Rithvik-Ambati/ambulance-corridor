// routingService.js
// Wraps Google Maps Directions API.
//
// The rule for a vehicle's route (avoidPoints = ambulance positions + the road
// they still have ahead):
//   1. The ambulance keeps Google's shortest route, untouched.
//   2. The vehicle must not share the ambulance's road. Among candidate routes,
//      any whose overlap with that road is negligible ("clean") compete purely
//      on length — the SHORTEST clean route wins. There is no clearance
//      distance and no cap on how much longer it may be than the default.
//   3. If no candidate is clean (some corridors have no parallel road), the
//      lowest length + OVERLAP_PENALTY * overlap wins — least shared road, but
//      not at any price.
//
// Candidates come from Google's own alternatives plus forced detours through
// waypoints placed beside the overlapping stretch.

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  decodePolyline,
  minDistancePointsToPolyline,
  minDistancePointToPolyline,
  exposureAlongRoute,
  bearingDegrees,
  destinationPoint,
  haversineMeters,
  remainingRoute,
  pathLengthMeters,
  samePath,
} = require('./geoUtils');
const { impliedSpeedLimitKmph, simulatedVehicleSpeedKmph } = require('./speedModel');

const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';
const MIN_SECONDS_BETWEEN_CALLS = 8; // soft throttle for non-forced calls
const MAX_ALTERNATIVES = 3;

// "Same road" — a route sample this close to an avoid-point is overlapping it.
const OVERLAP_METERS = 50;
// Overlap up to this much is treated as clean: a vehicle crossing the ambulance's
// road at a junction unavoidably touches it for a stretch.
const CLEAN_OVERLAP_METERS = 100;
// A route always starts/ends at origin/destination, so an ambulance road passing
// through either can't be avoided — ignore avoid-points this close to them.
const ENDPOINT_EXEMPT_METERS = 200;

// When no candidate is clean, routes are ranked by length + this many metres of
// penalty per metre of shared road — i.e. up to OVERLAP_PENALTY metres of extra
// driving is accepted to avoid one metre of the ambulance's road.
const OVERLAP_PENALTY = Number(process.env.OVERLAP_PENALTY) || 5;
// Optional cap on how much longer a forced detour may be than Google's default
// route (1.5 = at most 50% longer). 0 / unset = no cap, the original behaviour.
// A corridor with no parallel road can otherwise produce a detour 2x+ the
// length — correct by the "least shared road" rule, but not a drive anyone
// wants to make, and its length swings a lot from one request to the next.
const MAX_DETOUR_RATIO = Number(process.env.MAX_DETOUR_RATIO) || 0;
// A vehicle already on a route only switches to a new one if it's materially
// better (becomes clean, or is at least this many metres cheaper on the score
// above) — otherwise small wobbles as an ambulance moves would keep re-rerouting it.
const SWITCH_MARGIN_METERS = 500;

// Forced-detour search. Each round tries `patterns` (positions along the
// overlapping stretch, 0..1, to put via-waypoints at) at each of `offsets`
// (metres to the side of the road), on both sides of the road.
// A single waypoint isn't enough on a busy corridor — Google just rejoins the
// main road right after it — so some patterns place SEVERAL waypoints on the
// same side, which holds the route on a parallel road. Which pattern wins
// varies by road network (tuned against a brute-force search over 7 Bangalore
// origin/destination pairs), so rounds 1 and 2 try both kinds.
const DETOUR_ROUNDS = [
  {
    patterns: [[0.1], [0.3], [0.5], [0.7], [0.9]],
    offsets: [500, 1200],
  },
  {
    patterns: [[0.33, 0.66], [0.25, 0.5, 0.75]],
    offsets: [700, 1200, 1500], // the best multi-waypoint route often needs a wide berth
  },
  // Only reached if nothing clean turned up above.
  {
    patterns: [[0.15, 0.3, 0.5, 0.7, 0.85]],
    offsets: [700, 1200, 1800],
    onlyIfNotClean: true,
  },
];
// Refinement around the top few detours found: offsets scaled by these, and
// (single-waypoint detours) the waypoint's position along the road shifted.
const REFINE_TOP_N = 2;
const REFINE_OFFSET_SCALES = [0.65, 0.8, 1.25];
const REFINE_POSITION_SHIFTS = [-0.08, 0.08];

const lastCallAt = {};

function canCall(vehicleId) {
  const last = lastCallAt[vehicleId] || 0;
  return Date.now() - last >= MIN_SECONDS_BETWEEN_CALLS * 1000;
}

function markCalled(vehicleId) {
  lastCallAt[vehicleId] = Date.now();
}

// Called on disconnect so this table doesn't grow forever over a long session.
function forget(vehicleId) {
  delete lastCallAt[vehicleId];
}

// Local call counter — NOT a substitute for Google Cloud Console's own quota
// page (that's the authoritative number, and the only one that reflects
// billing). This just answers "how many calls has THIS backend made", across
// restarts, persisted to a small JSON file next to the code, so a spike from
// a heavy test session is visible without having to log into Cloud Console.
const USAGE_FILE = process.env.DIRECTIONS_USAGE_FILE || path.join(__dirname, '.directions-usage.json');
// Optional hard stop: once this many Directions calls have been made today
// (UTC day), further route requests fail with a clear message instead of
// spending more. 0 / unset = no limit. A public link without this means anyone
// holding it can spend your quota.
const DAILY_LIMIT = Number(process.env.DIRECTIONS_DAILY_LIMIT) || 0;
const today = () => new Date().toISOString().slice(0, 10);
let usage = { totalCalls: 0, since: new Date().toISOString(), lastCallAt: null, day: today(), dayCalls: 0 };
try {
  const saved = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  if (saved && typeof saved.totalCalls === 'number') usage = { day: today(), dayCalls: 0, ...saved };
} catch {
  // No file yet, or it's corrupt — start fresh rather than crash the server over this.
}
let pendingSave = null;
function recordDirectionsCall() {
  if (usage.day !== today()) {
    usage.day = today();
    usage.dayCalls = 0;
  }
  if (DAILY_LIMIT && usage.dayCalls >= DAILY_LIMIT) {
    throw new Error(`Daily Directions budget reached (${DAILY_LIMIT} calls) — no more routes until tomorrow (UTC).`);
  }
  usage.totalCalls++;
  usage.dayCalls++;
  usage.lastCallAt = new Date().toISOString();
  // Debounced write — a burst of calls (a detour search can fire 30+ in
  // parallel) shouldn't mean 30+ synchronous disk writes.
  clearTimeout(pendingSave);
  pendingSave = setTimeout(() => {
    fs.writeFile(USAGE_FILE, JSON.stringify(usage, null, 2), () => {});
  }, 500);
}
function getDirectionsUsage() {
  return { ...usage, dailyLimit: DAILY_LIMIT || null };
}

async function fetchDirections(params) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set in .env');

  recordDirectionsCall();
  // This project is scoped to India only — bias every Directions call toward
  // it (region is a hint, not a hard filter, which is why server.js also
  // rejects out-of-India origin/destination pairs outright before we get here).
  const response = await axios.get(DIRECTIONS_URL, { params: { region: 'in', ...params, key: apiKey } });
  const { status, routes, error_message: errorMessage } = response.data;

  // Google always returns 200 OK even on failure — the real result is in `status`.
  if (status !== 'OK' && status !== 'ZERO_RESULTS') {
    throw new Error(`Directions API error: ${status}${errorMessage ? ` — ${errorMessage}` : ''}`);
  }

  return (routes || []).map((r) => ({
    polyline: decodePolyline(r.overview_polyline.points),
    distanceMeters: r.legs?.[0]?.distance?.value ?? null,
    durationSeconds: r.legs?.[0]?.duration?.value ?? null,
  }));
}

// Trimmed copy of a route for the "alternatives" / "originalRoute" fields, so
// the frontend can draw them without them nesting further alternatives.
function slim(route, extra = {}) {
  const out = {
    polyline: route.polyline,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
  };
  for (const [k, v] of Object.entries(extra)) if (Number.isFinite(v)) out[k] = v;
  return out;
}

// Bearing of the route segment closest to `point`.
function localBearing(polyline, point) {
  if (!polyline || polyline.length < 2) return null;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = minDistancePointToPolyline(point, [polyline[i], polyline[i + 1]]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bearingDegrees(polyline[bestIdx], polyline[bestIdx + 1]);
}

// Avoid-points minus the ones sitting on the route's own start/end.
function relevantAvoidPoints(avoidPoints, origin, destination) {
  return (avoidPoints || []).filter(
    (p) => haversineMeters(p, origin) > ENDPOINT_EXEMPT_METERS && haversineMeters(p, destination) > ENDPOINT_EXEMPT_METERS
  );
}

/**
 * How many metres of `polyline` run on the same road as an ambulance, using the
 * exact same rule getRoute ranks by (so the reroute trigger and the route
 * choice can never disagree).
 */
function routeOverlapMeters(polyline, avoidPoints, origin, destination) {
  const avoid = relevantAvoidPoints(avoidPoints, origin, destination);
  if (avoid.length === 0) return 0;
  return exposureAlongRoute(polyline, avoid, OVERLAP_METERS).meters;
}

/**
 * Fetch a route from origin to destination for a vehicle that must stay off
 * the roads in avoidPoints.
 *
 * `incumbent` (optional): the route the vehicle is already on. It competes as a
 * candidate, and only loses to a materially better one — when it wins the result
 * has `keptIncumbent: true` and callers should leave the vehicle's route alone.
 *
 * Returns: { polyline, distanceMeters, durationSeconds, exposureMeters?, clearanceMeters?,
 *            usedDetour?, originalRoute?, alternatives, keptIncumbent? }
 *   - exposureMeters: metres of the chosen route still on an ambulance's road
 *     (0 / under CLEAN_OVERLAP_METERS = clean).
 *   - originalRoute: Google's default route, present only when avoidance
 *     picked something different (so the UI can show what was avoided).
 *   - alternatives: the other candidates considered, best first.
 * or null when Google genuinely has no route (ZERO_RESULTS).
 * Throws on a real API failure (bad key, quota, invalid request) — callers
 * should surface this to the user rather than treating it as "no route".
 */
async function getRoute({ vehicleId, origin, destination, avoidPoints = [], force = false, incumbent = null }) {
  if (!force && !canCall(vehicleId)) return null;

  const base = {
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
  };

  const decoded = await fetchDirections({ ...base, alternatives: true });
  markCalled(vehicleId);

  if (decoded.length === 0) return null;

  const original = decoded[0];
  const avoid = relevantAvoidPoints(avoidPoints, origin, destination);

  if (avoid.length === 0) {
    return {
      ...original,
      alternatives: decoded.slice(1, MAX_ALTERNATIVES + 1).map((r) => slim(r)),
      ...speedFields(original),
    };
  }

  const evaluate = (route, detour, via = null) => {
    const { meters, runs } = exposureAlongRoute(route.polyline, avoid, OVERLAP_METERS);
    return {
      route,
      detour,
      via,
      overlap: meters,
      runs,
    };
  };

  const isClean = (c) => c.overlap <= CLEAN_OVERLAP_METERS;
  const length = (c) => c.route.distanceMeters ?? Infinity;
  const cost = (c) => length(c) + OVERLAP_PENALTY * c.overlap;
  // Clean beats not-clean; two clean routes compete on length alone; two
  // not-clean ones on length + overlap penalty.
  const better = (a, b) => {
    if (isClean(a) !== isClean(b)) return isClean(a);
    return isClean(a) ? length(a) < length(b) : cost(a) < cost(b);
  };

  const candidates = decoded.map((route) => evaluate(route, false));
  const originalCandidate = candidates[0];
  const pickBest = () => candidates.reduce((b, c) => (better(c, b) ? c : b));

  // Google's shortest route is already clean: nothing to avoid, nothing shorter to find.
  let best = pickBest();

  const addRoutes = (routes, via) => {
    for (const route of routes) {
      if (MAX_DETOUR_RATIO && route.distanceMeters > original.distanceMeters * MAX_DETOUR_RATIO) continue;
      candidates.push(evaluate(route, true, via));
    }
  };

  if (!isClean(originalCandidate)) {
    // Anchor detours on the stretch of Google's DEFAULT route that overlaps.
    const overlapPoints = originalCandidate.runs.flat();

    // A detour is described by `via` = { pattern, side, offset }: waypoints at
    // the `pattern` positions (0..1) along the overlapping stretch, `offset`
    // metres to `side` (+90 / -90) of the road. Perpendicular is measured to the
    // road where it passes each anchor — not the overall origin->destination
    // bearing, which can be far off on a winding route.
    const waypointsFor = (via) =>
      via.pattern.map((frac) => {
        const anchor = overlapPoints[Math.min(overlapPoints.length - 1, Math.floor(overlapPoints.length * frac))];
        const roadBearing = localBearing(original.polyline, anchor) ?? bearingDegrees(origin, destination);
        return destinationPoint(anchor, roadBearing + via.side, via.offset);
      });

    const tried = new Set();
    const viaRequest = (via) => {
      const key = `${via.pattern.map((f) => f.toFixed(2))}|${via.side}|${Math.round(via.offset)}`;
      if (tried.has(key)) return Promise.resolve();
      tried.add(key);
      const waypoints = waypointsFor(via)
        .map((w) => `via:${w.lat},${w.lng}`)
        .join('|');
      return fetchDirections({ ...base, waypoints })
        .then((routes) => addRoutes(routes, via))
        .catch(() => {}); // a failed detour attempt (e.g. unroutable waypoint) just contributes nothing
    };

    for (const round of DETOUR_ROUNDS) {
      if (overlapPoints.length === 0) break;
      if (round.onlyIfNotClean && isClean(best)) continue;

      const requests = [];
      for (const pattern of round.patterns) {
        for (const side of [90, -90]) {
          for (const offset of round.offsets) requests.push(viaRequest({ pattern, side, offset }));
        }
      }
      await Promise.all(requests);
      best = pickBest();
    }

    // Refine: the coarse grid rarely lands exactly on the best waypoint, so try
    // small variations around the top few detours found so far.
    const seeds = candidates
      .filter((c) => c.via)
      .sort((x, y) => (better(x, y) ? -1 : 1))
      .filter((c, i, arr) => arr.findIndex((o) => samePath(o.route.polyline, c.route.polyline)) === i)
      .slice(0, REFINE_TOP_N);
    const refinements = [];
    for (const { via } of seeds) {
      for (const scale of REFINE_OFFSET_SCALES) refinements.push(viaRequest({ ...via, offset: via.offset * scale }));
      if (via.pattern.length === 1) {
        for (const shift of REFINE_POSITION_SHIFTS) {
          const frac = via.pattern[0] + shift;
          if (frac >= 0.02 && frac <= 0.98) refinements.push(viaRequest({ ...via, pattern: [frac] }));
        }
      }
    }
    await Promise.all(refinements);
    best = pickBest();
  }

  // Hysteresis against the route the vehicle is already on (trimmed to what's still
  // ahead of it, since a GPS vehicle has already driven part of it).
  let keptIncumbent = false;
  if (incumbent?.polyline?.length > 1) {
    const ahead = remainingRoute(incumbent.polyline, origin);
    const inc = evaluate({ polyline: ahead, distanceMeters: pathLengthMeters(ahead), durationSeconds: null }, true);
    const materiallyBetter =
      (isClean(best) && !isClean(inc)) ||
      (!isClean(best) && !isClean(inc) && cost(best) < cost(inc) - SWITCH_MARGIN_METERS) ||
      (isClean(best) && isClean(inc) && length(best) < length(inc) - SWITCH_MARGIN_METERS);
    if (best !== inc && !materiallyBetter) {
      best = inc;
      keptIncumbent = true;
    }
  }

  const alternatives = candidates
    .filter((c) => c !== best && !samePath(c.route.polyline, best.route.polyline))
    .sort((a, b) => (better(a, b) ? -1 : 1))
    .filter((c, i, arr) => arr.findIndex((o) => samePath(o.route.polyline, c.route.polyline)) === i)
    .slice(0, MAX_ALTERNATIVES)
    .map((c) => slim(c.route, { exposureMeters: c.overlap }));

  return {
    ...best.route,
    // Closest approach to any avoid-point — informational, and O(points x segments),
    // so worked out once for the winner only.
    clearanceMeters: minDistancePointsToPolyline(avoid, best.route.polyline),
    exposureMeters: best.overlap,
    usedDetour: best.detour,
    originalRoute:
      best === originalCandidate || samePath(best.route.polyline, original.polyline)
        ? undefined
        : slim(original, { exposureMeters: originalCandidate.overlap }),
    alternatives,
    ...speedFields(best.route),
    ...(keptIncumbent ? { keptIncumbent: true } : {}),
  };
}

// India-only speed assumptions (see speedModel.js) attached to every route so
// the frontend/tests can see what this project assumes a car drives this
// route at, and how that compares to the road's implied speed limit.
function speedFields(route) {
  const impliedSpeedLimitKmph_ = impliedSpeedLimitKmph(route);
  if (impliedSpeedLimitKmph_ == null) return {};
  return {
    impliedSpeedLimitKmph: Math.round(impliedSpeedLimitKmph_),
    simulatedVehicleSpeedKmph: Math.round(simulatedVehicleSpeedKmph(route)),
  };
}

module.exports = { getRoute, routeOverlapMeters, forget, CLEAN_OVERLAP_METERS, getDirectionsUsage };
