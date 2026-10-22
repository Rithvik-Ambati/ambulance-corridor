// speedModel.js
// India-only speed assumptions, used for the reaction-buffer around a
// routeless ambulance, for the "how far away is it" estimate on a P1 alert,
// and by the test/demo simulator that drives devices along their routes.
//
// AMBULANCE_SPEED_KMPH is a flat operating average (sirens + right-of-way let
// it run faster than the posted limit) — not derived per-road. Configurable
// via env because different fleets/cities may want a different assumption.
const AMBULANCE_SPEED_KMPH = Number(process.env.AMBULANCE_SPEED_KMPH) || 60;
const AMBULANCE_SPEED_MPS = AMBULANCE_SPEED_KMPH / 3.6;

// A civilian car is assumed to drive this many km/h under the road's speed
// limit (traffic, caution, etc). There's no live per-segment speed-limit feed
// wired up here — Google's Roads API gives that, but it's a separate paid API
// this project doesn't call — so the limit is APPROXIMATED from the route's
// own Google duration/distance (i.e. "however fast Google's model thinks this
// road flows" stands in for its speed limit), clamped to a believable Indian
// road range. This is an approximation, not a real speed-limit lookup.
const SPEED_BELOW_LIMIT_KMPH = Number(process.env.SPEED_BELOW_LIMIT_KMPH) || 15;
const MIN_VEHICLE_SPEED_KMPH = 10; // never simulate a dead stop
const MIN_SPEED_LIMIT_KMPH = 20;
const MAX_SPEED_LIMIT_KMPH = 100;

// Implied speed limit (km/h) for a Google route, from its own distance/duration.
function impliedSpeedLimitKmph(route) {
  if (!route || !route.distanceMeters || !route.durationSeconds) return null;
  const kmph = (route.distanceMeters / route.durationSeconds) * 3.6;
  return Math.min(MAX_SPEED_LIMIT_KMPH, Math.max(MIN_SPEED_LIMIT_KMPH, kmph));
}

// The speed this project simulates a civilian car driving that route at.
function simulatedVehicleSpeedKmph(route) {
  const limit = impliedSpeedLimitKmph(route) ?? MIN_SPEED_LIMIT_KMPH + SPEED_BELOW_LIMIT_KMPH;
  return Math.max(MIN_VEHICLE_SPEED_KMPH, limit - SPEED_BELOW_LIMIT_KMPH);
}

module.exports = {
  AMBULANCE_SPEED_KMPH,
  AMBULANCE_SPEED_MPS,
  SPEED_BELOW_LIMIT_KMPH,
  MIN_VEHICLE_SPEED_KMPH,
  impliedSpeedLimitKmph,
  simulatedVehicleSpeedKmph,
};
