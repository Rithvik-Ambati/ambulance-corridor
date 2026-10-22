// src/App.jsx
// Full app: register as ambulance/vehicle, stream real GPS, set a
// destination via map click or search bar, watch reroutes happen live,
// and (for vehicles) see every ambulance within 25km.

import { useEffect, useMemo, useRef, useState } from 'react';
import { socket, getClientId } from './socket';
import MapView from './MapView';
import './App.css';

const NEARBY_RADIUS_KM = 25;
const STALE_AFTER_MS = 30000; // a device with no position update in this long is shown dimmed

// Haversine distance in km — used only for the "nearby ambulances" display.
function distanceKm(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// One-sentence summary of how well a route avoids ambulances. `exposureMeters`
// is how much of it still runs on the same road as an ambulance.
function describeExposure(route) {
  const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`);
  const before = route.originalRoute?.exposureMeters;
  const length = route.distanceMeters ? ` (${km(route.distanceMeters)})` : '';
  if (route.exposureMeters <= 100) {
    return `stays off the ambulance's road${length}${route.originalRoute ? '; the default route it would share is shown red' : ''}.`;
  }
  const improved =
    typeof before === 'number' && before > route.exposureMeters
      ? `, down from ${km(before)} on the default route (red)`
      : '';
  return `${km(route.exposureMeters)} of this route${length} still shares the ambulance's road${improved}. No fully separate route exists here.`;
}

// Driver alerts. Phones only allow sound/speech after the user has tapped
// something on the page, and a reroute arrives long after that tap — so a
// shared audio context is created/resumed inside the "Start" tap
// (unlockAudio) and reused later. Without this the beep is silently blocked
// on mobile, and a solo driver has no way to notice a reroute.
let audioCtx = null;

function unlockAudio() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx && !audioCtx) audioCtx = new AudioCtx();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    // Speech has the same rule on iOS — speak nothing once, inside the tap.
    if ('speechSynthesis' in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  } catch {
    // Not fatal — the on-screen banner still shows.
  }
}

// Beep + vibrate + (optionally) speak a short sentence.
function alertDriver(spoken) {
  try {
    navigator.vibrate?.([250, 120, 250]);
  } catch {
    // Vibration isn't available everywhere (iOS Safari has none).
  }
  try {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.5);
    }
  } catch {
    // Audio can fail (autoplay policy, unsupported browser) — not critical.
  }
  try {
    if (spoken && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(spoken));
    }
  } catch {
    // Speech unavailable — banner and beep still work.
  }
}

// Ambulance priority categories. Kept in sync with backend/priority.js by hand
// (a small, stable list) rather than fetched, so the selector renders instantly.
const PRIORITY_OPTIONS = [
  { value: 1, label: 'P1 — Critical / Life-threatening', hint: 'Cardiac arrest, active labour, major trauma, organ transport. Shortest route, near-instant civilian rerouting.' },
  { value: 2, label: 'P2 — Urgent / Serious', hint: 'Stable fractures, moderate burns, urgent blood/lab logistics. Rerouted around any P1, reroutes civilians normally.' },
  { value: 3, label: 'P3 — Non-emergency / Routine', hint: 'Scheduled transfers, discharges, routine supplies. Advisory only — never forces civilians to reroute.' },
];

