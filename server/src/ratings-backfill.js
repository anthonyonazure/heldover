// Fills the ratings cache for the whole library, in the background, forever.
//
// The shared servers report a flat 9.4 in their own rating fields for thousands
// of unrelated titles, so nothing in the app can rank by them. Real ratings
// have to come from TMDB, which also supplies the vote count that separates
// "genuinely acclaimed" from "one person loved it".
//
// Enrichment already happens for whatever you happen to browse. That is far too
// slow to make recommendations work — a shelf can only choose from titles it
// knows about — so this walks every cached library and fills the gaps.

import { enrichItems, ratingsKeyFor } from './ratings.js';
import { getCachedItems } from './library-cache.js';
import { getLibraries } from './plex.js';
import { openRatingsDb } from './db.js';

const db = openRatingsDb();

// TMDB tolerates far more than this; the limit that matters is being a polite
// guest on someone else's Plex server and not saturating the household's
// upstream while people are watching things.
const CHUNK_SIZE = 20;
const PAUSE_BETWEEN_CHUNKS_MS = 400;
const PAUSE_BETWEEN_LIBRARIES_MS = 2000;

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  current: null,
  librariesDone: 0,
  librariesTotal: 0,
  enriched: 0,
  skipped: 0,
  errors: 0,
};

let cancelled = false;

export function backfillStatus() {
  return { ...state, cached: countCached() };
}

function countCached() {
  try {
    return db
      .prepare(
        'SELECT COUNT(*) AS c FROM ratings_cache WHERE tmdb_rating IS NOT NULL OR imdb_rating IS NOT NULL'
      )
      .get().c;
  } catch {
    return 0;
  }
}

/** Titles we already have a real rating for; no point paying for them twice. */
function loadKnownKeys() {
  const known = new Set();
  try {
    const rows = db
      .prepare(
        'SELECT plex_key FROM ratings_cache WHERE tmdb_rating IS NOT NULL OR imdb_rating IS NOT NULL'
      )
      .all();
    for (const row of rows) known.add(String(row.plex_key));
  } catch {
    // An unreadable cache just means we re-enrich; wasteful, not wrong.
  }
  return known;
}

export function stopRatingsBackfill() {
  cancelled = true;
}

/**
 * @param {Function} getServers - returns the Plex server list
 * @param {string} token - account token, for servers with no token of their own
 */
export async function startRatingsBackfill(getServers, token) {
  if (state.running) return backfillStatus();
  if (!process.env.TMDB_API_KEY) {
    console.log('[ratings] no TMDB key configured, skipping backfill');
    return backfillStatus();
  }

  state.running = true;
  cancelled = false;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.librariesDone = 0;
  state.librariesTotal = 0;
  state.enriched = 0;
  state.skipped = 0;
  state.errors = 0;

  try {
    const servers = await getServers();
    const targets = [];

    for (const server of servers) {
      try {
        const libs = await getLibraries(server.uri, server.accessToken || token, server.connections);
        for (const lib of libs) targets.push({ server, lib });
      } catch {
        // Offline server: its libraries are not cached either.
      }
    }

    state.librariesTotal = targets.length;
    const known = loadKnownKeys();

    // Films first. A shelf of movies is what someone actually opens the app
    // for, and TV seasons are far more expensive per useful result.
    targets.sort((a, b) => (a.lib.type === 'movie' ? -1 : 1) - (b.lib.type === 'movie' ? -1 : 1));

    for (const { server, lib } of targets) {
      if (cancelled) break;
      state.current = `${server.name} / ${lib.title}`;

      const cached = getCachedItems(server.clientIdentifier, lib.key);
      const items = cached?.items || [];
      const pending = items.filter((item) => !known.has(ratingsKeyFor(item.ratingKey, item.title, item.year)));
      state.skipped += items.length - pending.length;

      for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
        if (cancelled) break;
        const chunk = pending.slice(i, i + CHUNK_SIZE);
        try {
          const enriched = await enrichItems(chunk);
          for (const item of enriched) {
            if (item && (item.tmdbRating != null || item.imdbRating != null)) {
              known.add(ratingsKeyFor(item.ratingKey, item.title, item.year));
              state.enriched += 1;
            }
          }
        } catch (err) {
          state.errors += 1;
          console.error(`[ratings] chunk failed in ${lib.title}: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_CHUNKS_MS));
      }

      state.librariesDone += 1;
      console.log(
        `[ratings] ${server.name} / ${lib.title}: ${state.enriched} rated so far (${state.librariesDone}/${state.librariesTotal} libraries)`
      );
      await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_LIBRARIES_MS));
    }
  } catch (err) {
    console.error('[ratings] backfill aborted:', err.message);
  } finally {
    state.running = false;
    state.current = null;
    state.finishedAt = new Date().toISOString();
    console.log(`[ratings] backfill finished: ${state.enriched} titles rated`);
  }

  return backfillStatus();
}
