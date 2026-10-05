// Imported for its side effect: it widens this module's table to per-profile
// keys, and that has to happen before the statements below are prepared.
import './profiles.js';
import { openRatingsDb } from './db.js';
import { addServerKey, choiceFinder } from './server-keyed.js';

const db = openRatingsDb();

// A thumb belongs to one viewer and one title on one Plex server, because a
// rating key means a different film on each server (see server-keyed.js).
// server_key is NULL on rows saved before that was stored.
const createPersonalRatings = (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    year INTEGER,
    type TEXT,
    plex_key TEXT,
    guid TEXT,
    genres TEXT,
    rating TEXT NOT NULL CHECK(rating IN ('up', 'down')),
    rated_at TEXT DEFAULT (datetime('now')),
    profile_id INTEGER NOT NULL DEFAULT 1,
    server_key TEXT,
    UNIQUE(profile_id, server_key, plex_key)
  )
`;
db.exec(createPersonalRatings('personal_ratings'));

/** Rebuilds an older table that has no server_key. Safe to call repeatedly. */
export function migratePersonalRatings() {
  const rebuilt = addServerKey(db, {
    table: 'personal_ratings',
    createSql: createPersonalRatings,
    columns: ['id', 'title', 'year', 'type', 'plex_key', 'guid', 'genres', 'rating', 'rated_at', 'profile_id'],
  });
  // SQLite counts every NULL as different, so the key above does not stop two
  // rows without a server for the same title. This index does.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_ratings_legacy
    ON personal_ratings(profile_id, plex_key) WHERE server_key IS NULL
  `);
  return rebuilt;
}
migratePersonalRatings();

const findRows = choiceFinder(db, 'personal_ratings');
const insertRating = db.prepare(`
  INSERT INTO personal_ratings (title, year, type, plex_key, guid, genres, rating, rated_at, profile_id, server_key)
  VALUES (@title, @year, @type, @plex_key, @guid, @genres, @rating, datetime('now'), @profile_id, @server_key)
`);
// Every write stores the item's own title, year and genres. Updating only the
// thumb is what once left one film's rating filed under another film's name,
// and taught the recommendations the wrong film's genres.
const updateRating = db.prepare(`
  UPDATE personal_ratings
  SET server_key = @server_key, title = @title, year = @year, type = @type, guid = @guid,
      genres = @genres, rating = @rating, rated_at = datetime('now')
  WHERE id = @row_id
`);
const deleteRow = db.prepare('DELETE FROM personal_ratings WHERE id = ?');
const selectAll = db.prepare('SELECT * FROM personal_ratings WHERE profile_id = ? ORDER BY rated_at DESC');
const selectByRating = db.prepare('SELECT * FROM personal_ratings WHERE rating = ? AND profile_id = ? ORDER BY rated_at DESC');
const selectCountByRating = db.prepare('SELECT COUNT(*) as count FROM personal_ratings WHERE rating = ? AND profile_id = ?');

const saveRating = db.transaction((item, rating, profileId) => {
  const { key, server, own, legacy } = findRows(item, profileId);
  if (!key) throw new Error('plex_key is required');
  const values = {
    title: item.title,
    year: item.year || null,
    type: item.type || null,
    plex_key: key,
    guid: item.guid || null,
    genres: Array.isArray(item.genres) ? item.genres.join(', ') : (item.genres || null),
    rating,
    profile_id: profileId,
    server_key: server,
  };
  // The server's own row if there is one; otherwise an older row for the same
  // film takes this server (adopted, not duplicated); otherwise a new row.
  const target = own || legacy;
  if (target) updateRating.run({ ...values, row_id: target.row_id });
  else insertRating.run(values);
  if (own && legacy) deleteRow.run(legacy.row_id);
  return { plexKey: key, serverKey: server, rating };
});

/**
 * Rate an item ('up' or 'down'). `item.serverKey` (or server_key) says which
 * Plex server it is on; without it the row is filed with no server, as before.
 */
