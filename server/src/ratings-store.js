import { openRatingsDb } from './db.js';

export const db = openRatingsDb();

// Create cache table
db.exec(`
  CREATE TABLE IF NOT EXISTS ratings_cache (
    plex_key TEXT PRIMARY KEY,
    title TEXT,
    year INTEGER,
    tmdb_id INTEGER,
    tmdb_rating REAL,
    tmdb_vote_count INTEGER,
    imdb_id TEXT,
    imdb_rating REAL,
    rotten_tomatoes_score INTEGER,
    metacritic_score INTEGER,
    poster_url TEXT,
    fetched_at TEXT
  )
`);

// Migration: add MDBList columns if missing (idempotent)
const existingCols = new Set(db.prepare(`PRAGMA table_info(ratings_cache)`).all().map((r) => r.name));
const addCol = (name, def) => {
  if (!existingCols.has(name)) db.exec(`ALTER TABLE ratings_cache ADD COLUMN ${name} ${def}`);
};
addCol('letterboxd_rating', 'REAL');
addCol('trakt_rating', 'INTEGER');
addCol('rt_audience_score', 'INTEGER');
addCol('mdblist_score', 'INTEGER');
addCol('mdblist_fetched_at', 'TEXT');
addCol('type', 'TEXT');
addCol('tvdb_id', 'INTEGER');
addCol('imdb_vote_count', 'INTEGER');
addCol('tmdb_keywords', 'TEXT');
addCol('tmdb_language', 'TEXT');
addCol('tmdb_countries', 'TEXT');
addCol('backdrop_url', 'TEXT');
addCol('clearlogo_url', 'TEXT');
addCol('fanart_fetched_at', 'TEXT');

// Indexes: title+year is hit on every cross-library cache lookup. Without this,
// every plex_key miss does a full scan over the ratings_cache table.
db.exec(`CREATE INDEX IF NOT EXISTS idx_ratings_title_year ON ratings_cache(title, year)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_ratings_imdb_id ON ratings_cache(imdb_id) WHERE imdb_id IS NOT NULL`);

// Truncate WAL on startup if it has grown large (>32 MB). Idle WALs that big
// slow every read because SQLite has to scan them for un-checkpointed pages.
try {
  db.pragma('wal_checkpoint(TRUNCATE)');
} catch { /* best effort */ }

// Create API usage tracking table for rate limiting
db.exec(`
  CREATE TABLE IF NOT EXISTS api_usage (
    api_name TEXT PRIMARY KEY,
    daily_count INTEGER DEFAULT 0,
    last_reset TEXT
  )
`);

/**
 * The key a title's ratings are filed under.
 *
 * It used to be the Plex rating key alone. That number is only unique inside
 * one server: each server counts from 1, so with forty-odd shared libraries
 * key 12345 is a different film on almost every server. Whichever was rated
 * first owned the slot, and every other film with that number was shown its
 * score (measured: 35,000 of 425,000 rated titles). Title and year are part
 * of the key now, so a slot can only ever hold the film it was fetched for.
 */
export function ratingsKeyFor(ratingKey, title, year) {
  return `${ratingKey}|${title || ''}|${year ?? ''}`;
}

// One-time move of the old single-number keys to the new form. The title and
// year stored beside each row are the film its ratings were fetched for, so
// the rewrite is exact and needs no network.
db.exec(`
  UPDATE ratings_cache
  SET plex_key = plex_key || '|' || COALESCE(title, '') || '|' || COALESCE(year, '')
  WHERE instr(plex_key, '|') = 0
`);

export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const OMDB_DAILY_LIMIT = parseInt(process.env.OMDB_DAILY_LIMIT || '950', 10); // Default 950, set to 95000 for Patreon tier
export const MDBLIST_DAILY_LIMIT = parseInt(process.env.MDBLIST_DAILY_LIMIT || '1000', 10); // Free tier: 1000/day

export const getCache = db.prepare('SELECT * FROM ratings_cache WHERE plex_key = ?');
export const getCacheByTitle = db.prepare('SELECT * FROM ratings_cache WHERE title = ? AND year = ? LIMIT 1');
export const getCacheByTitleType = db.prepare('SELECT * FROM ratings_cache WHERE title = ? AND year = ? AND type = ? LIMIT 1');
export const upsertCache = db.prepare(`
  INSERT OR REPLACE INTO ratings_cache
    (plex_key, title, year, tmdb_id, tmdb_rating, tmdb_vote_count, imdb_id, imdb_rating, imdb_vote_count, rotten_tomatoes_score, metacritic_score, poster_url, fetched_at,
     letterboxd_rating, trakt_rating, rt_audience_score, mdblist_score, mdblist_fetched_at,
     type, tvdb_id, tmdb_keywords, tmdb_language, tmdb_countries, backdrop_url, clearlogo_url, fanart_fetched_at)
  VALUES
    (@plex_key, @title, @year, @tmdb_id, @tmdb_rating, @tmdb_vote_count, @imdb_id, @imdb_rating, @imdb_vote_count, @rotten_tomatoes_score, @metacritic_score, @poster_url, @fetched_at,
     @letterboxd_rating, @trakt_rating, @rt_audience_score, @mdblist_score, @mdblist_fetched_at,
     @type, @tvdb_id, @tmdb_keywords, @tmdb_language, @tmdb_countries, @backdrop_url, @clearlogo_url, @fanart_fetched_at)
`);

export const getApiUsage = db.prepare('SELECT daily_count, last_reset FROM api_usage WHERE api_name = ?');
const upsertApiUsage = db.prepare(`
  INSERT INTO api_usage (api_name, daily_count, last_reset)
  VALUES (@api_name, @daily_count, @last_reset)
  ON CONFLICT(api_name) DO UPDATE SET
    daily_count = excluded.daily_count,
    last_reset = excluded.last_reset
`);

export const getNextKeywordBackfillRow = db.prepare(`
  SELECT plex_key, tmdb_id, type
  FROM ratings_cache
  WHERE tmdb_keywords IS NULL
    AND tmdb_id IS NOT NULL
    AND type IN ('movie', 'show')
  LIMIT 1
`);
export const updateKeywordFields = db.prepare(`
  UPDATE ratings_cache
  SET tmdb_keywords = @tmdb_keywords,
      tmdb_language = @tmdb_language,
      tmdb_countries = @tmdb_countries
  WHERE plex_key = @plex_key
`);

/**
 * Check and increment the daily OMDB API usage counter.
 * Resets the counter if the day has changed.
 * Returns true if the call is allowed, false if limit exceeded.
 */
export function checkOmdbRateLimit() {
  const today = new Date().toISOString().split('T')[0];
  const row = getApiUsage.get('omdb');

  if (!row || row.last_reset !== today) {
    upsertApiUsage.run({ api_name: 'omdb', daily_count: 1, last_reset: today });
    return true;
  }

  if (row.daily_count >= OMDB_DAILY_LIMIT) {
    return false;
  }

  upsertApiUsage.run({ api_name: 'omdb', daily_count: row.daily_count + 1, last_reset: today });
  return true;
}

export function checkMdblistRateLimit() {
  const today = new Date().toISOString().split('T')[0];
  const row = getApiUsage.get('mdblist');

  if (!row || row.last_reset !== today) {
    upsertApiUsage.run({ api_name: 'mdblist', daily_count: 1, last_reset: today });
    return true;
  }

  if (row.daily_count >= MDBLIST_DAILY_LIMIT) {
    return false;
  }

  upsertApiUsage.run({ api_name: 'mdblist', daily_count: row.daily_count + 1, last_reset: today });
  return true;
}
