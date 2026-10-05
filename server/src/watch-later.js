// Imported for its side effect: it widens this module's table to per-profile
// keys, and that has to happen before the statements below are prepared.
import './profiles.js';
import { openRatingsDb } from './db.js';
import { acceptedPicture } from './plex-images.js';

const db = openRatingsDb();

// Create watch_later table
db.exec(`
  CREATE TABLE IF NOT EXISTS watch_later (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    year INTEGER,
    type TEXT,
    plex_key TEXT,
    guid TEXT,
    server_key TEXT,
    library_key TEXT,
    thumb TEXT,
    imdb_rating REAL,
    rotten_tomatoes INTEGER,
    genres TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now')),
    notes TEXT
  )
`);


// Each person has their own list. The column is added by the profiles
// migration on databases that predate profiles; a database created fresh
// never went through that migration, so it is ensured here as well.
if (!db.prepare('PRAGMA table_info(watch_later)').all().some((c) => c.name === 'profile_id')) {
  db.exec('ALTER TABLE watch_later ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1');
}

const insertItem = db.prepare(`
  INSERT INTO watch_later (title, year, type, plex_key, guid, server_key, library_key, thumb, imdb_rating, rotten_tomatoes, genres, position, notes, profile_id)
  VALUES (@title, @year, @type, @plex_key, @guid, @server_key, @library_key, @thumb, @imdb_rating, @rotten_tomatoes, @genres, @position, @notes, @profile_id)
`);

const deleteItem = db.prepare('DELETE FROM watch_later WHERE id = ? AND profile_id = ?');
const selectAll = db.prepare('SELECT * FROM watch_later WHERE profile_id = ? ORDER BY position ASC');
const selectByPlexKey = db.prepare('SELECT id FROM watch_later WHERE plex_key = ? AND profile_id = ? LIMIT 1');
const selectMaxPosition = db.prepare('SELECT MAX(position) as max_pos FROM watch_later WHERE profile_id = ?');
const selectCount = db.prepare('SELECT COUNT(*) as count FROM watch_later WHERE profile_id = ?');
const updatePosition = db.prepare('UPDATE watch_later SET position = @position WHERE id = @id AND profile_id = @profile_id');

/**
 * Add an item to the watch later queue at the end.
 */
export function addToQueue(item, profileId = 1) {
  const maxRow = selectMaxPosition.get(profileId);
  const nextPosition = (maxRow.max_pos ?? -1) + 1;
  // The picture address comes from the browser. Kept only when it is one the
  // app issued (or a TMDB poster); anything else is stored as no picture.
  const thumb = acceptedPicture(item.thumb);

  const result = insertItem.run({
    title: item.title,
    year: item.year || null,
    type: item.type || null,
    plex_key: item.plex_key || item.plexKey || null,
    guid: item.guid || null,
    server_key: item.server_key || item.serverKey || null,
    library_key: item.library_key || item.libraryKey || null,
    thumb,
    imdb_rating: item.imdb_rating || item.imdbRating || null,
    rotten_tomatoes: item.rotten_tomatoes || item.rottenTomatoes || null,
    genres: Array.isArray(item.genres) ? item.genres.join(', ') : (item.genres || null),
    position: nextPosition,
    notes: item.notes || null,
    profile_id: profileId,
  });
  return { id: result.lastInsertRowid, position: nextPosition, ...item, thumb };
}

/**
 * Remove an item from the queue and reorder remaining positions.
 */
export function removeFromQueue(id, profileId = 1) {
  const result = deleteItem.run(id, profileId);
  if (result.changes > 0) {
    // Reorder positions to be contiguous
    const items = selectAll.all(profileId);
    const reorder = db.transaction(() => {
      items.forEach((item, index) => {
        updatePosition.run({ id: item.id, position: index, profile_id: profileId });
      });
    });
    reorder();
    return true;
  }
  return false;
}

/**
 * Get all items in the queue, ordered by position.
 */
export function getQueue(profileId = 1) {
  const rows = selectAll.all(profileId);
  return rows.map((row) => ({
    ...row,
    genres: row.genres ? row.genres.split(', ') : [],
  }));
}

/**
 * Move an item to a new position, shifting others accordingly.
 */
export function reorderQueue(id, newPosition, profileId = 1) {
  const items = selectAll.all(profileId);
  const currentIndex = items.findIndex((item) => item.id === id);
  if (currentIndex === -1) return false;

  // Remove from current position and insert at new position
  const [moved] = items.splice(currentIndex, 1);
  const clampedPos = Math.max(0, Math.min(newPosition, items.length));
  items.splice(clampedPos, 0, moved);

  // Update all positions in a transaction
  const reorder = db.transaction(() => {
    items.forEach((item, index) => {
      updatePosition.run({ id: item.id, position: index, profile_id: profileId });
    });
  });
  reorder();
  return true;
}

/**
 * Check if an item is in the queue by plex key.
 */
export function isInQueue(plexKey, profileId = 1) {
  const row = selectByPlexKey.get(plexKey, profileId);
  return !!row;
}

/**
 * Get the queue item count.
 */
export function getQueueCount(profileId = 1) {
  const row = selectCount.get(profileId);
  return row.count;
}