export function rateItem(item, rating, profileId = 1) {
  if (rating !== 'up' && rating !== 'down') {
    throw new Error('Rating must be "up" or "down"');
  }
  return saveRating(item, rating, profileId);
}

const deleteRating = db.transaction((item, profileId, serverKey) => {
  const { own, legacy } = findRows(item, profileId, serverKey);
  if (own) deleteRow.run(own.row_id);
  if (legacy) deleteRow.run(legacy.row_id);
  return !!(own || legacy);
});

/**
 * Remove a rating. Removes only that server's row, or the older row with no
 * server when it is the same film. Pass the item (key, title, year) so an
 * older row can be recognized; a bare key with no server removes the row with
 * no server, as before.
 */
export function removeRating(item, profileId = 1, serverKey) {
  return deleteRating(item, profileId, serverKey);
}

/**
 * Get the rating for a single item: its server's row, or else the older row
 * with no server when it is the same film.
 */
export function getRating(item, profileId = 1, serverKey) {
  const { own, legacy } = findRows(item, profileId, serverKey);
  const found = own || legacy;
  if (!found) return null;
  const row = { ...found, genres: found.genres ? found.genres.split(', ') : [] };
  delete row.row_id;
  return row;
}

/**
 * Get all rated items, optionally filtered by rating direction.
 */
export function getAllRatings(filter, profileId = 1) {
  let rows;
  if (filter === 'up' || filter === 'down') {
    rows = selectByRating.all(filter, profileId);
  } else {
    rows = selectAll.all(profileId);
  }

  return rows.map((row) => ({
    ...row,
    genres: row.genres ? row.genres.split(', ') : [],
  }));
}

/**
 * Analyze thumbs-up items and return genre frequency map.
 */
export function getLikedGenres(profileId = 1) {
  const liked = selectByRating.all('up', profileId);
  return buildGenreFrequency(liked);
}

/**
 * Analyze thumbs-down items and return genre frequency map.
 */
export function getDislikedGenres(profileId = 1) {
  const disliked = selectByRating.all('down', profileId);
  return buildGenreFrequency(disliked);
}

/**
 * Build a genre frequency map from a set of rows.
 */
function buildGenreFrequency(rows) {
  const freq = {};
  for (const row of rows) {
    if (!row.genres) continue;
    const genres = row.genres.split(', ');
    for (const g of genres) {
      const trimmed = g.trim();
      if (trimmed) {
        freq[trimmed] = (freq[trimmed] || 0) + 1;
      }
    }
  }
  return freq;
}

/**
 * Get a recommendation score modifier for an item based on personal rating patterns.
 * Returns a value from -1 to +1.
 */
export function getRecommendationBoost(item, profileId = 1) {
  const liked = getLikedGenres(profileId);
  const disliked = getDislikedGenres(profileId);

  const genres = Array.isArray(item.genres)
    ? item.genres
    : (item.genres ? item.genres.split(', ') : []);

  if (genres.length === 0) return 0;

  const totalLiked = Object.values(liked).reduce((a, b) => a + b, 0) || 1;
  const totalDisliked = Object.values(disliked).reduce((a, b) => a + b, 0) || 1;

  let likeScore = 0;
  let dislikeScore = 0;

  for (const g of genres) {
    likeScore += (liked[g] || 0) / totalLiked;
    dislikeScore += (disliked[g] || 0) / totalDisliked;
  }

  // Normalize by number of genres
  likeScore /= genres.length;
  dislikeScore /= genres.length;

  // Return a value between -1 and +1
  const boost = likeScore - dislikeScore;
  return Math.max(-1, Math.min(1, boost));
}

/**
 * Get insights about personal ratings.
 */
export function getInsights(profileId = 1) {
  const upCount = selectCountByRating.get('up', profileId).count;
  const downCount = selectCountByRating.get('down', profileId).count;

  return {
    likedGenres: getLikedGenres(profileId),
    dislikedGenres: getDislikedGenres(profileId),
    totalUp: upCount,
    totalDown: downCount,
  };
}