export default function App() {
  const [role, setRole] = useState('vehicle'); // 'ambulance' or 'vehicle'
  const [label, setLabel] = useState('Phone 1');
  const [priorityLevel, setPriorityLevel] = useState(1); // ambulance role only
  const [dlNumber, setDlNumber] = useState('');
  const [holderName, setHolderName] = useState('');
  const [dob, setDob] = useState('');
  const [dlVerification, setDlVerification] = useState(null); // result of the last register attempt
  const [tracking, setTracking] = useState(false);
  const [status, setStatus] = useState(socket.connected ? 'Connected to backend' : 'Not connected');
  const [devices, setDevices] = useState({}); // other devices, as broadcast (no route geometry — see routeCache)
  const [routeGeometry, setRouteGeometry] = useState({}); // ambulance route polylines by routeKey
  const [myPosition, setMyPosition] = useState(null);
  const [myRoute, setMyRoute] = useState(null);
  const [pendingOrigin, setPendingOrigin] = useState(null); // manual start override, from the Start search box
  const [avoidedRoute, setAvoidedRoute] = useState(null); // route just replaced by a reroute
  const [rerouteAlert, setRerouteAlert] = useState(null);
  const [ambulanceAlert, setAmbulanceAlert] = useState(null); // P3 advisory banner
  const [violation, setViolation] = useState(null); // "you were fined" banner, this device only
  const [violationCount, setViolationCount] = useState(0); // system-wide, from violation-logged broadcasts
  const [registered, setRegistered] = useState(false); // has 'register' been sent to the backend yet
  const [rerouteCount, setRerouteCount] = useState(0); // reroutes this device has received this session
  const [now, setNow] = useState(Date.now()); // ticks periodically to drive staleness display
  const watchIdRef = useRef(null);
  const wakeLockRef = useRef(null);
  // What to replay if the connection drops: the server forgets a device (its
  // role, priority and trip) the moment its socket closes, and mobile data in a
  // moving car does drop. Without replaying this, an ambulance that reconnects
  // is silently treated as an ordinary vehicle with no route.
  const registerPayloadRef = useRef(null);
  const lastTripRef = useRef(null); // { lat, lng, origin? }
  const resendTripOnNextPositionRef = useRef(false);
  // devices-update carries only a routeKey per ambulance; these are the keys whose
  // geometry has already been asked for, so each is requested once.
  const requestedRoutesRef = useRef(new Set());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(tick);
  }, []);

  // Keep the screen on while tracking: a locked phone stops reporting GPS.
  // (Wake Lock needs HTTPS and a recent browser; if it's unavailable the page
  // simply behaves as before.) The lock is dropped by the browser whenever the
  // page is hidden, so it's re-requested when the page becomes visible again.
  useEffect(() => {
    if (!tracking) return undefined;
    const acquire = async () => {
      try {
        if ('wakeLock' in navigator && !wakeLockRef.current) {
          const lock = await navigator.wakeLock.request('screen');
          wakeLockRef.current = lock;
          lock.addEventListener('release', () => {
            if (wakeLockRef.current === lock) wakeLockRef.current = null;
          });
        }
      } catch {
        // Denied (low battery mode, etc.) — not fatal.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [tracking]);

  useEffect(() => {
    const onConnect = () => {
      setStatus('Connected to backend');
      // A reconnect (not the first connect): put this device back the way the
      // server last knew it. Register first, then the trip — Socket.IO keeps
      // these in order. A trip that follows live GPS is re-sent after the next
      // position update instead, since the server needs a position to start from.
      if (registerPayloadRef.current) {
        socket.emit('register', registerPayloadRef.current);
        const trip = lastTripRef.current;
        if (trip) {
          if (trip.origin) socket.emit('set-destination', trip);
          else resendTripOnNextPositionRef.current = true;
        }
      }
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', () => {
      setStatus('Disconnected — reconnecting…');
      requestedRoutesRef.current.clear(); // any reply still in flight is lost — ask again after reconnecting
    });

    socket.on('devices-update', (allDevices) => {
      // Ask for any ambulance route geometry we haven't requested yet, once per key.
      const live = new Set();
      for (const [id, d] of Object.entries(allDevices)) {
        if (d.role !== 'ambulance' || !d.routeKey) continue;
        live.add(d.routeKey);
        if (!requestedRoutesRef.current.has(d.routeKey)) {
          requestedRoutesRef.current.add(d.routeKey);
          socket.emit('get-route', { id });
        }
      }
      // Forget geometry nobody is using any more.
      for (const key of requestedRoutesRef.current) if (!live.has(key)) requestedRoutesRef.current.delete(key);
      setRouteGeometry((prev) => {
        const keys = Object.keys(prev);
        if (keys.every((k) => live.has(k))) return prev;
        const next = {};
        for (const k of keys) if (live.has(k)) next[k] = prev[k];
        return next;
      });
      setDevices(allDevices);
    });

    socket.on('route-geometry', ({ key, polyline }) => {
      if (!key || !polyline) return;
      setRouteGeometry((prev) => ({ ...prev, [key]: polyline }));
    });

    // A fresh destination pick. If ambulance-avoidance already changed the route
    // away from Google's default, show that default as the red "avoided" path.
    socket.on('route-update', ({ route }) => {
      setMyRoute(route);
      setAvoidedRoute(route.originalRoute || null);
      const altCount = route.alternatives?.length || 0;
      const altNote = altCount ? ` ${altCount} alternative${altCount === 1 ? '' : 's'} shown in grey.` : '';
      if (typeof route.exposureMeters === 'number') {
        setStatus(`Route set — ${describeExposure(route)}${altNote}`);
      } else if (altNote) {
        setStatus(`Route set.${altNote}`);
      }
    });

    // Fired only at the device whose corridor an ambulance just entered.
    socket.on('reroute', ({ route, reason }) => {
      setMyRoute((prevRoute) => {
        setAvoidedRoute(prevRoute);
        return route;
      });
      setRerouteCount((c) => c + 1);
      alertDriver('Ambulance approaching. Your route has changed.');
      const exposureNote = typeof route.exposureMeters === 'number' ? ` ${describeExposure(route)}` : '';
      setRerouteAlert(`Rerouted — ${reason}. Old route shown in red, new route in blue.${exposureNote}`);
      setTimeout(() => setRerouteAlert(null), 8000);
    });

    socket.on('route-error', ({ message }) => {
      setStatus(`Routing error: ${message}`);
    });

    // Ack for 'register' — surfaces the DL verification result (vehicle) or
    // confirms the priority the backend actually applied (ambulance).
    socket.on('registered', ({ role: ackRole, priority: ackPriority, dlVerification: ackDl }) => {
      if (ackRole === 'vehicle' && ackDl) {
        setDlVerification(ackDl);
      }
      if (ackRole === 'ambulance' && ackPriority) {
        setStatus(`Registered as ambulance — Priority ${ackPriority}.`);
      }
    });

    // Broadcast advisory for a P3 (routine) ambulance sharing a road — no
    // reroute is forced, so this is purely informational.
    socket.on('ambulance-alert', ({ message }) => {
      alertDriver('Ambulance nearby. Please keep the lane clear.');
      setAmbulanceAlert(message);
      setTimeout(() => setAmbulanceAlert(null), 10000);
    });

    // Sent only to the vehicle that failed to give way, once the grace period
    // to clear a P1/P2 ambulance's path has elapsed.
    socket.on('violation', (v) => {
      const fineNote = v.fineInr != null ? `a ₹${v.fineInr.toLocaleString('en-IN')} fine` : 'a violation (no fine — your licence wasn\'t verified)';
      setViolation(
        `You did not give way to ${v.ambulanceLabel} (Priority ${v.ambulancePriority}). Logged as ${fineNote} under ${v.legalBasis}. ${v.sentToCops}.`
      );
    });

    // System-wide counter — every violation, for any vehicle, not just this one.
    socket.on('violation-logged', () => {
      setViolationCount((c) => c + 1);
    });

    // Server confirms the trip was dropped — wipe everything route-related here too.
    socket.on('route-cleared', () => {
      setMyRoute(null);
      setAvoidedRoute(null);
      setPendingOrigin(null);
      setRerouteAlert(null);
      setStatus('Route cleared — pick a new Start and Destination.');
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('devices-update');
      socket.off('route-geometry');
      socket.off('route-update');
      socket.off('reroute');
      socket.off('route-error');
      socket.off('route-cleared');
      socket.off('registered');
      socket.off('ambulance-alert');
      socket.off('violation');
      socket.off('violation-logged');
    };
  }, []);

  // Registers this device with the backend exactly once — needed before GPS
  // tracking starts AND before setting a Start/Destination via search, since
  // either can happen first. Ambulances send their priority; vehicles send
  // their DL details only if they filled them in (both optional).
  const ensureRegistered = () => {
    if (!registered) {
      const payload = { role, label, clientId: getClientId() };
      if (role === 'ambulance') payload.priority = priorityLevel;
      if (role === 'vehicle' && dlNumber.trim()) {
        payload.dl = { dlNumber: dlNumber.trim(), holderName: holderName.trim(), dob };
      }
      registerPayloadRef.current = payload;
      socket.emit('register', payload);
      setRegistered(true);
    }
    unlockAudio(); // every path that gets here starts from a tap
  };

  const startTracking = () => {
    if (!navigator.geolocation) {
      setStatus('Geolocation not supported on this browser.');
      return;
    }

    ensureRegistered();

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setMyPosition({ lat: latitude, lng: longitude });
        socket.emit('position', { lat: latitude, lng: longitude, timestamp: Date.now() });
        if (resendTripOnNextPositionRef.current && lastTripRef.current) {
          resendTripOnNextPositionRef.current = false;
          socket.emit('set-destination', lastTripRef.current);
        }
      },
      (err) => setStatus(`Location error: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );

    setTracking(true);
    setStatus('Tracking live position — keep this page open and the screen on.');
  };

  const stopTracking = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setTracking(false);
    setStatus('Stopped');
  };

  // Either role can set a destination — ambulances get a visible route too,
  // vehicles get corridor-aware rerouting on top of theirs. If a Start point
  // was set via the search box, it's sent along and used instead of live GPS.
  const handleSetDestination = (latLng) => {
    ensureRegistered();
    const trip = { lat: latLng.lat, lng: latLng.lng, origin: pendingOrigin || undefined };
    // A Start point stays with the trip so a mid-journey destination change (or a
    // reconnect) doesn't need it typed in again; a GPS-origin trip has none.
    lastTripRef.current = { ...trip, origin: trip.origin || (tracking ? undefined : lastTripRef.current?.origin) };
    socket.emit('set-destination', trip);
    setStatus(`Destination set at ${latLng.lat.toFixed(5)}, ${latLng.lng.toFixed(5)}`);
    setPendingOrigin(null); // consumed — next destination defaults back to live GPS unless set again
  };

  // Called when the Start search box resolves a place — just stores it
  // locally until the next destination is set.
  const handleSetOrigin = (latLng) => {
    ensureRegistered();
    setPendingOrigin(latLng);
    setStatus(`Start set at ${latLng.lat.toFixed(5)}, ${latLng.lng.toFixed(5)} — now pick a destination`);
  };

  // Drop the current trip so a new Start/Destination can be chosen from scratch
  // (no page reload needed).
  const handleClearRoute = () => {
    socket.emit('clear-route');
    lastTripRef.current = null;
    resendTripOnNextPositionRef.current = false;
    setMyRoute(null);
    setAvoidedRoute(null);
    setPendingOrigin(null);
  };

  // Ambulances within NEARBY_RADIUS_KM of this device, closest first.
  const nearbyAmbulances = useMemo(() => {
    if (role !== 'vehicle' || !myPosition) return [];
    return Object.entries(devices)
      .filter(([, d]) => d.role === 'ambulance' && d.lat != null && d.lng != null)
      .map(([id, d]) => ({
        id,
        label: d.label,
        lat: d.lat,
        lng: d.lng,
        distance: distanceKm(myPosition, { lat: d.lat, lng: d.lng }),
      }))
      .filter((d) => d.distance <= NEARBY_RADIUS_KM)
      .sort((a, b) => a.distance - b.distance);
  }, [devices, myPosition, role]);

  // MapView draws each ambulance's route from device.currentRoute.polyline; the
  // broadcast carries only a routeKey, so fill the geometry in from the cache.
  const mapDevices = useMemo(() => {
    const out = {};
    for (const [id, d] of Object.entries(devices)) {
      const polyline = d.routeKey ? routeGeometry[d.routeKey] : null;
      out[id] = { ...d, currentRoute: polyline ? { polyline } : null };
    }
    return out;
  }, [devices, routeGeometry]);

  // Which device IDs haven't reported a position recently — MapView dims these.
  const staleDeviceIds = useMemo(() => {
    const stale = new Set();
    for (const [id, d] of Object.entries(devices)) {
      if (d.lastUpdate && now - d.lastUpdate > STALE_AFTER_MS) stale.add(id);
    }
    return stale;
  }, [devices, now]);

  return (
    <div className="app-shell">
      <div className="top-row">
        <h1 className="app-title">Ambulance Corridor — Live</h1>
        {rerouteCount > 0 && <span className="reroute-badge">{rerouteCount} reroute{rerouteCount === 1 ? '' : 's'} this session</span>}
        {violationCount > 0 && <span className="violation-badge">{violationCount} give-way violation{violationCount === 1 ? '' : 's'} logged</span>}
      </div>

      <div className="status-row">
        <span className="status-pill">
          <span className={`status-dot ${tracking ? '' : 'off'}`} />
          {status}
        </span>
      </div>

      {rerouteAlert && <div className="reroute-banner">{rerouteAlert}</div>}
      {ambulanceAlert && <div className="advisory-banner">{ambulanceAlert}</div>}
      {violation && <div className="violation-banner">{violation}</div>}

      <div className="control-card">
        <div className="field">
          <label>Role</label>
          <select
            value={role}
            onChange={(e) => {
              setRole(e.target.value);
              if (!tracking) setRegistered(false);
            }}
            disabled={tracking}
          >
            <option value="vehicle">Vehicle</option>
            <option value="ambulance">Ambulance</option>
          </select>
        </div>

        <div className="field">
          <label>Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              if (!tracking) setRegistered(false);
            }}
            disabled={tracking}
          />
        </div>

        {role === 'ambulance' && (
          <div className="field field-wide">
            <label>Priority</label>
            <select
              value={priorityLevel}
              onChange={(e) => {
                setPriorityLevel(Number(e.target.value));
                if (!tracking) setRegistered(false);
              }}
              disabled={tracking}
            >
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="field-hint">{PRIORITY_OPTIONS.find((p) => p.value === priorityLevel)?.hint}</p>
          </div>
        )}

        {role === 'vehicle' && (
          <div className="field field-wide">
            <label>Driving licence (optional — needed to be identifiable if fined)</label>
            <div className="dl-row">
              <input
                type="text"
                placeholder="DL number, e.g. KA0120230012345"
                value={dlNumber}
                onChange={(e) => {
                  setDlNumber(e.target.value);
                  setDlVerification(null);
                  if (!tracking) setRegistered(false);
                }}
                disabled={tracking}
              />
              <input
                type="text"
                placeholder="Holder name"
                value={holderName}
                onChange={(e) => {
                  setHolderName(e.target.value);
                  setDlVerification(null);
                  if (!tracking) setRegistered(false);
                }}
                disabled={tracking}
              />
              <input
                type="date"
                value={dob}
                onChange={(e) => {
                  setDob(e.target.value);
                  setDlVerification(null);
                  if (!tracking) setRegistered(false);
                }}
                disabled={tracking}
              />
            </div>
            {dlVerification && (
              <p className={`field-hint dl-status dl-status-${dlVerification.status.toLowerCase()}`}>
                {dlVerification.status === 'VERIFIED' ? '✓ Verified' : '✗ Not verified'}
                {dlVerification.reason ? ` — ${dlVerification.reason}` : ''}
                {dlVerification.note ? ` — ${dlVerification.note}` : ''}
              </p>
            )}
          </div>
        )}

        {!tracking ? (
          <button className="btn btn-start" onClick={startTracking}>
            Start sending live location
          </button>
        ) : (
          <button className="btn btn-stop" onClick={stopTracking}>
            Stop
          </button>
        )}
      </div>

      <div className="hint-row">
        <p className="hint">
          {pendingOrigin
            ? 'Start point set — now search or tap the map for your destination.'
            : myRoute
              ? 'Route active — search or tap the map to change your destination at any time.'
              : 'Optionally search a Start point below, then search or tap the map for your destination. Skipping Start uses your live GPS position.'}
        </p>
        {(myRoute || pendingOrigin) && (
          <button className="btn btn-clear" onClick={handleClearRoute}>
            Clear route
          </button>
        )}
      </div>

      <MapView
        devices={mapDevices}
        myRoute={myRoute}
        avoidedRoute={avoidedRoute}
        onSetDestination={handleSetDestination}
        onSetOrigin={handleSetOrigin}
        pendingOrigin={pendingOrigin}
        mySocketId={socket.id}
        staleDeviceIds={staleDeviceIds}
      />

      <div className="legend">
        <span>
          <span className="swatch" style={{ background: '#3b82f6' }} /> Your route
        </span>
        <span>
          <span className="swatch" style={{ background: '#ef4444' }} /> Avoided route
        </span>
        <span>
          <span className="swatch" style={{ background: '#9ca3af' }} /> Alternatives
        </span>
        <span>
          <span className="swatch" style={{ background: '#f59e0b' }} /> Ambulance route
        </span>
      </div>

      {role === 'vehicle' && (
        <div className="nearby-card">
          <h3>Ambulances within {NEARBY_RADIUS_KM}km</h3>
          {!myPosition ? (
            <p className="nearby-empty">Start tracking to see nearby ambulances.</p>
          ) : nearbyAmbulances.length === 0 ? (
            <p className="nearby-empty">None currently within range.</p>
          ) : (
            <ul className="nearby-list">
              {nearbyAmbulances.map((a) => (
                <li key={a.id} className="nearby-item">
                  <span className="label">{a.label}</span>
                  <span className="coords">
                    {a.lat.toFixed(5)}, {a.lng.toFixed(5)}
                  </span>
                  <span className="dist">{a.distance.toFixed(2)} km</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
