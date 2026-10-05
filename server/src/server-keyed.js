// What a person decides about one title (a thumb, "not interested") is filed
// under the Plex server as well as the rating key.
//
// A rating key is only unique inside one server: each server counts from 1, so
// key 12345 is a different film on almost every server. Filed by the key
// alone, a thumb given to one film showed up on an unrelated film elsewhere,
// and hiding the second film quietly did nothing because the slot was taken.
//
// Rows saved before this have no server ("legacy" rows, server_key NULL). They
// still count, so nobody loses their thumbs: a legacy row speaks for an item
// when the key matches and the stored title and year agree with it.

/** The server key as stored, or null when the caller did not send a usable one. */
export function serverKeyOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function keyOf(item) {
  if (item && typeof item === 'object') return String(item.ratingKey || item.plex_key || item.plexKey || '');
  return String(item ?? '');
}

/**
 * Does the title stored with a row agree with this item? The year is compared
 * only where the row has one. A row saved without a title cannot be checked,
 * so the key is all there is and it counts as agreeing.
 */
export function sameFilm(row, item) {
  if (!row.title) return true;
  if (String(row.title).toLowerCase() !== String(item?.title || '').toLowerCase()) return false;
  return row.year == null || Number(row.year) === Number(item?.year);
}

/**
 * Is this stored row about this item? Pass the server the item came from;
 * items from the search index carry their own (item.serverKey).
 */
export function rowMatchesItem(row, item, serverKey) {
  if (String(row.plex_key) !== keyOf(item)) return false;
  const server = serverKeyOf(serverKey ?? item?.serverKey ?? item?.server_key);
  if (row.server_key && server) return row.server_key === server;
  // A legacy row, or a caller that does not know the server: the title decides.
  return sameFilm(row, item);
}

/**
 * A lookup that answers "is this title one of these rows?".
 *
 * Works on any rows that carry server_key, plex_key, title and year: hidden
 * titles and thumbs alike.
 */
export function titleMatcher(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = String(row.plex_key);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  return {
    size: rows.length,
    /**
     * Pass the item itself, and its server where the item does not carry one.
     * A bare key has no title to check, so it matches the server's own row or
     * any legacy row with that key.
     */
    has(item, serverKey) {
      const candidates = byKey.get(keyOf(item));
      if (!candidates) return false;
      if (item && typeof item === 'object') {
        return candidates.some((row) => rowMatchesItem(row, item, serverKey));
      }
      const server = serverKeyOf(serverKey);
      return candidates.some((row) => (row.server_key ? row.server_key === server : true));
    },
  };
}

/**
 * Finds the stored rows that speak for one item in a table keyed by
 * (profile_id, server_key, plex_key).
 *
 * Returns { key, server, own, legacy }: `own` is the row filed under the
 * item's server, `legacy` the row with no server. When the server is known the
 * legacy row is only returned if its title agrees with the item, so another
 * film's old row is never touched. A request without a server only ever sees
 * the legacy row, which is how every request behaved before servers were
 * stored.
 */
export function choiceFinder(db, table) {
  const ownRow = db.prepare(
    `SELECT rowid AS row_id, * FROM ${table} WHERE profile_id = ? AND server_key = ? AND plex_key = ?`
  );
  const legacyRow = db.prepare(
    `SELECT rowid AS row_id, * FROM ${table} WHERE profile_id = ? AND server_key IS NULL AND plex_key = ?`
  );
  return (item, profileId, serverKey) => {
    const key = keyOf(item);
    const server = serverKeyOf(serverKey ?? item?.serverKey ?? item?.server_key);
    const own = server ? ownRow.get(profileId, server, key) : undefined;
    let legacy = legacyRow.get(profileId, key);
    if (legacy && server && !sameFilm(legacy, typeof item === 'object' ? item : null)) legacy = undefined;
    return { key, server, own, legacy };
  };
}

/**
 * One-time move of a table to the (profile_id, server_key, plex_key) key.
 *
 * SQLite cannot change a UNIQUE constraint in place, so the table is rebuilt:
 * new table, copy every row, drop the old one, rename. It all happens in one
 * transaction, so a crash part way leaves the old table exactly as it was.
 * Existing rows get no server (NULL). Does nothing, and returns false, when
 * the table already has the column.
 *
 * `createSql(name)` returns the CREATE TABLE statement for the new shape;
 * `columns` are the old columns to carry across.
 */
export function addServerKey(db, { table, createSql, columns }) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (existing.length === 0 || existing.includes('server_key')) return false;

  const carried = columns.filter((c) => existing.includes(c)).join(', ');
  const rebuild = db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${table}_new`);
    db.exec(createSql(`${table}_new`));
    db.exec(`INSERT INTO ${table}_new (${carried}) SELECT ${carried} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
  });
  rebuild();
  console.log(`[server-keyed] rebuilt ${table} so choices are kept per Plex server`);
  return true;
}
