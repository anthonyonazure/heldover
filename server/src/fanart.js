import { openRatingsDb } from './db.js';

const db = openRatingsDb();

const getNextFanartRow = db.prepare(`
  SELECT plex_key, title, year, type, imdb_id, tmdb_id, tvdb_id
  FROM ratings_cache
  WHERE fanart_fetched_at IS NULL
    AND (tmdb_id IS NOT NULL OR imdb_id IS NOT NULL OR tvdb_id IS NOT NULL)
  LIMIT 1
`);

const updateFanart = db.prepare(`
  UPDATE ratings_cache SET
    backdrop_url = @backdrop_url,
    clearlogo_url = @clearlogo_url,
    fanart_fetched_at = @fanart_fetched_at
  WHERE plex_key = @plex_key
`);

const updateFanartDuplicates = db.prepare(`
  UPDATE ratings_cache SET
    backdrop_url = COALESCE(backdrop_url, @backdrop_url),
    clearlogo_url = COALESCE(clearlogo_url, @clearlogo_url),
    fanart_fetched_at = @fanart_fetched_at
  WHERE title = @title
    AND year IS @year
    AND type IS @type
    AND fanart_fetched_at IS NULL
`);

const markFanartAttempted = db.prepare(`
  UPDATE ratings_cache SET fanart_fetched_at = ? WHERE plex_key = ?
`);

const markFanartDuplicatesAttempted = db.prepare(`
  UPDATE ratings_cache
  SET fanart_fetched_at = @fanart_fetched_at
  WHERE title = @title
    AND year IS @year
    AND type IS @type
    AND fanart_fetched_at IS NULL
`);

/**
 * Pick the highest-scoring image of a given kind from a Fanart.tv response.
 * Items have a `likes` field; we prefer the one with the most likes.
 */
function pickBest(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  // English-language preferred; fall back to no-language ('00') and then anything.
  const en = items.filter((i) => i.lang === 'en');
  const noLang = items.filter((i) => i.lang === '00' || !i.lang);
  const pool = en.length ? en : noLang.length ? noLang : items;
  return pool.reduce((best, cur) => {
    const score = parseInt(cur.likes, 10) || 0;
    const bestScore = parseInt(best.likes, 10) || 0;
    return score > bestScore ? cur : best;
  }, pool[0]);
}

async function fetchFanartUrl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  return await res.json();
}

/**
 * Fetch fanart from Fanart.tv. Returns { backdropUrl, clearlogoUrl } or null.
 *
 * Movies: /v3/movies/{tmdb_id_or_imdb_id}     keys: moviebackground, hdmovielogo
 * TV:     /v3/tv/{tvdb_id}                    keys: showbackground, hdtvlogo
 *
 * If type is unknown, tries movies first then TV.
 */
async function getFanartImages(type, imdbId, tmdbId, tvdbId, apiKey) {
  const tryMovie = async () => {
    const id = tmdbId || imdbId;
    if (!id) return null;
    const data = await fetchFanartUrl(`https://webservice.fanart.tv/v3/movies/${id}?api_key=${apiKey}`);
    if (!data) return null;
    return {
      backdrop: pickBest(data.moviebackground),
      clearlogo: pickBest(data.hdmovielogo) || pickBest(data.movielogo),
    };
  };

  const tryShow = async () => {
    if (!tvdbId) return null;
    const data = await fetchFanartUrl(`https://webservice.fanart.tv/v3/tv/${tvdbId}?api_key=${apiKey}`);
    if (!data) return null;
    return {
      backdrop: pickBest(data.showbackground),
      clearlogo: pickBest(data.hdtvlogo) || pickBest(data.clearlogo),
    };
  };

  let result;
  if (type === 'movie') {
    result = await tryMovie();
  } else if (type === 'show') {
    result = await tryShow();
  } else {
    result = (await tryMovie()) || (await tryShow());
  }

  if (!result) return null;
  return {
    backdropUrl: result.backdrop?.url || null,
    clearlogoUrl: result.clearlogo?.url || null,
  };
}

let fanartTimer = null;
let fanartIdle = false;

/**
 * Background worker that drains rows missing fanart, one per tick.
 * Fanart.tv has no documented hard rate limit but we keep it polite.
 */
export function startFanartBackfill({ intervalMs = 1200 } = {}) {
  const apiKey = process.env.FANART_API_KEY;
  if (!apiKey || fanartTimer) return;

  console.log('Fanart.tv backfill worker started (1 row every', intervalMs, 'ms)');

  const tick = async () => {
    if (fanartIdle) return;
    const row = getNextFanartRow.get();
    if (!row) {
      if (!fanartIdle) {
        console.log('Fanart.tv backfill: nothing left to enrich, idling.');
        fanartIdle = true;
      }
      return;
    }

    try {
      const images = await getFanartImages(row.type, row.imdb_id, row.tmdb_id, row.tvdb_id, apiKey);
      const now = new Date().toISOString();
      if (images) {
        updateFanart.run({
          plex_key: row.plex_key,
          backdrop_url: images.backdropUrl,
          clearlogo_url: images.clearlogoUrl,
          fanart_fetched_at: now,
        });
        updateFanartDuplicates.run({
          title: row.title,
          year: row.year,
          type: row.type,
          backdrop_url: images.backdropUrl,
          clearlogo_url: images.clearlogoUrl,
          fanart_fetched_at: now,
        });
      } else {
        markFanartAttempted.run(now, row.plex_key);
        markFanartDuplicatesAttempted.run({
          title: row.title,
          year: row.year,
          type: row.type,
          fanart_fetched_at: now,
        });
      }
    } catch {
      const now = new Date().toISOString();
      markFanartAttempted.run(now, row.plex_key);
      markFanartDuplicatesAttempted.run({
        title: row.title,
        year: row.year,
        type: row.type,
        fanart_fetched_at: now,
      });
    }
  };
  fanartTimer = setInterval(() => void tick(), intervalMs);
}

export function stopFanartBackfill() {
  if (fanartTimer) {
    clearInterval(fanartTimer);
    fanartTimer = null;
  }
  // A restart (after a new key is saved) should look for work again.
  fanartIdle = false;
}
