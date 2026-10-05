// Imported for its side effect: it widens this module's table to per-profile
// keys, and that has to happen before the statements below are prepared.
import './profiles.js';
import { openRatingsDb } from './db.js';
import { addServerKey, choiceFinder, titleMatcher } from './server-keyed.js';

// Kept here as well: this is where the matcher has always been imported from.
export { titleMatcher };

const db = openRatingsDb();

// "Not interested" is a personal opinion, so it is scoped per viewer: one
// person hiding a film must not hide it from the other. It is also scoped per
// Plex server, because a rating key means a different film on each one (see
// server-keyed.js). server_key is NULL on rows saved before that was stored.
const createNotInterested = (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    plex_key TEXT,
    title TEXT,
    year INTEGER,
    type TEXT,
    marked_at TEXT DEFAULT (datetime('now')),
    profile_id INTEGER NOT NULL DEFAULT 1,
    server_key TEXT,
    UNIQUE(profile_id, server_key, plex_key)
  )
`;
db.exec(createNotInterested('not_interested'));

/** Rebuilds an older table that has no server_key. Safe to call repeatedly. */
export function migrateNotInterested() {
  const rebuilt = addServerKey(db, {
    table: 'not_interested',
    createSql: createNotInterested,
    columns: ['plex_key', 'title', 'year', 'type', 'marked_at', 'profile_id'],
  });
  // SQLite counts every NULL as different, so the key above does not stop two
  // rows without a server for the same title. This index does.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_not_interested_legacy
    ON not_interested(profile_id, plex_key) WHERE server_key IS NULL
  `);
  return rebuilt;
}
migrateNotInterested();

const findRows = choiceFinder(db, 'not_interested');
const insertNotInterested = db.prepare(`
  INSERT INTO not_interested (plex_key, title, year, type, marked_at, profile_id, server_key)
  VALUES (@plex_key, @title, @year, @type, datetime('now'), @profile_id, @server_key)
`);
// Every write stores the item's own title and year. Keeping whatever was there
// first is what once left another film's name on the row.
const updateNotInterested = db.prepare(`
  UPDATE not_interested
  SET server_key = @server_key, title = @title, year = @year, type = @type, marked_at = datetime('now')
  WHERE rowid = @row_id
`);
const deleteRow = db.prepare('DELETE FROM not_interested WHERE rowid = ?');
const selectAllNotInterested = db.prepare(
  'SELECT * FROM not_interested WHERE profile_id = ? ORDER BY marked_at DESC'
);
const selectKeys = db.prepare('SELECT server_key, plex_key, title, year FROM not_interested WHERE profile_id = ?');

// One cached key set per profile, so a filter pass does not hit the database
// once per card.
const cachedKeySets = new Map();

function refreshCache(profileId) {
  const matcher = titleMatcher(selectKeys.all(profileId));
  cachedKeySets.set(profileId, matcher);
  return matcher;
}

const saveNotInterested = db.transaction((item, profileId) => {
  const { key, server, own, legacy } = findRows(item, profileId);
  if (!key) throw new Error('plex_key is required');
  const values = {
    plex_key: key,
    title: item.title || null,
    year: item.year || null,
    type: item.type || null,
    profile_id: profileId,
    server_key: server,
  };
  // The server's own row if there is one; otherwise an older row for the same
  // film takes this server (adopted, not duplicated); otherwise a new row.
  const target = own || legacy;
  if (target) updateNotInterested.run({ ...values, row_id: target.row_id });
  else insertNotInterested.run(values);
  if (own && legacy) deleteRow.run(legacy.row_id);
  return { plexKey: key, serverKey: server };
});

/**
 * Hide a title. `item.serverKey` (or server_key) says which Plex server it is
 * on; without it the row is filed with no server, as before.
 */
export function markNotInterested(item, profileId = 1) {
  const result = saveNotInterested(item, profileId);
  cachedKeySets.delete(profileId);
  return result;
}

const removeNotInterested = db.transaction((item, profileId, serverKey) => {
  const { own, legacy } = findRows(item, profileId, serverKey);
  if (own) deleteRow.run(own.row_id);
  if (legacy) deleteRow.run(legacy.row_id);
  return !!(own || legacy);
});

/**
 * Un-hide a title. Removes only that server's row, or the older row with no
 * server when it is the same film. Pass the item (key, title, year) so an
 * older row can be recognized; a bare key with no server removes the row with
 * no server, as before.
 */
export function unmarkNotInterested(item, profileId = 1, serverKey) {
  const removed = removeNotInterested(item, profileId, serverKey);
  cachedKeySets.delete(profileId);
  return removed;
}

export function listNotInterested(profileId = 1) {
  return selectAllNotInterested.all(profileId);
}

/** Pass the item itself, and its server where the item does not carry one. */
export function isNotInterested(item, profileId = 1, serverKey) {
  const set = cachedKeySets.get(profileId) || refreshCache(profileId);
  return set.has(item, serverKey);
}

export function getNotInterestedSet(profileId = 1) {
  return cachedKeySets.get(profileId) || refreshCache(profileId);
}
