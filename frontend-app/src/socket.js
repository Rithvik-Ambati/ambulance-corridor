// src/socket.js
import { io } from 'socket.io-client';

// Connects to the SAME address that served this page; the Vite dev server
// forwards /socket.io to the backend on :4000 (see vite.config.js). That works
// unchanged on localhost, on the LAN, and through an HTTPS tunnel, so there is
// no IP to edit. Set VITE_BACKEND_URL in .env only if the backend runs elsewhere.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || undefined;

export const socket = io(BACKEND_URL, {
  autoConnect: true,
});

// A stable per-browser identity, persisted across refreshes. Not a full
// reconnect-session system (the backend still treats each socket connection
// as a fresh device today — see README "Future work") but it's enough to
// tell devices apart in logs/history even after a page reload.
export function getClientId() {
  let id = localStorage.getItem('ambulance-corridor-client-id');
  if (!id) {
    id = `client-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    localStorage.setItem('ambulance-corridor-client-id', id);
  }
  return id;
}
