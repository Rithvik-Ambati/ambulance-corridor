// indiaBounds.js
// This system is scoped to India only (per product requirement). This is a
// bounding-box check, not a real polygon — an exact border needs a shapefile
// this project doesn't carry. The box below comfortably contains every Indian
// city and also a thin margin of neighbouring countries near the border
// (Pakistan, Nepal, Bangladesh, Myanmar, Sri Lanka, China). That's an accepted
// over-inclusion in exchange for a zero-dependency check; it still rejects the
// rest of the world, which is what "India only" is mostly protecting against
// here (wrong-country test data, a Directions result miles off, etc).

const INDIA_BOUNDS = { minLat: 6.0, maxLat: 37.6, minLng: 68.0, maxLng: 97.5 };

function isInIndia(point) {
  return (
    !!point &&
    typeof point.lat === 'number' &&
    typeof point.lng === 'number' &&
    point.lat >= INDIA_BOUNDS.minLat &&
    point.lat <= INDIA_BOUNDS.maxLat &&
    point.lng >= INDIA_BOUNDS.minLng &&
    point.lng <= INDIA_BOUNDS.maxLng
  );
}

module.exports = { isInIndia, INDIA_BOUNDS };
