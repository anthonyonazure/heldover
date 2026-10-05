import { openRatingsDb } from './db.js';
// From the concern file, not the plex.js facade: plex-library.js keeps the
// list of listed libraries here, and the facade would make the two files
// import each other.
import { detokenizeThumb } from './plex-images.js';

const db = openRatingsDb();

// Cache library items — one row per item per library
db.exec(`
  CREATE TABLE IF NOT EXISTS library_items_cache (
    cache_key TEXT NOT NULL,
    data TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (cache_key)
  )
`);

// The libraries the app lists for each server (its movie and show libraries),
// written down so the answer to "may this library be read?" survives a restart
// and a server that is offline. plex-library.js decides; this file keeps the
// record.
db.exec(`
  CREATE TABLE IF NOT EXISTS listed_libraries (
    server_key TEXT NOT NULL,
    library_key TEXT NOT NULL,
    PRIMARY KEY (server_key, library_key)
  )
`);

const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

const getCache = db.prepare('SELECT data, item_count, fetched_at FROM library_items_cache WHERE cache_key = ?');
const upsertCache = db.prepare(`
  INSERT OR REPLACE INTO library_items_cache (cache_key, data, item_count, fetched_at)
  VALUES (@cache_key, @data, @item_count, @fetched_at)
`);
const deleteCache = db.prepare('DELETE FROM library_items_cache WHERE cache_key = ?');
const deleteAll = db.prepare('DELETE FROM library_items_cache');

const selectListed = db.prepare('SELECT library_key FROM listed_libraries WHERE server_key = ?');
const deleteListed = db.prepare('DELETE FROM listed_libraries WHERE server_key = ?');
const insertListed = db.prepare('INSERT OR IGNORE INTO listed_libraries (server_key, library_key) VALUES (?, ?)');
// Every stored library of one server: cache keys are "<server>:<library>", so
// they sit between "<server>:" and "<server>;" (the character after a colon).
const selectCacheKeysOfServer = db.prepare('SELECT cache_key FROM library_items_cache WHERE cache_key >= ? AND cache_key < ?');
const replaceListed = db.transaction((serverKey, keys) => {
  deleteListed.run(serverKey);
  for (const key of keys) insertListed.run(serverKey, key);
  // A stored copy of a section that is not listed must not stay on file. Until
  // the list was checked, a request could name any section (a photo or music
  // one included) and have it stored here, and one route reads this table
  // without asking Plex. An empty answer throws nothing away: a server that is
  // still starting can list nothing for a moment, and re-reading every library
  // because of it is expensive. The routes that check the list still refuse.
  if (keys.length === 0) return 0;
  const wanted = new Set(keys.map((key) => `${serverKey}:${key}`));
  let dropped = 0;
  for (const row of selectCacheKeysOfServer.all(`${serverKey}:`, `${serverKey};`)) {
    if (wanted.has(row.cache_key)) continue;
    deleteCache.run(row.cache_key);
    dropped += 1;
  }
  return dropped;
});

const selectListedServers = db.prepare('SELECT DISTINCT server_key FROM listed_libraries');
const selectAllCacheKeys = db.prepare('SELECT cache_key FROM library_items_cache');
const forgetAllBut = db.transaction((keep) => {
  const gone = new Map(); // server key -> what was removed for it
  const removedFor = (serverKey) => {
    if (!gone.has(serverKey)) gone.set(serverKey, { serverKey, listed: 0, stored: 0 });
    return gone.get(serverKey);
  };
  for (const row of selectListedServers.all()) {
    if (keep.has(row.server_key)) continue;
    removedFor(row.server_key).listed = deleteListed.run(row.server_key).changes;
  }
  for (const row of selectAllCacheKeys.all()) {
    // Cache keys are "<server>:<library>". A key of any other shape is left alone.
    const at = row.cache_key.lastIndexOf(':');
    if (at <= 0) continue;
    const serverKey = row.cache_key.slice(0, at);
    if (keep.has(serverKey)) continue;
    deleteCache.run(row.cache_key);
    removedFor(serverKey).stored += 1;
  }
  return [...gone.values()];
});

/**
 * Forget every server that is not in `serverKeys`: its written list of
 * libraries and its stored libraries. A stored library used to outlive the
 * share it came from: rows are otherwise removed only when that same server
 * lists its sections again, and a server that is gone is never asked again,
 * so its libraries stayed readable for good.
 *
 * Call it only with the servers plex.tv named in an answer it really gave
 * (see getServers in plex-servers.js), never with a list kept from earlier
 * and never with the servers that happen to be reachable: a server that is
 * only switched off must keep its stored libraries. An empty list changes
 * nothing; it is not trusted to mean "every server is gone". Running it
 * again removes nothing more.
 *
 * Returns one { serverKey, listed, stored } per server forgotten: how many
 * libraries were on its written list and how many stored copies it had.
 */
export function forgetServersNotIn(serverKeys) {
  const keep = new Set((Array.isArray(serverKeys) ? serverKeys : []).filter(Boolean).map(String));
  if (keep.size === 0) return [];
  return forgetAllBut(keep);
}

/**
 * The library keys last written down as listed for a server. Empty when no
 * list has been seen for it.
 */
export function getListedLibraryKeys(serverKey) {
  return selectListed.all(String(serverKey)).map((row) => row.library_key);
}

/**
 * Write down the libraries a server lists, and drop stored copies of any
 * section of that server that is not among them. Returns how many were dropped.
 */
export function saveListedLibraryKeys(serverKey, keys) {
  return replaceListed(String(serverKey), keys.map(String));
}

/**
 * Get cached library items.
 * Returns { items, fromCache, stale, itemCount, cachedAt } or null if not cached at all.
 * Stale data (expired) is still returned with stale: true so callers can serve it
 * while triggering a background refresh.
 */
export function getCachedItems(serverKey, libraryKey) {
  const key = `${serverKey}:${libraryKey}`;
  const row = getCache.get(key);
  if (!row) return null;

  const age = Date.now() - new Date(row.fetched_at).getTime();
  const stale = age > CACHE_MAX_AGE_MS;

  try {
    const items = stripTokensFromThumbs(JSON.parse(row.data));
    return { items, fromCache: true, stale, itemCount: row.item_count, cachedAt: row.fetched_at };
  } catch {
    return null;
  }
}

function stripTokensFromThumbs(items) {
  if (!Array.isArray(items)) return items;
  for (const item of items) {
    if (item) item.thumb = detokenizeThumb(item.thumb);
  }
  return items;
}

/**
 * Check if cache for a specific library is stale (expired but still present).
 * Returns true if cache exists but is older than CACHE_MAX_AGE_MS.
 * Returns false if cache is fresh or doesn't exist.
 */
export function isCacheStale(serverKey, libraryKey) {
  const key = `${serverKey}:${libraryKey}`;
  const row = getCache.get(key);
  if (!row) return false;

  const age = Date.now() - new Date(row.fetched_at).getTime();
  return age > CACHE_MAX_AGE_MS;
}

/**
 * Store library items in cache.
 */
export function setCachedItems(serverKey, libraryKey, items) {
  const key = `${serverKey}:${libraryKey}`;
  upsertCache.run({
    cache_key: key,
    data: JSON.stringify(items),
    item_count: items.length,
    fetched_at: new Date().toISOString(),
  });
}

/**
 * Invalidate cache for a specific library.
 */
export function invalidateCache(serverKey, libraryKey) {
  const key = `${serverKey}:${libraryKey}`;
  deleteCache.run(key);
}

/**
 * Invalidate all caches.
 */
export function invalidateAllCaches() {
  deleteAll.run();
}
