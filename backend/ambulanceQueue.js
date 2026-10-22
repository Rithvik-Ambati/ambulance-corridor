// ambulanceQueue.js
// Route-computation ordering by priority: "Absolute priority in the MAS
// queue" for P1, "gets the next fastest parallel route only after P1 paths
// are locked" for P2, and P3 waits for both. This is a route-computation
// ORDER, not a real multi-agent scheduler — a P1 request never waits; a P2
// request waits for every currently in-flight P1 request to finish; a P3
// request waits for every in-flight P1 AND P2 request to finish.
//
// Event-driven, not polling: `done()` synchronously wakes any waiter that can
// now proceed. Polling on a timer left a real race here (a P3 request could
// slip through during the few milliseconds between a P1 finishing and a
// waiting P2 waking up to claim its slot) — since Node runs one thing at a
// time, doing the whole "check and reserve" step synchronously closes it.
const inFlight = { 1: 0, 2: 0, 3: 0 };
const waiters = []; // { priority, resolve }

function canProceed(priority) {
  if (priority === 1) return true;
  if (priority === 2) return inFlight[1] === 0;
  return inFlight[1] === 0 && inFlight[2] === 0;
}

// Grants a slot to every waiter that can now proceed, in the order they
// arrived, re-scanning after each grant (a granted P1... well P1 never waits,
// but a granted P2 can unblock nothing new for P3 immediately — still, this
// keeps the logic simple and correct without needing to reason about it).
function wakeWaiters() {
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < waiters.length; i++) {
      if (canProceed(waiters[i].priority)) {
        const [w] = waiters.splice(i, 1);
        inFlight[w.priority]++;
        w.resolve();
        progressed = true;
        break;
      }
    }
  }
}

// Resolves once it's this priority's turn, and reserves a slot at the same
// moment (both happen synchronously, so nothing can slip in between). Always
// pair with done(priority) — ideally in a finally block.
function waitTurn(priority) {
  if (canProceed(priority)) {
    inFlight[priority]++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push({ priority, resolve }));
}

function done(priority) {
  if (inFlight[priority] != null) inFlight[priority] = Math.max(0, inFlight[priority] - 1);
  wakeWaiters();
}

function snapshot() {
  return { ...inFlight, waiting: waiters.length };
}

module.exports = { waitTurn, done, snapshot };
