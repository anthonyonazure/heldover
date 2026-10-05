import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Stamped into the page at build time so the running app can say which build
// it is. Worth having: this app caches itself for offline use, and a phone can
// sit on a months-old copy while the server serves the current one — which
// looks exactly like a fix that did not work.
const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['pwa-icon.svg'],
      manifest: {
        name: 'Heldover for Plex',
        short_name: 'Heldover',
        description: "Now showing: tonight's pick. Find something to watch across every Plex library you can reach.",
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'any',
        scope: '/',
        start_url: '/',
        categories: ['entertainment', 'utilities'],
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,

        // The page itself is never served from the cache. `skipWaiting` alone
        // did not save us: a stuck worker kept handing out a months-old build
        // of the app while the server was serving the new one, so every
        // front-end fix looked like it had not been made. This app is only ever
        // opened on the same network as its server, so an offline copy of the
        // page buys almost nothing and costs exactly that. Navigations go to
        // the network; the worker keeps doing the job worth doing, which is
        // holding on to poster images.
        navigateFallback: null,
        // navigateFallback alone does not keep the page out of the cache: the
        // page was still precached, and the worker answered "/" from that copy,
        // so the first visit after a deploy ran the previous build. Precaching
        // only scripts, styles and images keeps the page on the network.
        globPatterns: ['**/*.{js,css,png,svg,ico,webp,woff2}'],

        // No API caching. The previous entry never actually ran — its pattern
        // was matched against the whole address, which never begins with
        // "/api", so it silently matched nothing. Switching it on would have
        // been worse than leaving it broken: it gave up on the network after
        // five seconds, and listing libraries legitimately takes six, so it
        // would have started serving day-old library lists instead.
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    host: true,
    port: 3000,
    proxy: {
      // xfwd records each visitor's real address, so a phone on the Wi-Fi
      // using the dev server is not mistaken for this computer (the owner).
      '/api': { target: 'http://localhost:3001', xfwd: true }
    }
  }
});
