// server.js
// Full backend: device registry + live position relay + corridor-triggered
// reroutes using real Google Directions calls, priority-aware ambulance
// avoidance, India-only enforcement, and a "failed to give way" DL-fine flow.
// See README for the product spec this implements.

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const { Server } = require('socket.io');

const publicView = require('./publicView');
const routingService = require('./routingService');
const corridorLogic = require('./corridorLogic');
const historyStore = require('./historyStore');
const violationService = require('./violationService');
const dlVerificationService = require('./dlVerificationService');
const ambulanceQueue = require('./ambulanceQueue');
const priority = require('./priority');
const speedModel = require('./speedModel');
const { haversineMeters } = require('./geoUtils');
const { isInIndia } = require('./indiaBounds');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Optional lightweight guard: set REGISTRATION_SECRET in .env to require
// clients to send a matching token on 'register'. Left unset by default so
// local demos keep working with zero extra setup.
const REGISTRATION_SECRET = process.env.REGISTRATION_SECRET || null;

const INDIA_ONLY_MESSAGE = 'This system operates within India only — that point falls outside the supported area.';

// socket.id -> { role, label, clientId, priority, dl, lat, lng, lastUpdate,
//                speedMps, origin, originIsManual, destination, currentRoute, routeRequestId }
const connectedDevices = {};

function freshDevice(role, label, clientId) {
  return {
    role,
    label: label || null,
    clientId: clientId || null,
    priority: role === 'ambulance' ? priority.DEFAULT_AMBULANCE_PRIORITY : null,
    dl: null,
    lat: null,
    lng: null,
    lastUpdate: null,
    speedMps: null,
    origin: null,
    originIsManual: false,
    destination: null,
    currentRoute: null,
    routeRequestId: 0,
  };
}

// ---- Operator endpoints -------------------------------------------------
// /devices, /history, /violations and /api-usage are for whoever runs the
// system, not for the phones. With ADMIN_TOKEN set they need it (header
// `x-admin-token` or `?token=`). With NODE_ENV=production and NO token they
// are switched off entirely, so a deployed link can't leak licence numbers or
// trip history just because someone forgot to configure it. Locally (no
// token, not production) they stay open, as before.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    if (IS_PRODUCTION) return res.status(403).json({ error: 'Set ADMIN_TOKEN to enable this endpoint in production.' });
    return next();
  }
  const supplied = req.get('x-admin-token') || req.query.token;
  if (supplied && safeEqual(supplied, ADMIN_TOKEN)) return next();
  return res.status(401).json({ error: 'Admin token required.' });
}

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/devices', requireAdmin, (req, res) => res.json(publicView.adminDevices(connectedDevices)));
app.get('/history', requireAdmin, (req, res) =>
  res.json({ count: historyStore.getCount(), entries: historyStore.getAll() })
);
app.get('/violations', requireAdmin, (req, res) => res.json({ count: violationService.getAll().length, entries: violationService.getAll() }));
app.get('/config', (req, res) =>
  res.json({
    country: 'IN',
    ambulanceSpeedKmph: speedModel.AMBULANCE_SPEED_KMPH,
    speedBelowLimitKmph: speedModel.SPEED_BELOW_LIMIT_KMPH,
    priorities: priority.PRIORITIES,
    yieldGraceSeconds: violationService.YIELD_GRACE_SECONDS,
    yieldZoneMeters: violationService.YIELD_ZONE_METERS,
    fineInr: violationService.FINE_INR,
    legalBasis: violationService.MV_ACT_SECTION,
  })
);
// Local Directions-call counter, persisted across restarts — NOT the
// authoritative usage number. That's Google Cloud Console (APIs & Services →
// Directions API → Metrics/Quotas), which is the only source that reflects
// actual billing; this just tells you how many calls THIS backend has made.
app.get('/api-usage', requireAdmin, (req, res) => res.json(routingService.getDirectionsUsage()));

// If the frontend has been built (npm run build in frontend-app), serve it from
// here too: one process, one address, same origin as the socket — which is what
// lets a single HTTPS link (e.g. a Render URL) work on a phone with no proxy.
const DIST_DIR = path.join(__dirname, '..', 'frontend-app', 'dist');
const DIST_INDEX = path.join(DIST_DIR, 'index.html');
if (fs.existsSync(DIST_INDEX)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/socket.io')) return next();
    return res.sendFile(DIST_INDEX);
  });
  console.log(`Serving the built frontend from ${DIST_DIR}`);
} else {
  app.get('/', (req, res) => res.send('Ambulance corridor backend is running.'));
}

