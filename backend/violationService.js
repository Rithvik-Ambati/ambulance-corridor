// violationService.js
// Detects a vehicle that stayed on a P1/P2 ambulance's immediate path after
// being given YIELD_GRACE_SECONDS to clear it, and issues a fine record.
//
// Real legal basis: Section 194E of the Motor Vehicles Act, 1988 (inserted by
// the Motor Vehicles (Amendment) Act, 2019) makes failing to give way to an
// emergency vehicle a specific offence, fine ₹10,000. That section and amount
// are real; what this module does with them is not — there is no public API
// to file a real challan, so "sending to cops" here means: logged to this
// in-memory store (GET /violations), and — ONLY if you install `nodemailer`
// and set SMTP_HOST + POLICE_NOTIFY_EMAIL in .env — actually emailed. Without
// that, every record's `sentToCops` field says so explicitly; nothing is ever
// silently claimed to have reached a real police system.

let nodemailer = null;
try {
  nodemailer = require('nodemailer'); // optional — only used if installed
} catch {
  nodemailer = null;
}

const FINE_INR = 10000;
const MV_ACT_SECTION = 'Motor Vehicles Act, 1988 — Section 194E (failing to give way to an emergency vehicle)';
const YIELD_GRACE_SECONDS = Number(process.env.YIELD_GRACE_SECONDS) || 20;
const YIELD_ZONE_METERS = Number(process.env.YIELD_ZONE_METERS) || 250;
const RE_FLAG_COOLDOWN_MS = 5 * 60 * 1000; // don't fine the same vehicle again within 5 minutes of the last fine
const MAX_VIOLATIONS = 500;

const pending = {}; // vehicleId -> { since, ambulanceId }
const flaggedRecently = {}; // vehicleId -> last-flagged timestamp
const violations = [];

function forget(vehicleId) {
  delete pending[vehicleId];
  delete flaggedRecently[vehicleId];
}

function clearConflict(vehicleId) {
  delete pending[vehicleId];
}

/**
 * Call every corridor tick for a vehicle currently sitting on an eligible
 * (P1/P2) ambulance's immediate path, within YIELD_ZONE_METERS of it.
 * Returns a violation record the moment the grace period elapses, else null.
 * `ambulance` needs { id, label, priority }.
 */
function noteConflict(vehicleId, vehicle, ambulance) {
  const now = Date.now();
  if (!pending[vehicleId] || pending[vehicleId].ambulanceId !== ambulance.id) {
    pending[vehicleId] = { since: now, ambulanceId: ambulance.id };
  }
  const elapsedSeconds = (now - pending[vehicleId].since) / 1000;
  const recentlyFlagged = flaggedRecently[vehicleId] && now - flaggedRecently[vehicleId] < RE_FLAG_COOLDOWN_MS;
  if (elapsedSeconds < YIELD_GRACE_SECONDS || recentlyFlagged) return null;

  flaggedRecently[vehicleId] = now;
  const verified = vehicle.dl?.verification?.status === 'VERIFIED';
  const violation = {
    id: violations.length + 1,
    timestamp: now,
    vehicleId,
    vehicleLabel: vehicle.label,
    dlNumber: vehicle.dl?.dlNumber || null,
    holderName: vehicle.dl?.holderName || null,
    dlVerified: verified,
    ambulanceId: ambulance.id,
    ambulanceLabel: ambulance.label,
    ambulancePriority: ambulance.priority,
    location: vehicle.lat != null && vehicle.lng != null ? { lat: vehicle.lat, lng: vehicle.lng } : null,
    graceSeconds: YIELD_GRACE_SECONDS,
    fineInr: verified ? FINE_INR : null,
    legalBasis: MV_ACT_SECTION,
    unidentified: !vehicle.dl?.dlNumber,
    sentToCops: null, // filled in by flagAndNotify
  };
  violations.push(violation);
  if (violations.length > MAX_VIOLATIONS) violations.shift();
  return violation;
}

async function flagAndNotify(violation) {
  const host = process.env.SMTP_HOST;
  const to = process.env.POLICE_NOTIFY_EMAIL;
  if (nodemailer && host && to) {
    try {
      const transport = nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
      await transport.sendMail({
        from: process.env.SMTP_FROM || 'ambulance-corridor@example.com',
        to,
        subject: `Emergency vehicle obstruction — ${violation.dlNumber || 'unidentified vehicle'} (₹${violation.fineInr ?? 'N/A'})`,
        text: JSON.stringify(violation, null, 2),
      });
      violation.sentToCops = `emailed to ${to}`;
    } catch (err) {
      violation.sentToCops = `EMAIL FAILED (${err.message}) — logged only`;
    }
  } else {
    violation.sentToCops = nodemailer
      ? 'SIMULATED — SMTP_HOST/POLICE_NOTIFY_EMAIL not configured, logged only'
      : 'SIMULATED — nodemailer is not installed (npm install nodemailer to enable email), logged only';
  }
  return violation;
}

function getAll() {
  return violations;
}

module.exports = {
  noteConflict,
  clearConflict,
  forget,
  flagAndNotify,
  getAll,
  FINE_INR,
  MV_ACT_SECTION,
  YIELD_GRACE_SECONDS,
  YIELD_ZONE_METERS,
};
