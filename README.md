# Ambulance Corridor — Updated Build

Real-time GPS-based ambulance corridor system: phones stream live location,
the backend detects when a vehicle's route would cross near an ambulance
(using both the ambulance's live position AND its own route, scaled by its
speed), and pushes a genuinely-detoured Google Directions route back to that
vehicle — all shown live on Google Maps with origin/destination pins, a
search bar, and a nearby-ambulances panel.

## India-only, priority-aware, with a "failed to give way" fine flow

This build is scoped to **India only** (bounding-box check on every
origin/destination/GPS point; Directions calls biased with `region: in`;
place search restricted to India) and adds:

- **Three ambulance priority categories** (`backend/priority.js`), sent at
  registration:
  - **P1 — Critical/Life-threatening**: always gets Google's shortest route
    (never avoids anything), reroutes conflicting vehicles on a near-instant
    cooldown, and is the only priority whose ambulance-vs-ambulance conflicts
    resolve first.
  - **P2 — Urgent/Serious**: reroutes conflicting vehicles normally, and its
    own route avoids any active P1's road (gets "a bit longer" a route, per
    spec).
  - **P3 — Non-emergency/Routine**: never forces a vehicle to reroute — it
    only broadcasts a passive `ambulance-alert` advisory, and avoids both P1
    and P2's roads for its own route.
  - Ambulance route REQUESTS are queued by priority (`backend/ambulanceQueue.js`):
    P1 never waits; P2 waits for every in-flight P1 to finish; P3 waits for
    both. This is what makes "P2's route only after P1's is locked" literal.
- **India-only speed assumptions** (`backend/speedModel.js`): ambulances are
  assumed to average **60 km/h** (`AMBULANCE_SPEED_KMPH`, overridable via
  env) regardless of road; a civilian car is assumed to drive **15 km/h under
  the road's speed limit** (`SPEED_BELOW_LIMIT_KMPH`). There's no live
  per-segment speed-limit feed wired up (that needs Google's separate, paid
  Roads API) — the "limit" is **approximated** from the route's own Google
  duration/distance and clamped to a believable Indian range. Every route
  response carries `impliedSpeedLimitKmph` / `simulatedVehicleSpeedKmph` so
  this is visible, not hidden.
- **A "failed to give way" fine flow** (`backend/violationService.js` +
  `backend/dlVerificationService.js`): a vehicle that stays within 250m of a
  P1/P2 ambulance, directly on its path, for more than 20 seconds (both
  tunable) is logged with a simulated **₹10,000 fine** citing the real
  **Motor Vehicles Act, 1988 — Section 194E** (failing to give way to an
  emergency vehicle). P3 ambulances never trigger this — a civilian was never
  asked to yield to one.
  - **DL verification defaults to SIMULATION mode**: a format + presence
    check only, clearly labelled as such in every result. It's pluggable —
    set `DL_VERIFICATION_PROVIDER=decentro` plus credentials to call a real
    commercial KYC API instead, but **that integration is untested** (no
    Decentro account was available to verify it against) and falls back to
    simulation if the call fails.
  - **"Sending to cops" is simulated** (logged, retrievable at
    `GET /violations`) unless you `npm install nodemailer` and configure SMTP
    — there is no public Indian government API to submit a real challan to,
    so an automated integration can't go further than that.
  - The government/authorized route (APISetu's DL-KYC facility, or a
    DigiLocker consent flow) needs department approval this project doesn't
    have, so it isn't wired up at all.

See `.env.example` for every new environment variable.

## Deploying (one HTTPS link for the phones)

Phones only share GPS over HTTPS, and an HTTPS page can't open a plain
`http://…:4000` socket — so the built frontend is served by the backend itself,
on the same address as the socket. One service, one link.

1. **Two Google keys.** A *server* key (Directions API only; restrict by API) →
   `GOOGLE_MAPS_API_KEY`. A *browser* key (Maps JavaScript + Places; restrict to
   your site's address by HTTP referrer) → `VITE_GOOGLE_MAPS_API_KEY`. The browser key
   is baked into the page, so it must not be the server key.
2. **Push this folder to a GitHub repo** — only this project: the folder also holds
   an unrelated `waremind/` and a zip, which the root `.gitignore` excludes.
3. **Render → New → Blueprint** → pick the repo (`render.yaml` does the rest).
   Fill in the two keys when asked; `ADMIN_TOKEN` is generated for you.
4. Open the `https://….onrender.com` link on both phones.

Notes: the free plan sleeps after ~15 min idle (the first load then takes up to a
minute); all state is in memory, so a restart empties it. Operator endpoints
(`/devices`, `/history`, `/violations`, `/api-usage`) need `?token=<ADMIN_TOKEN>` in
production. `DIRECTIONS_DAILY_LIMIT` (default 1500 in `render.yaml`) stops a shared
link from spending your Directions quota. To try the same thing locally:
`npm run build` in the repo root, then `npm start`, then open `http://localhost:4000`.

Not Streamlit: Streamlit is a Python framework that re-runs a script per
interaction and has no place to run this Node/Socket.IO server or stream a phone's
GPS every second. Its hosting is Python-only, so this app can't live there.

## What changed in this pass

### Fixed
- **The detour fix was actually wired in this time.** `routingService.js` now
  genuinely forces a route via a synthetic waypoint offset to the side of the
  nearest ambulance when Google's own "alternatives" aren't clear enough —
  the helper math for this existed in `geoUtils.js` from an earlier pass but
  had never actually been connected to the routing logic. It is now.
- Google Directions API failures (bad key, quota exceeded, invalid request)
  are now detected via the response `status` field and thrown as real errors,
  instead of being silently treated the same as "no route exists."
- `register` now validates `role` — anything other than `'ambulance'` falls
  back to `'vehicle'` instead of being stored as an arbitrary string.
- The `position` handler's fallback device object (when a position arrives
  before registration) now initializes the same fields as `register` does.