// Abuse/accident limits — a shared link means strangers (or a stuck client in
// a loop) can otherwise run up Directions calls and memory.
const MAX_DEVICES = Number(process.env.MAX_DEVICES) || 100;
const ROUTE_REQUESTS_PER_MINUTE = Number(process.env.ROUTE_REQUESTS_PER_MINUTE) || 30;
const clip = (value, max) => (value == null ? null : String(value).slice(0, max));

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);
  const routeRequestTimes = []; // this socket's recent set-destination timestamps

  // Client asks for an ambulance's route geometry it doesn't have cached
  // (devices-update only carries a short routeKey — see publicView.js).
  socket.on('get-route', ({ id } = {}) => {
    const d = connectedDevices[id];
    if (d && d.role === 'ambulance' && d.currentRoute?.polyline) {
      socket.emit('route-geometry', { id, key: publicView.routeKeyOf(d.currentRoute), polyline: d.currentRoute.polyline });
    }
  });

  socket.on('register', async ({ role, label, clientId, secret, priority: requestedPriority, dl } = {}) => {
    if (REGISTRATION_SECRET && secret !== REGISTRATION_SECRET) {
      socket.emit('route-error', { message: 'Registration rejected — invalid or missing secret.' });
      socket.disconnect(true);
      return;
    }
    if (!connectedDevices[socket.id] && Object.keys(connectedDevices).length >= MAX_DEVICES) {
      socket.emit('route-error', { message: 'This server is full right now — try again later.' });
      socket.disconnect(true);
      return;
    }

    const safeRole = role === 'ambulance' ? 'ambulance' : 'vehicle'; // anything else silently falls back to 'vehicle'
    label = clip(label, 40);
    clientId = clip(clientId, 80);
    const device = freshDevice(safeRole, label, clientId);

    if (safeRole === 'ambulance') {
      device.priority = priority.normalizePriority(requestedPriority);
    } else if (dl && dl.dlNumber) {
      // DL capture is opt-in for a vehicle — only vehicles that supply it can
      // later be identified/fined; an unidentified vehicle can still be
      // logged as "blocking" but has no licence to flag.
      const dlNumber = clip(dl.dlNumber, 40);
      const holderName = clip(dl.holderName, 80);
      const dob = clip(dl.dob, 10);
      const verification = await dlVerificationService.verifyDL({ dlNumber, name: holderName, dob });
      device.dl = {
        dlNumber: dlVerificationService.normalizeDL(dlNumber),
        holderName: holderName || null,
        dob: dob || null,
        verification,
      };
    }

    connectedDevices[socket.id] = device;
    socket.emit('registered', {
      role: safeRole,
      priority: device.priority,
      priorityInfo: device.priority ? priority.infoFor(device.priority) : null,
      dlVerification: device.dl?.verification || null,
    });
    console.log(
      `[register] ${socket.id} -> role=${safeRole} label=${label}${device.priority ? ` priority=P${device.priority}` : ''}${device.dl ? ` dl=${device.dl.verification.status}` : ''}`
    );
  });

  // Either role can set a destination. If an explicit `origin` is provided
  // (from the Start search box), that's used instead of live GPS — lets you
  // test full routes from a laptop/phone without needing to be there.
  // The route requested is already steered away from every ambulance that
  // outranks this device — not just recalculated later when one gets close.
  socket.on('set-destination', async ({ lat, lng, origin } = {}) => {
    const device = connectedDevices[socket.id];
    if (!device) {
      socket.emit('route-error', { message: 'Device not registered yet - try again in a moment.' });
      return;
    }

    // Each route request can cost several Directions calls — cap how fast one
    // client can ask (sliding one-minute window).
    const nowMs = Date.now();
    while (routeRequestTimes.length && nowMs - routeRequestTimes[0] > 60000) routeRequestTimes.shift();
    if (routeRequestTimes.length >= ROUTE_REQUESTS_PER_MINUTE) {
      socket.emit('route-error', { message: 'Too many route requests — wait a moment and try again.' });
      return;
    }
    routeRequestTimes.push(nowMs);

    // Start point precedence: an explicit one just sent; else live GPS; else the
    // manual Start point from earlier in this trip. That last fallback is what lets
    // you change destination mid-journey without re-entering the Start each time.
    const effectiveOrigin =
      origin ||
      (device.lat != null && device.lng != null ? { lat: device.lat, lng: device.lng } : null) ||
      (device.originIsManual ? device.origin : null);

    if (!effectiveOrigin) {
      socket.emit('route-error', {
        message: 'Start tracking, or set a Start point, before setting a destination.',
      });
      return;
    }

    const destinationPoint = { lat, lng };
    if (!isInIndia(effectiveOrigin) || !isInIndia(destinationPoint)) {
      socket.emit('route-error', { message: INDIA_ONLY_MESSAGE });
      return;
    }

    device.origin = effectiveOrigin;
    // A Start point sent now, or kept from before (when there's no GPS), stays manual
    // so corridor reroutes start from it rather than from wherever the laptop is.
    device.originIsManual = !!origin || (device.originIsManual && !(device.lat != null && device.lng != null));
    device.destination = destinationPoint;
    // Only the newest destination request may set the route — an older, slower one
    // (or a corridor reroute for the previous destination) must not overwrite it.
    const requestId = (device.routeRequestId = (device.routeRequestId || 0) + 1);
    const destination = device.destination;

    const devicePriority = device.role === 'ambulance' ? priority.normalizePriority(device.priority) : null;
    // A vehicle avoids P1/P2 ambulances; an ambulance only avoids a strictly
    // higher-priority one (P1 avoids nobody, so this short-circuits to []).
    const maxPriority = device.role === 'vehicle' ? 2 : devicePriority - 1;

    // Ambulance route requests are ordered by priority ("absolute priority in
    // the MAS queue" for P1; P2/P3 wait for higher-priority requests to lock
    // in first) BEFORE computing avoidPoints — otherwise a P2 request that
    // arrives at the same moment as a P1 one would compute its avoid-list
    // before P1's route exists to avoid, and queuing wouldn't help.
    if (device.role === 'ambulance') await ambulanceQueue.waitTurn(devicePriority);
    const avoidPoints = corridorLogic.getAvoidPoints(connectedDevices, socket.id, { maxPriority });
    try {
      const route = await routingService.getRoute({
        vehicleId: socket.id,
        origin: device.origin,
        destination,
        avoidPoints,
        force: true,
      });

      if (device.routeRequestId !== requestId || connectedDevices[socket.id] !== device) return; // superseded
      if (route) {
        device.currentRoute = route;
        // This route was just computed WITH avoidance already applied — start
        // the corridor cooldown now so the very next GPS tick doesn't
        // immediately reroute again over the same, already-handled situation.
        corridorLogic.markRerouted(socket.id);
        socket.emit('route-update', { route });
        publicView.broadcast(io, connectedDevices);

        // A newly (re)computed route can put this device on top of someone
        // else's route — check everyone now instead of waiting for a GPS tick.
        corridorLogic.checkAllCorridors(connectedDevices, io).catch((err) =>
          console.error('[corridor] check failed:', err.message)
        );
      } else {
        socket.emit('route-error', { message: 'Google Directions found no route between those points.' });
      }
    } catch (err) {
      console.error(`[route] initial route failed for ${socket.id}:`, err.message);
      socket.emit('route-error', { message: err.message });
    } finally {
      if (device.role === 'ambulance') ambulanceQueue.done(devicePriority);
    }
  });

  // Drop the current trip (route, origin, destination) without disconnecting.
  socket.on('clear-route', () => {
    const device = connectedDevices[socket.id];
    if (!device) return;
    device.routeRequestId = (device.routeRequestId || 0) + 1; // cancels any in-flight route
    device.origin = null;
    device.originIsManual = false;
    device.destination = null;
    device.currentRoute = null;
    corridorLogic.forget(socket.id);
    socket.emit('route-cleared');
    publicView.broadcast(io, connectedDevices);
  });

  socket.on('position', async ({ lat, lng } = {}) => {
    if (!connectedDevices[socket.id]) {
      connectedDevices[socket.id] = freshDevice('vehicle', socket.id, null);
    }

    const device = connectedDevices[socket.id];

    if (!isInIndia({ lat, lng })) {
      // GPS drift near a border is real — ignore the tick rather than
      // disconnecting, but don't silently accept a position that would break
      // every India-only assumption downstream.
      const now = Date.now();
      if (!device._lastIndiaWarnAt || now - device._lastIndiaWarnAt > 30000) {
        device._lastIndiaWarnAt = now;
        socket.emit('route-error', { message: INDIA_ONLY_MESSAGE + ' (position ignored)' });
      }
      return;
    }

    // Server time, not the client's: a phone with a wrong clock (or a client
    // sending junk) would otherwise corrupt the staleness display and speed.
    const now = Date.now();

    // Rough speed estimate from consecutive positions — used to widen the
    // corridor buffer for a fast-moving ambulance. Clamped: two updates
    // delivered in a burst after a reconnect would otherwise read as absurd speed.
    if (device.lat != null && device.lng != null && device.lastUpdate) {
      const dtSeconds = (now - device.lastUpdate) / 1000;
      if (dtSeconds > 0.2) {
        const dMeters = haversineMeters({ lat: device.lat, lng: device.lng }, { lat, lng });
        device.speedMps = Math.min(70, dMeters / dtSeconds);
      }
    }

    device.lat = lat;
    device.lng = lng;
    device.lastUpdate = now;

    console.log(`[position] ${socket.id} (${device.role}) -> ${lat}, ${lng}`);

    publicView.broadcast(io, connectedDevices);

    corridorLogic.checkAllCorridors(connectedDevices, io).catch((err) =>
      console.error('[corridor] check failed:', err.message)
    );
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    delete connectedDevices[socket.id];
    routingService.forget(socket.id);
    corridorLogic.forget(socket.id);
    publicView.broadcast(io, connectedDevices);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend listening on http://0.0.0.0:${PORT}`);
  console.log(`India-only mode. Ambulance speed assumption: ${speedModel.AMBULANCE_SPEED_KMPH}km/h. Vehicles simulated at speed-limit-${speedModel.SPEED_BELOW_LIMIT_KMPH}km/h.`);
  if (REGISTRATION_SECRET) console.log('Registration secret is ENABLED.');
  if (IS_PRODUCTION && !ADMIN_TOKEN) console.log('NODE_ENV=production without ADMIN_TOKEN: /devices, /history, /violations and /api-usage are disabled.');
});
