import { MDBLIST_DAILY_LIMIT, checkMdblistRateLimit, db, getApiUsage } from './ratings-store.js';

/**
 * Background worker: drains rows missing MDBList data, one at a time, on a timer.
 * Keeps the request path fast (no inline backfill) while still filling the cache.
 * Stops when no more rows need backfill or the daily limit is hit.
 */
const getNextMdblistBackfillRow = db.prepare(`
  SELECT plex_key, imdb_id, tmdb_id, type, title, year
  FROM ratings_cache
  WHERE mdblist_fetched_at IS NULL
    AND (imdb_id IS NOT NULL OR tmdb_id IS NOT NULL)
  LIMIT 1
`);
const markMdblistAttempted = db.prepare(`UPDATE ratings_cache SET mdblist_fetched_at = ? WHERE plex_key = ?`);
const updateMdblistFields = db.prepare(`
  UPDATE ratings_cache SET
    imdb_rating = COALESCE(imdb_rating, @imdb_rating),
    rotten_tomatoes_score = COALESCE(rotten_tomatoes_score, @rotten_tomatoes_score),
    metacritic_score = COALESCE(metacritic_score, @metacritic_score),
    letterboxd_rating = @letterboxd_rating,
    trakt_rating = @trakt_rating,
    rt_audience_score = @rt_audience_score,
    mdblist_score = @mdblist_score,
    mdblist_fetched_at = @mdblist_fetched_at
  WHERE plex_key = @plex_key
`);

let mdblistBackfillTimer = null;
let mdblistBackfillIdle = false;

export function startMdblistBackfill({ intervalMs = 1500 } = {}) {
  const apiKey = process.env.MDBLIST_API_KEY;
  if (!apiKey || mdblistBackfillTimer) return;

  console.log('MDBList backfill worker started (1 row every', intervalMs, 'ms, daily cap', MDBLIST_DAILY_LIMIT, ')');

  const tick = async () => {
    if (mdblistBackfillIdle) return;
    const row = getNextMdblistBackfillRow.get();
    if (!row) {
      if (!mdblistBackfillIdle) {
        console.log('MDBList backfill: nothing left to enrich, idling.');
        mdblistBackfillIdle = true;
      }
      return;
    }
    if (!checkMdblistRateLimit()) return; // wait until tomorrow

    try {
      const mdb = await getMdblistRatings(row.imdb_id, row.tmdb_id, row.type, apiKey);
      const now = new Date().toISOString();
      if (mdb) {
        updateMdblistFields.run({
          plex_key: row.plex_key,
          imdb_rating: mdb.imdbFallback,
          rotten_tomatoes_score: mdb.rottenTomatoesFallback,
          metacritic_score: mdb.metacriticFallback,
          letterboxd_rating: mdb.letterboxdRating,
          trakt_rating: mdb.traktRating,
          rt_audience_score: mdb.rtAudienceScore,
          mdblist_score: mdb.mdblistScore,
          mdblist_fetched_at: now,
        });
      } else {
        markMdblistAttempted.run(now, row.plex_key);
      }
    } catch {
      // record attempt so we don't loop on the same broken row
      markMdblistAttempted.run(new Date().toISOString(), row.plex_key);
    }
  };
  mdblistBackfillTimer = setInterval(() => void tick(), intervalMs);
}

export function stopMdblistBackfill() {
  if (mdblistBackfillTimer) {
    clearInterval(mdblistBackfillTimer);
    mdblistBackfillTimer = null;
  }
  mdblistBackfillIdle = false;
}

export function getMdblistUsageStats() {
  const today = new Date().toISOString().split('T')[0];
  const row = getApiUsage.get('mdblist');
  if (!row || row.last_reset !== today) {
    return { dailyCount: 0, limit: MDBLIST_DAILY_LIMIT, remaining: MDBLIST_DAILY_LIMIT, resetDate: today };
  }
  return {
    dailyCount: row.daily_count,
    limit: MDBLIST_DAILY_LIMIT,
    remaining: Math.max(0, MDBLIST_DAILY_LIMIT - row.daily_count),
    resetDate: row.last_reset,
  };
}

/**
 * Pull aggregated ratings from MDBList: Letterboxd, Trakt, RT audience, and the
 * site's own composite score. Falls back to filling in IMDb / Metacritic / RT-critic
 * if OMDB didn't return them.
 *
 * Endpoint: GET https://api.mdblist.com/?apikey=KEY&i=tt0133093
 *           or &tm=603 (TMDB movie) / &tvdb=... / &tmdbid=...&m=show
 */
export async function getMdblistRatings(imdbId, tmdbId, type, apiKey) {
  if (!imdbId && !tmdbId) return null;

  const params = new URLSearchParams({ apikey: apiKey });
  if (imdbId) {
    params.set('i', imdbId);
  } else if (type === 'show') {
    params.set('tmdbid', String(tmdbId));
    params.set('m', 'show');
  } else {
    params.set('tm', String(tmdbId));
  }

  const url = `https://api.mdblist.com/?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;

  const data = await res.json();
  if (!data || data.error) return null;

  const ratings = Array.isArray(data.ratings) ? data.ratings : [];
  const byKey = (key) => ratings.find((r) => r && r.source === key);

  const lb = byKey('letterboxd');
  const trakt = byKey('trakt');
  const tomatoesAud = byKey('tomatoesaudience');
  const tomatoes = byKey('tomatoes');
  const meta = byKey('metacritic');
  const imdb = byKey('imdb');

  const num = (v) => {
    if (v == null || v === '' || v === 'N/A') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    letterboxdRating: lb ? num(lb.value) : null,
    traktRating: trakt ? num(trakt.value) : null,
    rtAudienceScore: tomatoesAud ? num(tomatoesAud.value) : null,
    rottenTomatoesFallback: tomatoes ? num(tomatoes.value) : null,
    metacriticFallback: meta ? num(meta.value) : null,
    imdbFallback: imdb ? num(imdb.value) : null,
    mdblistScore: data.score != null ? Math.round(Number(data.score)) : null,
  };
}