- `lastCallAt` (routingService) and `lastRerouteAt` (corridorLogic) are now
  cleaned up on disconnect, instead of growing forever over a long session.
- The stale duplicate `frontend/` reference folder has been removed — only
  `frontend-app/` (the real Vite project) exists now, so there's one source
  of truth.
- `.env` is now actually git-ignored in both `backend/` and `frontend-app/`.
  **The API key that was in earlier `.env` files has been removed from this
  zip** since it was pasted in plaintext in chat — regenerate it in Cloud
  Console and paste the *new* key into both `.env` files before running.

### Added — predictive / sophistication features
- **Route-aware corridor detection.** Previously a vehicle was only checked
  against an ambulance's current *point*. Now, if the ambulance has also set
  a destination, its own route polyline is checked too — so a vehicle can be
  warned about where the ambulance is *headed*, not just where it is right
  now.
- **Speed-scaled buffer.** Each device's rough speed is estimated from
  consecutive GPS positions. A fast-moving ambulance gets a wider corridor
  buffer than a stationary one (base 150m + speed × 6 seconds of reaction
  time), broadcast to the frontend as `speedMps` on each device.
- **Reroute history.** Every reroute is logged in memory (capped at 200
  entries) with before/after clearance and whether a forced detour was
  needed. Available at `GET /history`. The frontend shows a running "N
  reroutes this session" badge.
- **Audible alert on reroute** — a short tone plays (WebAudio, no audio file
  needed) whenever your own device gets rerouted, not just a text banner.
- **Stale-device dimming** — a device that hasn't sent a position update in
  30+ seconds is shown at reduced opacity on the map instead of looking
  identically "live" forever.
- **Explicit z-index ordering** on the three route lines (ambulance route
  lowest, avoided route middle, your own route on top) so they're
  consistently distinguishable regardless of paint order.
- **Persisted client ID** (`localStorage`) sent on registration — doesn't yet
  give a refreshed device continuity of its route/history server-side (see
  Future work), but it's a stable identifier for logs/debugging going
  forward.
- **Optional registration secret.** Set `REGISTRATION_SECRET` in the
  backend's `.env` to require clients to send a matching token, so a random
  person who discovers your backend's address can't connect and pose as an
  ambulance. Left blank by default so local demos need no extra setup.
- **On-screen clearance readout** — the Status line now shows the actual
  distance (in meters) between your route and the nearest ambulance whenever
  a route is set or changed, and whether a forced detour was used, instead of
  requiring you to eyeball the map.

### Deliberately deferred (and why)
These were flagged in review but are bigger, riskier changes that don't
belong in an untested drive-by edit — each would need its own real testing
pass:
- **True session persistence across reconnects.** A refreshed phone still
  registers as a brand-new device server-side; `clientId` is sent but not yet
  used to restore a previous device's route/history. Doing this properly
  needs a reconnect-mapping layer (`clientId` → current `socket.id`) that
  changes how every handler targets a device — worth doing as its own
  focused change.
- **Real authentication / per-user accounts.** `REGISTRATION_SECRET` is a
  lightweight stopgap, not real auth. A production system needs actual
  session tokens issued server-side.
- **A database.** Everything is still in-memory and resets on restart. Adding
  SQLite/Postgres for real persistence is a reasonable next step but changes
  the deployment story (need a DB file/instance, migrations, etc.).
- **A self-hosted routing engine (OSRM/GraphHopper) with true polygon-based
  avoidance.** The waypoint-detour trick is a solid, explainable workaround
  for the fact that Google Directions has no real "avoid this point"
  parameter — but it's still a workaround. A self-hosted router would be the
  actual fix and the strongest technical differentiator, but it's a
  significant infrastructure change (running your own routing server), not a
  file edit.
- **Admin/dispatcher dashboard.** A separate read-only view showing every
  device and active corridor at once is a good demo feature but is really a
  new page/route, not a patch to the existing one.

## Setup

### 1. Backend
```bash
cd backend
npm install
cp .env.example .env
```
Edit `.env`: add your (regenerated) `GOOGLE_MAPS_API_KEY` with **Directions
API** enabled. Optionally set `REGISTRATION_SECRET`.
```bash
npm start
```

### 2. Frontend
`frontend-app/` is already a complete Vite project.
```bash
cd frontend-app
npm install
```
Edit `.env`: add your (regenerated) `VITE_GOOGLE_MAPS_API_KEY` with **Maps
JavaScript API**, **Places API**, and **Directions API** enabled.

Edit `src/socket.js` → `BACKEND_URL` to match your backend's address (your
laptop's LAN IP when testing from a phone).
```bash
npm run dev -- --host
```

### 3. Testing corridor avoidance properly
Pick a vehicle's Start and Destination on the *same road* the ambulance is
currently on, with the ambulance sitting between them — that's the only setup
that actually forces a meaningful detour to prove itself. The Status line
will show the real clearance number once a route is set.
