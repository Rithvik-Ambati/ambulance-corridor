import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Accept requests addressed to any hostname, so the page can be opened
    // through a tunnel (https://<random>.trycloudflare.com, ngrok, etc.).
    // Dev server only — never ship this setting in a production build.
    allowedHosts: true,
    // The browser talks to the backend through THIS server: one address (and
    // so one HTTPS tunnel) covers both the page and the live socket, instead of
    // needing a second public address for port 4000. Phones need HTTPS to give
    // GPS, and an https page can't open an http://...:4000 socket.
    proxy: {
      '/socket.io': { target: 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },
})
