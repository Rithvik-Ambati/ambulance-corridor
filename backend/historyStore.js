// historyStore.js
// Lightweight in-memory log of reroute events. No database — resets on
// server restart, same as the rest of this demo's state. Capped so it can't
// grow unbounded over a long-running session.

const MAX_ENTRIES = 200;
const entries = [];

function record(entry) {
  entries.push({ ...entry, id: entries.length + 1, timestamp: Date.now() });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

function getAll() {
  return entries;
}

function getCount() {
  return entries.length;
}

module.exports = { record, getAll, getCount };
