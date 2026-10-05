import { checkServerHealth, getLibraries, getLibraryItems, detokenizeThumb } from './plex.js';
import { shouldAttempt, recordFailure, recordSuccess } from './server-backoff.js';
import { applyFilters } from './filters.js';
import { openRatingsDb } from './db.js';
import { ensureServers } from './app.js';

const db = openRatingsDb();

// Create monitoring tables
db.exec(`
  CREATE TABLE IF NOT EXISTS library_status (
    server_key TEXT PRIMARY KEY,
    server_name TEXT,
    server_uri TEXT,
    is_online INTEGER DEFAULT 1,
    last_checked_at TEXT,
    last_online_at TEXT,
    went_offline_at TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS library_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_key TEXT,
    library_key TEXT,
    library_title TEXT,
    item_key TEXT,
    title TEXT,
    year INTEGER,
    type TEXT,
    genres TEXT,
    thumb TEXT,
    added_at TEXT,
    first_seen_at TEXT DEFAULT (datetime('now')),
    UNIQUE(server_key, library_key, item_key)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS saved_criteria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    criteria TEXT NOT NULL,
    notify_new INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Prepared statements
const upsertStatus = db.prepare(`
  INSERT INTO library_status (server_key, server_name, server_uri, is_online, last_checked_at, last_online_at, went_offline_at)
  VALUES (@server_key, @server_name, @server_uri, @is_online, @last_checked_at, @last_online_at, @went_offline_at)
  ON CONFLICT(server_key) DO UPDATE SET
    server_name = excluded.server_name,
    server_uri = excluded.server_uri,
    is_online = excluded.is_online,
    last_checked_at = excluded.last_checked_at,
    last_online_at = CASE WHEN excluded.is_online = 1 THEN excluded.last_online_at ELSE library_status.last_online_at END,
    went_offline_at = CASE
      WHEN library_status.is_online = 1 AND excluded.is_online = 0 THEN excluded.last_checked_at
      WHEN excluded.is_online = 1 THEN NULL
      ELSE library_status.went_offline_at
    END
`);

const getStatus = db.prepare('SELECT * FROM library_status WHERE server_key = ?');
const getAllStatuses = db.prepare('SELECT * FROM library_status');
const deleteStatus = db.prepare('DELETE FROM library_status WHERE server_key = ?');

const insertSnapshot = db.prepare(`
  INSERT OR IGNORE INTO library_snapshots
    (server_key, library_key, library_title, item_key, title, year, type, genres, thumb, added_at)
  VALUES
    (@server_key, @library_key, @library_title, @item_key, @title, @year, @type, @genres, @thumb, @added_at)
`);

// The read below filters and sorts on this one expression. With no index for
// it, every request read every row of the table and sorted them all to return
// a hundred, on the request thread, for any device that opened the front page.
// With the index a request touches only the rows it returns. Built once, the
// first time this version starts: about a fifth of a second on a table of
// 500,000 rows.
db.exec('CREATE INDEX IF NOT EXISTS idx_snapshots_recent ON library_snapshots(COALESCE(added_at, first_seen_at))');

// ---------- Keeping the table to what can be shown ----------
//
// The scan used to add a row for every item number a server had ever listed
// and nothing took a row away: a title that was removed, a library that was
// rebuilt under new item numbers, a section or a server that went away all
// stayed on file, and a rebuilt library was listed twice. The item and
// section numbers come from the server's own answers, and the server may be
// someone else's, so the size of this table was theirs to choose.
//
// What the table is for is one question: what was added lately? So it keeps
// only rows that can answer it:
//   - a dated row (the server said when it added the title) is kept while
//     that date is inside the longest window a request may ask for, and at
//     most the newest few of each library;
//   - an undated row is kept for as long as its library still lists the
//     title. Its "first seen" date is the only record that the title is not
//     new, so dropping it would show the title as new again at the next scan;
//   - any row is dropped when a complete read of its library no longer holds
//     the title, and when its server no longer lists its section.
// Nothing is dropped on the strength of a read that failed or came back
// empty, and nothing because a server is missing from the server list: a
// server that is switched off can drop off that list and come back.

/** The longest window a request may ask for, in days. The panel asks for 7. */
export const MAX_NEW_DAYS = 30;

// Dated rows kept for one library: its newest. An answer holds at most
// MAX_NEW_LIMIT (500) rows over all libraries, so every row an answer can
// hold is among the newest 2,000 of its own library, with room to spare for
// titles removed between two scans. The largest real library has about 99,000
// titles; one that was added to a server this month would otherwise put all
// of them here.
let maxDatedRowsPerLibrary = 2000;
// Rows removed in one go by the age cleanup, and the rest between two goes.
// A go of 1,000 rows took about 45 ms in a test on 500,000 rows; requests are
// answered in the gaps.
let cleanupChunkRows = 1000;
const CLEANUP_PAUSE_MS = 20;

/** For tests: limits small enough to reach with a handful of dummy rows. */
export function setSnapshotLimitsForTests({ perLibrary = maxDatedRowsPerLibrary, chunkRows = cleanupChunkRows } = {}) {
  maxDatedRowsPerLibrary = perLibrary;
  cleanupChunkRows = chunkRows;
}

// The oldest moment a dated row may carry, in the spelling the read compares
// with, so "too old to keep" and "too old to show" are the same rule.
const selectOldestKept = db.prepare("SELECT datetime('now', '-' || ? || ' days') AS oldest");
const selectSnapshotKeys = db.prepare('SELECT id, item_key, added_at FROM library_snapshots WHERE server_key = ? AND library_key = ?');
const deleteSnapshotById = db.prepare('DELETE FROM library_snapshots WHERE id = ?');
const selectSnapshotSections = db.prepare('SELECT DISTINCT library_key FROM library_snapshots WHERE server_key = ?');
const deleteSnapshotSection = db.prepare('DELETE FROM library_snapshots WHERE server_key = ? AND library_key IS ?');
const deleteOldSnapshots = db.prepare(`
  DELETE FROM library_snapshots WHERE id IN (
    SELECT id FROM library_snapshots
    WHERE added_at IS NOT NULL
      AND COALESCE(added_at, first_seen_at) < datetime('now', '-' || ? || ' days')
    LIMIT ?
  )
`);

// A Plex item number is a whole number (the rule plexId in plex-ids.js applies
// to numbers that arrive in requests). A row without one is not stored: SQLite
// does not treat two missing keys as equal, so an answer with no item number
// added its rows again at every scan, and no comparison could remove them.
const isItemNumber = (value) => /^\d{1,12}$/.test(String(value ?? ''));

/**
 * One library, after a complete read of it: add what is new, and drop the
 * rows of this library that the read no longer accounts for. Returns
 * { added, gone, old }.
 *
 * An empty answer changes nothing. It is far more often a read that came
 * back short than a library that was emptied (the same rule as indexLibrary
 * in corpus-index.js).
 */
const storeLibrary = db.transaction((serverKey, libraryKey, rows) => {
  const result = { added: 0, gone: 0, old: 0 };
  const listed = new Map();
  for (const row of rows) {
    if (isItemNumber(row.item_key)) listed.set(String(row.item_key), row);
  }
  if (listed.size === 0) return result;

  const oldestKept = selectOldestKept.get(MAX_NEW_DAYS).oldest;
  const undated = [];
  const dated = [];
  for (const [itemKey, row] of listed) {
    if (row.added_at === null) undated.push(itemKey);
    else if (row.added_at >= oldestKept) dated.push(itemKey);
  }
  // Newest first, and only the newest are kept.
  dated.sort((a, b) => (listed.get(a).added_at < listed.get(b).added_at ? 1 : listed.get(a).added_at > listed.get(b).added_at ? -1 : 0));
  const kept = new Set([...undated, ...dated.slice(0, maxDatedRowsPerLibrary)]);

  // Removed by row id, so a stored row with no item number goes too. A row
  // that carries a date too old to show goes even when its title is kept:
  // the server states a newer date now, and the insert below stores that.
  for (const { id, item_key, added_at } of selectSnapshotKeys.all(serverKey, String(libraryKey))) {
    const isListed = item_key !== null && listed.has(String(item_key));
    const tooOld = added_at !== null && added_at < oldestKept;
    if (isListed && kept.has(String(item_key)) && !tooOld) continue;
    deleteSnapshotById.run(id);
    if (isListed) result.old += 1;
    else result.gone += 1;
  }
  for (const itemKey of kept) {
    result.added += insertSnapshot.run({ ...listed.get(itemKey), item_key: itemKey }).changes;
  }
  return result;
});

/**
 * One server, after it has listed its sections: drop the rows of sections it
 * no longer lists. Returns how many rows went. An empty list removes nothing:
 * a server that is still starting can list nothing for a moment.
 */
const forgetSectionsExcept = db.transaction((serverKey, libraryKeys) => {
  if (libraryKeys.length === 0) return 0;
  const keep = new Set(libraryKeys.map(String));
  let removed = 0;
  for (const { library_key } of selectSnapshotSections.all(serverKey)) {
    if (library_key !== null && keep.has(String(library_key))) continue;
    removed += deleteSnapshotSection.run(serverKey, library_key).changes;
  }
  return removed;
});

/**
 * Drop dated rows that are older than any request may ask for. No server is
 * asked anything: the row's own date decides, and a title that is still on
 * its server loses nothing, because its date comes from the server and the
 * scan does not store a title that old again.
 *
 * The first run after this rule arrived has a whole table to go through
 * (several hundred thousand rows on a large install), so the work is done a
 * little at a time with a pause between, and one run at a time. Returns how
 * many rows went.
 */
let cleanupInFlight = null;
export function removeOldSnapshots() {
  if (!cleanupInFlight) {
    cleanupInFlight = (async () => {
      let removed = 0;
      for (;;) {
        const changes = deleteOldSnapshots.run(MAX_NEW_DAYS, cleanupChunkRows).changes;
        removed += changes;
        if (changes < cleanupChunkRows) return removed;
        await new Promise((resolve) => setTimeout(resolve, CLEANUP_PAUSE_MS));
      }
    })().finally(() => {
      cleanupInFlight = null;
    });
  }
  return cleanupInFlight;
}

// "New" means the server added it recently — not merely that we noticed it
// recently. Those are the same thing on a steady-state install, and wildly
// different the first time a library is scanned, when every title in it is
// something we have never seen before. Trusting first_seen_at alone turned a
// first scan of 42 libraries into 478,810 "new this week" items and a 196MB
// response that no browser could load.
//
// added_at is the server's own timestamp, so a 2014 film stays a 2014 film.
// It falls back to first_seen_at only for the rare item with no timestamp.

// A poster row shows a couple of dozen titles. Shipping the whole table to
// render twenty covers is the other half of why the front page stopped loading.
const DEFAULT_NEW_LIMIT = 100;
const MAX_NEW_LIMIT = 500;

const getRecentSnapshots = db.prepare(`
  SELECT * FROM library_snapshots
  WHERE COALESCE(added_at, first_seen_at) >= datetime('now', '-' || ? || ' days')
  ORDER BY COALESCE(added_at, first_seen_at) DESC
  LIMIT ?
`);

const insertCriteria = db.prepare(`
  INSERT INTO saved_criteria (name, criteria, notify_new)
  VALUES (@name, @criteria, @notify_new)
`);

const selectAllCriteria = db.prepare('SELECT * FROM saved_criteria ORDER BY created_at DESC');
const selectCriteriaById = db.prepare('SELECT * FROM saved_criteria WHERE id = ?');
const deleteCriteriaById = db.prepare('DELETE FROM saved_criteria WHERE id = ?');

/**
 * Check health of all servers, update library_status table.
 * Returns array of status objects including any that just went offline.
 *
 * The list that is probed comes from ensureServers, not from the caller. The
 * 5-minute background check hands over whatever was discovered last, which
 * could be hours old, and every address on it was sent the token again
 * without anyone asking who was there now. Taken from ensureServers, a list
 * older than a minute is discovered again first, the same rule the routes
 * follow. The caller's list is used only when no list can be had at all.
 */
export async function checkAllServers(servers, token, freshServers = ensureServers) {
  const now = new Date().toISOString();
  const results = [];

  let current = servers;
  try {
    current = (await freshServers()) || servers;
  } catch {
    // Nothing better is known right now.
  }

  for (const server of current || []) {
    // Honor backoff — skip the network call and report the cached offline status.
    if (!shouldAttempt(server.clientIdentifier)) {
      const previousStatus = getStatus.get(server.clientIdentifier);
      results.push({
        serverKey: server.clientIdentifier,
        serverName: server.name,
        serverUri: server.uri,
        online: false,
        latencyMs: null,
        lastCheckedAt: previousStatus?.last_checked_at || now,
        justWentOffline: false,
        backoff: true,
      });
      continue;
    }
    try {
      // Shared servers carry their own accessToken — sending the global account
      // token to them returns 401. Probe every connection the server list
      // kept (see trustedConnections) before declaring the server offline.
      const health = await checkServerHealth(
        server.uri,
        server.accessToken || token,
        server.connections
      );
      // "slow" means no connection answered within the probe window but at
      // least one was still trying. Shown as offline for this round, but not
      // counted towards backoff: a server that is merely slow to answer
      // should not have its libraries hidden for the length of a backoff.
      if (health.online) recordSuccess(server.clientIdentifier);
      else if (health.status !== 'slow') recordFailure(server.clientIdentifier, new Error(health.status || 'offline'));

      const previousStatus = getStatus.get(server.clientIdentifier);
      const justWentOffline =
        previousStatus && previousStatus.is_online === 1 && !health.online;

      upsertStatus.run({
        server_key: server.clientIdentifier,
        server_name: server.name,
        server_uri: server.uri,
        is_online: health.online ? 1 : 0,
        last_checked_at: now,
        last_online_at: health.online ? now : null,
        went_offline_at: null,
      });

      results.push({
        serverKey: server.clientIdentifier,
        serverName: server.name,
        serverUri: server.uri,
        online: health.online,
        latencyMs: health.latencyMs,
        lastCheckedAt: now,
        justWentOffline,
      });
    } catch (err) {
      recordFailure(server.clientIdentifier, err);
      results.push({
        serverKey: server.clientIdentifier,
        serverName: server.name,
        serverUri: server.uri,
        online: false,
        latencyMs: null,
        lastCheckedAt: now,
        justWentOffline: false,
        error: err.message,
      });
    }
  }

  return results;
}

// ---------- One round of probes, shared ----------
//
// A re-check sends a probe to every connection of every server. Any device on
// the network may ask for one, and each request used to run a round of its
// own: five requests sent together were five rounds, and each round that met
// a failing server added its own strike to the backoff. Now there is one
// round at a time and everyone who asks during it waits for that one. The
// five-minute background check goes through here as well, so a request that
// arrives while it runs joins it.
let roundInFlight = null;
let lastRound = null; // { at, statuses } or { at, error }

/**
 * Check every server, sharing the round with everyone else who asks.
 *
 * @param {Function} listServers - returns the server list (ensureServers, or the list on hand)
 * @param {string} token - account token, used when a server has no own token
 * @param {object} [options]
 * @param {number} [options.minIntervalMs] - a round that ended less than this
 *   long ago is the answer, given at once with no new probes. Left out, a
 *   round always runs (unless one is running already).
 * Returns what checkAllServers returns. Status rows of servers that left the
 * list are dropped at the end of a round, as each caller did before.
 */
export function checkAllServersShared(listServers, token, { minIntervalMs = 0 } = {}) {
  if (lastRound && Date.now() - lastRound.at < minIntervalMs) {
    // A round that failed is also not repeated at once: the caller is told
    // the same thing it would be told again.
    return lastRound.error ? Promise.reject(lastRound.error) : Promise.resolve(lastRound.statuses);
  }
  if (!roundInFlight) {
    roundInFlight = (async () => {
      try {
        const servers = await listServers();
        const statuses = await checkAllServers(servers, token);
        // The list as it is now: checkAllServers may have discovered it again.
        let listed = servers;
        try {
          listed = (await listServers()) || servers;
        } catch {
          // The list from before the round stands.
        }
        forgetServersExcept((listed || []).map((srv) => srv.clientIdentifier));
        lastRound = { at: Date.now(), statuses };
        return statuses;
      } catch (err) {
        lastRound = { at: Date.now(), error: err };
        throw err;
      } finally {
        roundInFlight = null;
      }
    })();
  }
  return roundInFlight;
}

/**
 * Scan all servers/libraries for new additions.
 * Adds the recently added titles of each library to library_snapshots and
 * drops the rows a complete read no longer accounts for (see "Keeping the
 * table to what can be shown" above).
 * Returns the newest titles of the last 7 days.
 *
 * A server that is in backoff, a section list that cannot be read and a
 * library that cannot be read are each passed over, and nothing of theirs is
 * removed.
 */
export async function scanForNewAdditions(servers, token) {
  const counts = { added: 0, gone: 0, old: 0, sections: 0 };
  // Before the libraries are read, so the per-library step below never has a
  // whole table of old rows to remove in one go.
  counts.old += await removeOldSnapshots();

  for (const server of servers) {
    if (!shouldAttempt(server.clientIdentifier)) continue;
    try {
      const serverToken = server.accessToken || token;
      const libs = await getLibraries(server.uri, serverToken, server.connections);
      recordSuccess(server.clientIdentifier);
      counts.sections += forgetSectionsExcept(server.clientIdentifier, libs.map((lib) => lib.key));
      for (const lib of libs) {
        try {
          const items = await getLibraryItems(server.uri, lib.key, serverToken, server.connections);
          const rows = items.map((item) => ({
            server_key: server.clientIdentifier,
            library_key: lib.key,
            library_title: lib.title,
            item_key: item.ratingKey,
            title: item.title,
            year: item.year || null,
            type: item.type,
            genres: item.genres ? item.genres.join(', ') : null,
            thumb: item.thumb,
            added_at: item.addedAt
              ? new Date(item.addedAt * 1000).toISOString()
              : null,
          }));
          const stored = storeLibrary(server.clientIdentifier, lib.key, rows);
          counts.added += stored.added;
          counts.gone += stored.gone;
          counts.old += stored.old;
        } catch (err) {
          console.error(
            `Error scanning ${server.name}/${lib.title}:`,
            err.message
          );
        }
      }
    } catch (err) {
      recordFailure(server.clientIdentifier, err);
      console.warn(
        `Scan failed for ${server.name} (entering backoff): ${err.message}`
      );
    }
  }

  // Counts only: a title is nobody's business in a log.
  const removed = counts.gone + counts.sections + counts.old;
  if (counts.added + removed > 0) {
    console.log(
      `[new additions] added ${counts.added} rows; removed ${removed}: ${counts.gone} for titles no longer in their library, ${counts.sections} for libraries no longer listed, ${counts.old} too old to show`
    );
  }

  // Report only a sane slice back to the caller.
  return getRecentSnapshots.all(7, DEFAULT_NEW_LIMIT);
}

/** A window in days, kept between 1 and the longest a request may ask for. */
function clampDays(days) {
  const n = Math.floor(Number(days));
  return Math.max(1, Math.min(Number.isFinite(n) && n > 0 ? n : 7, MAX_NEW_DAYS));
}

/**
 * Get new additions from the last N days (at most MAX_NEW_DAYS: rows older
 * than that are not kept).
 */
export function getNewAdditions(days = 7, limit = DEFAULT_NEW_LIMIT) {
  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_NEW_LIMIT, MAX_NEW_LIMIT));
  // Rows written before posters stopped carrying the Plex token still hold the
  // old addresses, so they are cleaned on the way out like the other stores.
  return getRecentSnapshots.all(clampDays(days), capped).map((row) => ({
    ...row,
    thumb: detokenizeThumb(row.thumb),
  }));
}

/**
 * Save a filter criteria set.
 */
export function saveCriteria(name, criteria) {
  const result = insertCriteria.run({
    name,
    criteria: JSON.stringify(criteria),
    notify_new: 1,
  });
  return { id: result.lastInsertRowid, name, criteria };
}

/**
 * Get all saved criteria.
 */
export function getSavedCriteria() {
  return selectAllCriteria.all().map((row) => ({
    ...row,
    criteria: JSON.parse(row.criteria),
  }));
}

/**
 * Delete a saved criteria by ID.
 */
export function deleteCriteria(id) {
  const result = deleteCriteriaById.run(id);
  return result.changes > 0;
}

/**
 * Get new additions that match a saved criteria set.
 * Loads criteria from DB, loads new additions, applies filters.
 */
export function getMatchingNewAdditions(criteriaId, days = 7) {
  const row = selectCriteriaById.get(criteriaId);
  if (!row) {
    throw new Error(`Criteria with id ${criteriaId} not found`);
  }

  const criteria = JSON.parse(row.criteria);
  // The statement takes a row limit as well as the window. Called with only
  // the window, it threw "too few parameter values" and every saved search
  // failed.
  const additions = getRecentSnapshots.all(clampDays(days), MAX_NEW_LIMIT);

  // Convert snapshot rows to filter-compatible items
  const items = additions.map((snap) => ({
    ...snap,
    genres: snap.genres ? snap.genres.split(', ') : [],
    thumb: detokenizeThumb(snap.thumb),
  }));

  return applyFilters(items, criteria);
}

/**
 * Drop status rows for servers no longer in the list, so the status bar stops
 * showing a server that was unshared or left out as abandoned. An empty list
 * (plex.tv unreachable) is ignored rather than wiping every row.
 */
export function forgetServersExcept(serverKeys) {
  if (!serverKeys.length) return 0;
  const keep = new Set(serverKeys);
  let removed = 0;
  for (const row of getAllStatuses.all()) {
    if (!keep.has(row.server_key)) removed += deleteStatus.run(row.server_key).changes;
  }
  return removed;
}

/**
 * Get all server statuses from DB.
 */
export function getAllServerStatuses() {
  return getAllStatuses.all().map((row) => ({
    serverKey: row.server_key,
    serverName: row.server_name,
    serverUri: row.server_uri,
    online: row.is_online === 1,
    lastCheckedAt: row.last_checked_at,
    lastOnlineAt: row.last_online_at,
    wentOfflineAt: row.went_offline_at,
  }));
}
