// priority.js
// The three ambulance dispatch categories and what each does to routing.
//
//   forcesCivilianReroute — whether a vehicle sharing this ambulance's road
//     gets actually rerouted (P1, P2), or only sees a passive advisory (P3).
//   rerouteCooldownMs — how soon a still-conflicting vehicle can be
//     rerouted again. P1 uses a near-instant cooldown ("absolute priority in
//     the MAS queue"); P2 uses the normal cooldown.
//   violationEligible — whether failing to clear this ambulance's road can
//     produce a "failed to give way" fine. P3 is routine/non-emergency, so a
//     civilian was never asked to yield and can't be faulted for not doing so.
//
// Numerically LOWER priority number = more critical = outranks a higher
// number. An ambulance only ever avoids a STRICTLY higher-priority ambulance's
// road (P1 never avoids anyone; P2 avoids P1; P3 avoids P1 and P2) — this is
// the "high priority gets the shortest possible, the other a bit longer" rule.
const PRIORITIES = {
  1: {
    key: 1,
    name: 'P1 — Critical / Life-threatening',
    description: 'Cardiac arrest, active labour, major trauma, organ/blood transport.',
    forcesCivilianReroute: true,
    rerouteCooldownMs: 3000,
    violationEligible: true,
  },
  2: {
    key: 2,
    name: 'P2 — Urgent / Serious',
    description: 'Stable fractures, moderate burns, urgent blood/lab logistics.',
    forcesCivilianReroute: true,
    rerouteCooldownMs: 15000,
    violationEligible: true,
  },
  3: {
    key: 3,
    name: 'P3 — Non-emergency / Routine',
    description: 'Scheduled transfers, discharges, routine supply runs.',
    forcesCivilianReroute: false,
    rerouteCooldownMs: null,
    violationEligible: false,
  },
};

// Used when a client registers as an ambulance without specifying a priority
// (an older client, or a raw socket call) — defaults to "assume it's real and
// reroute for it" rather than silently doing nothing, which P3 would do.
const DEFAULT_AMBULANCE_PRIORITY = 2;

function normalizePriority(p) {
  const n = Number(p);
  return PRIORITIES[n] ? n : DEFAULT_AMBULANCE_PRIORITY;
}

function infoFor(priority) {
  return PRIORITIES[priority] || PRIORITIES[DEFAULT_AMBULANCE_PRIORITY];
}

module.exports = { PRIORITIES, DEFAULT_AMBULANCE_PRIORITY, normalizePriority, infoFor };
