// Generic TMDB-extras cache: cast lists, trailer keys, anything keyed by
// (kind, mediaType, tmdbId). Stored as JSON blobs; cheap to extend.

import { openRatingsDb } from './db.js';

const db = openRatingsDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS tmdb_extras_cache (
    cache_key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  )
`);

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const getCache = db.prepare('SELECT data, fetched_at FROM tmdb_extras_cache WHERE cache_key = ?');
const upsertCache = db.prepare(`
  INSERT OR REPLACE INTO tmdb_extras_cache (cache_key, data, fetched_at)
  VALUES (?, ?, ?)
`);

function freshCache(key) {
  const row = getCache.get(key);
  if (!row) return null;
  const age = Date.now() - new Date(row.fetched_at).getTime();
  if (age > CACHE_TTL_MS) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

// Cleanup. A row is stored for every different title someone looks at, and
// the id comes from the address of the request, so the number of rows was
// decided by whoever was asking: nothing ever removed one, and a row past its
// seven days was skipped when read but stayed on disk. Two rules now. A row
// older than seven days is deleted (it was no longer used as an answer, so no
// answer changes). And the table holds at most MAX_ROWS: above that the
// oldest go first. 20,000 is 10,000 titles with both a cast list and a
// trailer looked up inside one week, far more than a household opens.
let maxRows = 20_000;
// Checked once every this many stored answers, and once at startup.
let sweepEvery = 200;

const deleteExpired = db.prepare('DELETE FROM tmdb_extras_cache WHERE fetched_at < ?');
const countRows = db.prepare('SELECT COUNT(*) AS n FROM tmdb_extras_cache');
// rowid breaks a tie between answers stored in the same millisecond: a row
// written again gets a new rowid, so this is the order they were written in.
const deleteOldest = db.prepare(`
  DELETE FROM tmdb_extras_cache WHERE cache_key IN (
    SELECT cache_key FROM tmdb_extras_cache ORDER BY fetched_at ASC, rowid ASC LIMIT ?
  )
`);
let writesSinceSweep = 0;

/**
 * Deletes stored answers that are past their seven days, then the oldest ones
 * above the row limit. Works from the rows' own dates and their count, nothing
 * else, so running it again straight away removes nothing more.
 */
export function sweepExtrasCache() {
  try {
    const expired = deleteExpired.run(new Date(Date.now() - CACHE_TTL_MS).toISOString()).changes;
    const over = countRows.get().n - maxRows;
    const overLimit = over > 0 ? deleteOldest.run(over).changes : 0;
    if (expired || overLimit) {
      console.log(
        `[tmdb-extras] removed ${expired} stored cast and trailer answers older than 7 days` +
          (overLimit ? `, and the ${overLimit} oldest to stay within ${maxRows}` : '')
      );
    }
    return { expired, overLimit };
  } catch (err) {
    console.error('[tmdb-extras] cleanup failed:', err.message);
    return { expired: 0, overLimit: 0 };
  }
}

// Once at startup, so rows left by earlier versions are cleaned up too.
sweepExtrasCache();

/** For tests: limits small enough to reach. */
export function setLimitsForTests(rows, every) {
  maxRows = rows;
  sweepEvery = every;
  writesSinceSweep = 0;
}

function writeCache(key, value) {
  upsertCache.run(key, JSON.stringify(value), new Date().toISOString());
  if (++writesSinceSweep < sweepEvery) return;
  writesSinceSweep = 0;
  sweepExtrasCache();
}

function tmdbMediaType(type) {
  return type === 'show' ? 'tv' : 'movie';
}

/**
 * Top cast for a TMDB title — name, character, profile image. Used for the
 * cast row in the detail modal.
 */
export async function getCast(type, tmdbId, limit = 8) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || !tmdbId) return [];

  const mediaType = tmdbMediaType(type);
  const cacheKey = `cast:${mediaType}:${tmdbId}`;
  const cached = freshCache(cacheKey);
  if (cached) return cached;

  const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/credits?api_key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const data = await res.json();
  const cast = (data.cast || []).slice(0, limit).map((c) => ({
    name: c.name,
    character: c.character || null,
    profileUrl: c.profile_path
      ? `https://image.tmdb.org/t/p/w185${c.profile_path}`
      : null,
  }));
  writeCache(cacheKey, cast);
  return cast;
}

/**
 * Best YouTube trailer key for a TMDB title. Prefers official + trailer type +
 * highest-resolution + most-recent. Returns null when nothing usable exists.
 */
export async function getTrailerKey(type, tmdbId) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || !tmdbId) return null;

  const mediaType = tmdbMediaType(type);
  const cacheKey = `trailer:${mediaType}:${tmdbId}`;
  const cached = freshCache(cacheKey);
  if (cached !== null) return cached.key || null;

  const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/videos?api_key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  // Nothing is stored for an answer that is not a real one. An id TMDB does
  // not know used to leave a "no trailer" row for every different number
  // anyone asked about, and a "slow down" or an error from TMDB was stored the
  // same way, which hid a real trailer for seven days. A title TMDB knows
  // that has no trailer is still remembered below, so it is not asked again.
  if (!res.ok) return null;
  const data = await res.json();
  const youtube = (data.results || []).filter((v) => v.site === 'YouTube');

  const score = (v) =>
    (v.official ? 100 : 0) +
    (v.type === 'Trailer' ? 50 : v.type === 'Teaser' ? 25 : 0) +
    (v.size || 0) / 100;

  const best = youtube.sort((a, b) => score(b) - score(a))[0];
  const key = best ? best.key : null;
  writeCache(cacheKey, { key });
  return key;
}
