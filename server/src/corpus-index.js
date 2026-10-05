// A searchable index of every title across every library, held in SQLite.
//
// This replaces an in-memory corpus that grew to 1.5GB of resident memory —
// enough pressure to evict unrelated things on the machine. Forty-two shared
// libraries is simply more than a film picker should keep in RAM, and none of
// the work being done with it (does this exist, what is cozy and short, deal me
// forty cards) needs the whole set present at once. They need a query.
//
// One row per title per server. Duplicates across servers are collapsed at read
// time rather than write time, because which copy is "best" depends on what the
// caller is doing.

import { openRatingsDb } from './db.js';
import { detokenizeThumb } from './plex.js';

const db = openRatingsDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS corpus_index (
    server_key TEXT NOT NULL,
    rating_key TEXT NOT NULL,
    library_key TEXT,
    title TEXT,
    title_norm TEXT,
    year INTEGER,
    type TEXT,
    thumb TEXT,
    genres TEXT,
    duration INTEGER,
    added_at INTEGER,
    view_count INTEGER DEFAULT 0,
    content_rating TEXT,
    imdb_id TEXT,
    tmdb_id TEXT,
    tvdb_id TEXT,
    indexed_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (server_key, rating_key)
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_corpus_tmdb ON corpus_index(tmdb_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_corpus_imdb ON corpus_index(imdb_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_corpus_tvdb ON corpus_index(tvdb_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_corpus_title ON corpus_index(title_norm, year)');
db.exec('CREATE INDEX IF NOT EXISTS idx_corpus_type ON corpus_index(type)');

const upsertRow = db.prepare(`
  INSERT INTO corpus_index
    (server_key, rating_key, library_key, title, title_norm, year, type, thumb, genres,
     duration, added_at, view_count, content_rating, imdb_id, tmdb_id, tvdb_id, indexed_at)
  VALUES
    (@server_key, @rating_key, @library_key, @title, @title_norm, @year, @type, @thumb, @genres,
     @duration, @added_at, @view_count, @content_rating, @imdb_id, @tmdb_id, @tvdb_id, datetime('now'))
  ON CONFLICT(server_key, rating_key) DO UPDATE SET
    title = excluded.title,
    title_norm = excluded.title_norm,
    year = excluded.year,
    type = excluded.type,
    thumb = excluded.thumb,
    genres = excluded.genres,
    duration = excluded.duration,
    added_at = excluded.added_at,
    view_count = excluded.view_count,
    content_rating = excluded.content_rating,
    imdb_id = excluded.imdb_id,
    tmdb_id = excluded.tmdb_id,
    tvdb_id = excluded.tvdb_id,
    indexed_at = datetime('now')
`);

const countRows = db.prepare('SELECT COUNT(*) AS c FROM corpus_index');

/** Same normalisation the list matcher uses, so both agree on what a title is. */
export function normalizeTitle(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/[’'`]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function guidValue(guids, prefix) {
  if (!Array.isArray(guids)) return null;
  const hit = guids.find((g) => typeof g === 'string' && g.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const nowStamp = db.prepare("SELECT datetime('now') AS now");
const deleteStale = db.prepare(
  'DELETE FROM corpus_index WHERE server_key = ? AND library_key = ? AND indexed_at < ?'
);

/**
 * Write one library's items into the index. Called by the warmer.
 *
 * The items are the library's complete current contents, so anything this
 * library held before that is not among them has been removed on the server.
 * Those rows are deleted in the same transaction; left behind, they kept
 * appearing on shelves and in swipe decks and then failed with "title not
 * found" when played. An empty list is not trusted to mean "emptied": it is
 * far more often a read that came back short, so it changes nothing.
 */
export function indexLibrary(serverKey, libraryKey, items) {
  if (!Array.isArray(items) || items.length === 0) return 0;

  const write = db.transaction((rows) => {
    const passStart = nowStamp.get().now;
    for (const row of rows) upsertRow.run(row);
    const removed = deleteStale.run(serverKey, String(libraryKey), passStart).changes;
    if (removed > 0) console.log(`[corpus] removed ${removed} titles no longer in ${serverKey}/${libraryKey}`);
  });

  const rows = items.map((item) => ({
    server_key: serverKey,
    rating_key: String(item.ratingKey),
    library_key: String(libraryKey),
    title: item.title || null,
    title_norm: normalizeTitle(item.title),
    year: item.year || null,
    type: item.type || null,
    thumb: item.thumb || null,
    genres: Array.isArray(item.genres) ? item.genres.join('|') : null,
    duration: item.duration || null,
    added_at: typeof item.addedAt === 'number' ? item.addedAt : null,
    view_count: item.viewCount || 0,
    content_rating: item.contentRating || null,
    imdb_id: guidValue(item.guids, 'imdb://'),
    tmdb_id: guidValue(item.guids, 'tmdb://'),
    tvdb_id: guidValue(item.guids, 'tvdb://'),
  }));

  write(rows);
  return rows.length;
}

/**
 * Drop every title on a server that is no longer shared with us. Only called
 * with a server list plex.tv actually returned, so a failed lookup can never
 * empty the index.
 */
export function pruneMissingServers(serverKeys) {
  const keep = [...new Set(serverKeys || [])].filter(Boolean);
  if (keep.length === 0) return 0;
  const placeholders = keep.map(() => '?').join(',');
  const removed = db.prepare(`DELETE FROM corpus_index WHERE server_key NOT IN (${placeholders})`).run(...keep).changes;
  if (removed > 0) console.log(`[corpus] removed ${removed} titles from servers no longer shared`);
  return removed;
}

/**
 * Drop the titles of libraries a server no longer lists. `listedKeys` are the
 * library keys that server has just listed (its movie and show libraries).
 * The stored copy and the written list of such a library are dropped when the
 * list is read (library-cache.js); its titles used to stay in this index, and
 * the shelves, the ask box and "do I have this?" went on returning them.
 *
 * Only called with a list the server really gave. An empty list changes
 * nothing: a server that is still starting can list nothing for a moment.
 * Rows with no library key (none are written any more) are left alone.
 */
export function pruneUnlistedLibraries(serverKey, listedKeys) {
  const keep = [...new Set((listedKeys || []).map(String))];
  if (!serverKey || keep.length === 0) return 0;
  const placeholders = keep.map(() => '?').join(',');
  const removed = db
    .prepare(`DELETE FROM corpus_index WHERE server_key = ? AND library_key IS NOT NULL AND library_key NOT IN (${placeholders})`)
    .run(String(serverKey), ...keep).changes;
  if (removed > 0) console.log(`[corpus] removed ${removed} titles of libraries that server ${serverKey} no longer lists`);
  return removed;
}

// How many libraries the index actually covers. Counted over the whole table,
// so the answer is kept for a few minutes rather than recounted per request.
let libraryCountCache = { value: 0, at: 0 };

export function indexedLibraryCount() {
  if (Date.now() - libraryCountCache.at < 5 * 60 * 1000) return libraryCountCache.value;
  try {
    const value = db
      .prepare('SELECT COUNT(*) AS c FROM (SELECT DISTINCT server_key, library_key FROM corpus_index)')
      .get().c;
    libraryCountCache = { value, at: Date.now() };
    return value;
  } catch {
    return 0;
  }
}

export function indexSize() {
  try {
    return countRows.get().c;
  } catch {
    return 0;
  }
}

function shape(row, rating) {
  return {
    ratingKey: row.rating_key,
    serverKey: row.server_key,
    libraryKey: row.library_key,
    title: row.title,
    year: row.year,
    type: row.type,
    thumb: detokenizeThumb(row.thumb),
    genres: row.genres ? row.genres.split('|') : [],
    duration: row.duration,
    addedAt: row.added_at,
    viewCount: row.view_count,
    contentRating: row.content_rating,
    imdbId: row.imdb_id,
    tmdbId: row.tmdb_id,
    imdbRating: rating?.rating ?? null,
    imdbVoteCount: rating?.votes ?? null,
  };
}

// Always filtered by type. TMDB numbers films and series separately, so the
// same id is routinely one of each (11,874 such pairs in this index), and an
// unfiltered lookup marked unrelated titles "you have this" and cast them.
const findByTmdb = db.prepare('SELECT * FROM corpus_index WHERE tmdb_id = ? AND type = ? LIMIT 1');
const findByImdb = db.prepare('SELECT * FROM corpus_index WHERE imdb_id = ? AND type = ? LIMIT 1');
const findByTitle = db.prepare('SELECT * FROM corpus_index WHERE title_norm = ? AND year = ? AND type = ? LIMIT 1');

/**
 * "Do I already have this?" for a batch of external titles.
 * @returns {Map} key `<movie|tv>:<tmdbId>` → indexed row
 */
/**
 * The external ids for titles already indexed, keyed by server and rating key.
 *
 * Some surfaces are built from their own tables and carry only what those
 * tables happen to store. "New this week" is one: it knows a title exists but
 * not that it is tmdb 24428, so anything keyed on that — a trailer, most
 * obviously — silently had nothing to work with and simply did not appear.
 */
export function externalIdsFor(pairs) {
  const out = new Map();
  if (!pairs || pairs.length === 0) return out;

  // Asked in one go rather than once per title: this runs over a hundred rows
  // every time the front page loads.
  const stmt = db.prepare(
    'SELECT server_key, rating_key, tmdb_id, imdb_id, type FROM corpus_index WHERE server_key = ? AND rating_key = ?'
  );
  for (const { serverKey, ratingKey } of pairs) {
    if (!serverKey || !ratingKey) continue;
    const row = stmt.get(String(serverKey), String(ratingKey));
    if (row) {
      out.set(`${serverKey}:${ratingKey}`, {
        tmdbId: row.tmdb_id || null,
        imdbId: row.imdb_id || null,
        type: row.type || null,
      });
    }
  }
  return out;
}

export function matchExternal(items) {
  const matches = new Map();

  for (const item of items) {
    const mediaType = item.type === 'tv' || item.type === 'show' ? 'tv' : 'movie';
    const plexType = mediaType === 'tv' ? 'show' : 'movie';
    // The caller keys its answers by TMDB id, so an item without one has no
    // slot to put a match in.
    if (!item.tmdbId) continue;

    let row = findByTmdb.get(String(item.tmdbId), plexType);
    if (!row && item.imdbId) row = findByImdb.get(String(item.imdbId), plexType);
    // Titles in scripts other than Latin normalise to nothing, and every such
    // title from the same year would then match the first one found.
    const norm = normalizeTitle(item.title);
    if (!row && norm && item.year) row = findByTitle.get(norm, item.year, plexType);
    if (!row) continue;

    matches.set(`${mediaType}:${item.tmdbId}`, shape(row));
  }

  return matches;
}

/**
 * Query the index the way the shelves and the ask box need it: only titles we
 * have a trustworthy rating for, one copy each, best first.
 *
 * The rating join is what makes this usable at all — the servers' own rating
 * fields report a flat 9.4 across thousands of unrelated titles.
 */
export function queryRated({
  genres = null,
  excludeGenres = null,
  minRuntime = null,
  maxRuntime = null,
  minRating = null,
  yearFrom = null,
  yearTo = null,
  type = null,
  excludeWatched = true,
  addedWithinDays = null,
  minVotes = 50,
  limit = 200,
} = {}) {
  const where = ['(r.imdb_rating IS NOT NULL OR r.tmdb_rating IS NOT NULL)', 'c.thumb IS NOT NULL'];
  const params = { minVotes, limit };

  where.push('(COALESCE(r.imdb_vote_count, 0) >= @minVotes OR COALESCE(r.tmdb_vote_count, 0) >= @minVotes)');

  if (type) {
    params.type = type === 'show' ? 'show' : 'movie';
    where.push('c.type = @type');
  }
  if (minRuntime) {
    params.minRuntime = minRuntime * 60 * 1000;
    where.push('c.duration >= @minRuntime');
  }
  if (maxRuntime) {
    params.maxRuntime = maxRuntime * 60 * 1000;
    where.push('c.duration <= @maxRuntime AND c.duration > 0');
  }
  if (yearFrom) {
    params.yearFrom = yearFrom;
    where.push('c.year >= @yearFrom');
  }
  if (yearTo) {
    params.yearTo = yearTo;
    where.push('c.year <= @yearTo');
  }
  if (minRating) {
    params.minRating = minRating;
    where.push('MAX(COALESCE(r.imdb_rating, 0), COALESCE(r.tmdb_rating, 0)) >= @minRating');
  }
  if (excludeWatched) {
    where.push('COALESCE(c.view_count, 0) = 0');
  }
  if (addedWithinDays) {
    params.addedAfter = Math.floor((Date.now() - addedWithinDays * 86400000) / 1000);
    where.push('c.added_at >= @addedAfter');
  }

  // Genre lists are stored pipe-joined, so membership is a LIKE against a
  // padded copy. Not elegant, but it keeps one row per title and the index
  // small, and these lists are a handful of words long.
  const genreList = Array.isArray(genres) ? genres.filter(Boolean) : [];
  if (genreList.length) {
    const clauses = genreList.map((g, i) => {
      params[`g${i}`] = `%|${g}|%`;
      return `('|' || COALESCE(c.genres, '') || '|') LIKE @g${i}`;
    });
    where.push(`(${clauses.join(' OR ')})`);
  }

  const excludeList = Array.isArray(excludeGenres) ? excludeGenres.filter(Boolean) : [];
  if (excludeList.length) {
    excludeList.forEach((g, i) => {
      params[`x${i}`] = `%|${g}|%`;
      where.push(`('|' || COALESCE(c.genres, '') || '|') NOT LIKE @x${i}`);
    });
  }

  // One copy of each film, however many servers hold it. The aggregate MAX()
  // is deliberate: SQLite takes the other columns of a grouped row from the
  // row that holds the maximum, so the copy kept is the best-rated one. A bare
  // GROUP BY used to keep whichever row it happened to land on, sometimes a
  // copy on an offline server. Titles that normalise to nothing are kept apart
  // rather than merged into one.
  const sql = `
    SELECT c.*,
           MAX(MAX(COALESCE(r.imdb_rating, 0), COALESCE(r.tmdb_rating, 0))) AS rating,
           MAX(COALESCE(r.imdb_vote_count, 0), COALESCE(r.tmdb_vote_count, 0)) AS votes
    FROM corpus_index c
    JOIN ratings_cache r
      ON r.plex_key = c.rating_key || '|' || COALESCE(c.title, '') || '|' || COALESCE(c.year, '')
    WHERE ${where.join(' AND ')}
    GROUP BY CASE WHEN c.title_norm = '' THEN c.server_key || ':' || c.rating_key ELSE c.title_norm END,
             c.year, c.type
    ORDER BY rating DESC
    LIMIT @limit
  `;

  try {
    return db
      .prepare(sql)
      .all(params)
      .map((row) => shape(row, { rating: row.rating, votes: row.votes }));
  } catch (err) {
    console.error('Corpus query failed:', err.message);
    return [];
  }
}
