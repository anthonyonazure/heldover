// Imported for its side effect: it widens this module's table to per-profile
// keys, and that has to happen before the statements below are prepared.
import './profiles.js';
import { openRatingsDb } from './db.js';
import { acceptedPicture } from './plex-images.js';

const db = openRatingsDb();

// Create watchlist table
db.exec(`
  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    year INTEGER,
    type TEXT,
    plex_key TEXT,
    server_key TEXT,
    library_key TEXT,
    thumb TEXT,
    imdb_rating REAL,
    tmdb_rating REAL,
    rotten_tomatoes INTEGER,
    genres TEXT,
    added_at TEXT DEFAULT (datetime('now')),
    watched_at TEXT,
    notes TEXT
  )
`);


// Each person has their own list. The column is added by the profiles
// migration on databases that predate profiles; a database created fresh
// never went through that migration, so it is ensured here as well.
if (!db.prepare('PRAGMA table_info(watchlist)').all().some((c) => c.name === 'profile_id')) {
  db.exec('ALTER TABLE watchlist ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1');
}

const insertItem = db.prepare(`
  INSERT INTO watchlist (title, year, type, plex_key, server_key, library_key, thumb, imdb_rating, tmdb_rating, rotten_tomatoes, genres, notes, profile_id)
  VALUES (@title, @year, @type, @plex_key, @server_key, @library_key, @thumb, @imdb_rating, @tmdb_rating, @rotten_tomatoes, @genres, @notes, @profile_id)
`);

const deleteItem = db.prepare('DELETE FROM watchlist WHERE id = ? AND profile_id = ?');

const selectAll = db.prepare('SELECT * FROM watchlist WHERE profile_id = ? ORDER BY added_at DESC');
const selectUnwatched = db.prepare('SELECT * FROM watchlist WHERE profile_id = ? AND watched_at IS NULL ORDER BY added_at DESC');
const selectWatched = db.prepare('SELECT * FROM watchlist WHERE profile_id = ? AND watched_at IS NOT NULL ORDER BY watched_at DESC');

const updateWatched = db.prepare("UPDATE watchlist SET watched_at = datetime('now') WHERE id = ? AND profile_id = ?");

const selectByPlexKey = db.prepare('SELECT id FROM watchlist WHERE plex_key = ? AND profile_id = ? LIMIT 1');

/**
 * Add an item to the watchlist.
 * @param {object} item - { title, year, type, plex_key, server_key, library_key, thumb, imdb_rating, tmdb_rating, rotten_tomatoes, genres, notes }
 * @returns {object} The inserted row with its id
 */
export function addToWatchlist(item, profileId = 1) {
  // The picture address comes from the browser. Kept only when it is one the
  // app issued (or a TMDB poster); anything else is stored as no picture.
  const thumb = acceptedPicture(item.thumb);
  const result = insertItem.run({
    title: item.title,
    year: item.year || null,
    type: item.type || null,
    plex_key: item.plex_key || item.plexKey || null,
    server_key: item.server_key || item.serverKey || null,
    library_key: item.library_key || item.libraryKey || null,
    thumb,
    imdb_rating: item.imdb_rating || item.imdbRating || null,
    tmdb_rating: item.tmdb_rating || item.tmdbRating || null,
    rotten_tomatoes: item.rotten_tomatoes || item.rottenTomatoes || null,
    genres: Array.isArray(item.genres) ? item.genres.join(', ') : (item.genres || null),
    notes: item.notes || null,
    profile_id: profileId,
  });
  return { id: result.lastInsertRowid, ...item, thumb };
}

/**
 * Remove an item from the watchlist by id.
 * @param {number} id
 * @returns {boolean} true if deleted, false if not found
 */
export function removeFromWatchlist(id, profileId = 1) {
  const result = deleteItem.run(id, profileId);
  return result.changes > 0;
}

/**
 * Get watchlist items, optionally filtered.
 * @param {string} [filter] - 'watched', 'unwatched', or 'all' (default)
 * @returns {Array} watchlist items
 */
export function getWatchlist(filter, profileId = 1) {
  let rows;
  switch (filter) {
    case 'unwatched':
      rows = selectUnwatched.all(profileId);
      break;
    case 'watched':
      rows = selectWatched.all(profileId);
      break;
    default:
      rows = selectAll.all(profileId);
      break;
  }

  return rows.map((row) => ({
    ...row,
    genres: row.genres ? row.genres.split(', ') : [],
  }));
}

/**
 * Mark a watchlist item as watched (sets watched_at to now).
 * @param {number} id
 * @returns {boolean} true if updated, false if not found
 */
export function markWatched(id, profileId = 1) {
  const result = updateWatched.run(id, profileId);
  return result.changes > 0;
}

/**
 * Check if an item is on the watchlist by plex key.
 * @param {string} plexKey
 * @returns {boolean}
 */
export function isOnWatchlist(plexKey, profileId = 1) {
  const row = selectByPlexKey.get(plexKey, profileId);
  return !!row;
}
