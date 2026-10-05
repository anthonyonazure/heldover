import 'dotenv/config';
import './env-check.js';
import { downloadsEnabled } from './config.js';
import { requestGuard } from './auth.js';
import { accessGate, registerSetupRoutes } from './setup-routes.js';
import { changeGate } from './change-gate.js';
import { securityHeaders } from './security-headers.js';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getServers } from './plex.js';
import { stopMdblistBackfill, stopTmdbKeywordBackfill, startMdblistBackfill, startTmdbKeywordBackfill, enrichItems } from './ratings.js';
import { stopFanartBackfill, startFanartBackfill } from './fanart.js';
import { setCachedItems } from './library-cache.js';
import { warmLibraries } from './library-warmer.js';
import { startRatingsBackfill } from './ratings-backfill.js';

// Early on purpose: settings saved from the setup screen are copied into the
// environment here, before any other module reads it.

const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

export const app = express();
export const PORT = process.env.PORT || 3001;

// Express announces itself in X-Powered-By by default; there is no reason to
// tell every visitor what framework this is.
app.disable('x-powered-by');

// No CORS middleware, on purpose. Every page this server serves calls it from
// its own origin (the phones, the Electron window and the Vite dev proxy all
// do), so the only thing an "allow every origin" header ever enabled was other
// websites. With it, any page open on any device in the house could read the
// API's answers and send it JSON commands.
// Behind a reverse proxy, say so with TRUST_PROXY (for example "1" for one
// proxy hop, or "loopback"), so the real client address is used for lockouts
// and the https flag on cookies. Off by default: trusting forwarded headers
// that nobody strips would let any device claim any address.
if (process.env.TRUST_PROXY) {
  const value = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value === 'true' ? true : value);
}

// Harden every answer: no framing, no content-type guessing, no referrer
// leak. Set before any route so it covers the pages and the API alike.
app.use(securityHeaders);

app.use(express.json());
// Refuse requests addressed to foreign domains, and state changes sent from
// other sites, before anything else looks at them.
app.use('/api', requestGuard);

// The optional access PIN guards the app's data. The page itself still loads,
// so it can ask for the PIN.
app.use('/api', accessGate);

// Looking is open to the home network; changing anything needs the PIN or the
// owner. One rule for every route, present and future.
app.use('/api', changeGate);

registerSetupRoutes(app, {
  onKeysChanged: () => {
    stopMdblistBackfill();
    stopTmdbKeywordBackfill();
    stopFanartBackfill();
    startMdblistBackfill();
    startTmdbKeywordBackfill();
    startFanartBackfill();
  },
  // A Plex account linked from the setup screen takes effect at once: forget
  // the server list and start reading libraries, rather than waiting for a
  // restart that a Docker user may never think to do.
  onPlexConnected: () => {
    cachedServers = null;
    cachedServersAt = 0;
    setTimeout(() => {
      warmLibraries(ensureServers, process.env.PLEX_TOKEN).catch((err) =>
        console.error('Warm-up after sign-in failed:', err.message)
      );
    }, 2000);
    setTimeout(() => {
      startRatingsBackfill(ensureServers, process.env.PLEX_TOKEN).catch((err) =>
        console.error('Ratings backfill after sign-in failed:', err.message)
      );
    }, 60 * 1000);
  },
});

// Downloading whole files from a shared server copies someone else's library,
// so it is off unless the owner of this install turns it on in Settings.
app.use(['/api/download-url', '/api/download'], (req, res, next) => {
  if (downloadsEnabled()) return next();
  res.status(403).json({ error: 'Downloads are turned off. They can be turned on in Settings.', downloadsDisabled: true });
});

// In-memory cache for server/library discovery (refreshed on demand)
export let cachedServers = null;
let cachedServersAt = 0;

// Server discovery (plex.tv resources + per-server connection probing) is slow,
// so cache it briefly. Shared servers appearing/disappearing are still picked up
// within the TTL, or sooner via ?refresh=true (see the interval below).
const SERVER_CACHE_TTL_MS = 60_000;

// How long after one forced discovery (?refresh=true) the next one is honored.
// A forced request skips the freshness test, and any device that may look can
// send one. With nothing between two of them, every such request asked plex.tv
// with the owner's account token and then every address of every Plex server,
// shared ones included: five requests, five discoveries. Inside this time a
// forced request is handled like any other, so it gets the list on hand at
// once and no error.
//
// Chosen against what one discovery costs: 4 to 6 seconds for the owner,
// because it asks every server. That leaves the servers alone at least three
// times as long as they were kept busy. The time is counted from the end of
// the discovery, so a slow one (plex.tv is given 15 seconds, a dead address
// 5) is not followed at once by the next. It is also a third of the 60
// seconds after which the list is read again anyway, so a refresh that is
// skipped gets a list at most 20 seconds old when the discovery before it
// worked.
const FORCED_DISCOVERY_MIN_INTERVAL_MS = 20_000;
let lastForcedAt = 0;

/**
 * A count from a query string, kept between 1 and a ceiling. parseInt of "-1"
 * is -1, which slipped past a plain Math.min and reached SQLite as LIMIT -4,
 * meaning no limit: the whole 480,000-title index loaded into memory, and on
 * the shelves every poster in it queued for download.
 */
export function clampCount(raw, fallback, max) {
  const n = parseInt(raw, 10);
  return Math.max(1, Math.min(Number.isFinite(n) && n > 0 ? n : fallback, max));
}

export function getPlexToken() {
  const token = process.env.PLEX_TOKEN;
  if (!token) throw new Error('PLEX_TOKEN not configured');
  return token;
}

/**
 * Helper: ensure cachedServers is populated and fresh (within TTL).
 * Pass force=true to bypass the cache and re-discover. A forced discovery is
 * honored once per FORCED_DISCOVERY_MIN_INTERVAL_MS; inside that time the
 * call is handled as a plain one.
 */
// One discovery at a time. Every poster on a page used to start its own when
// the cache expired, which is dozens of identical plex.tv calls at once.
let serversInFlight = null;

export async function ensureServers(force = false) {
  const now = Date.now();
  const fresh = cachedServers && now - cachedServersAt < SERVER_CACHE_TTL_MS;
  const forced = force && now - lastForcedAt >= FORCED_DISCOVERY_MIN_INTERVAL_MS;
  if (!forced && fresh) return cachedServers;
  // Noted at the start as well as at the end (below), so a second forced
  // request that arrives while this one is waiting is already inside the
  // interval.
  if (forced) lastForcedAt = now;
  if (!serversInFlight) {
    serversInFlight = (async () => {
      try {
        cachedServers = await getServers(getPlexToken());
        cachedServersAt = Date.now();
        return cachedServers;
      } catch (err) {
        // Said once for the discovery, here, and not once for every request
        // that was waiting for it.
        if (cachedServers) console.error('Server discovery failed, keeping the last known list:', err.message);
        throw err;
      } finally {
        serversInFlight = null;
      }
    })();
  }
  try {
    return await serversInFlight;
  } catch (err) {
    // plex.tv down or the token expired: the servers we knew a minute ago
    // are still the best answer, and failing here blanks every poster.
    //
    // Decided for each caller, not once for the discovery. Every request that
    // arrives while a discovery runs shares it, and the request that started
    // it used to decide what all of them got: one forced request in flight
    // took the last known list away from every page and every poster that
    // had joined it. Only a caller whose own forced discovery was honored is
    // told that it failed; it asked for a fresh list and there is none.
    if (cachedServers && !forced) return cachedServers;
    throw err;
  } finally {
    if (forced) lastForcedAt = Date.now();
  }
}

/**
 * Enrich a library's items with ratings in the background, then cache the
 * enriched result. Rating enrichment hits rate-limited external APIs and can
 * take minutes for large libraries, so callers return raw Plex items first and
 * let this fill in ratings. Guarded so the same library isn't enriched twice at once.
 */
const enrichInFlight = new Set();
export function enrichInBackground(serverKey, libraryKey, items) {
  const key = `${serverKey}:${libraryKey}`;
  if (enrichInFlight.has(key)) return;
  enrichInFlight.add(key);
  void (async () => {
    try {
      const enriched = await enrichItems(items);
      setCachedItems(serverKey, libraryKey, enriched);
      console.log(`Background enrich complete: ${enriched.length} items for ${key}`);
    } catch (err) {
      console.error(`Background enrich failed for ${key}:`, err.message);
    } finally {
      enrichInFlight.delete(key);
    }
  })();
}
