// Sign the picture addresses that were already in the database, once.
//
// The picture route now serves only an address the app issued, which is one
// that carries a signature (plex-images.js). Every address stored before that
// rule has none: the cached libraries, the search index, the new-additions
// table, the queue, the watchlist, episode alerts and swipe decks all hold
// copies. Left alone, every one of those posters would be refused until its
// library was read again from someone else's Plex server, and the rows that
// are never read again (a queue entry, a show someone follows) would stay
// blank for good.
//
// So at the first start with this rule, every stored address of our own is
// signed where it lies. Rows that exist at that moment are trusted because
// they were written before the rule existed. It is done once and written
// down, and after that NOTHING signs an address on the way out of the
// database. That matters: the queue, the watchlist and episode alerts hold a
// picture address that a browser sent, and signing those whenever they are
// read would let a device have any item number signed and then fetch its
// picture. From here on those tables accept only an address that is already
// validly signed (acceptedPicture in plex-images.js).
//
// What is written down is which key signed the rows, not just "done". The key
// lives in the settings file, and moving that file away to start again from
// the setup screen makes a new key. The stored addresses would then all be
// refused, the never-refreshed ones for good. So a start that finds the rows
// signed with another key signs them again. That is as sound as the first
// time: since the first time, nothing has been stored in these columns that
// was not issued or checked by the app.

import { openRatingsDb } from './db.js';
import { detokenizeThumb, pictureKeyFingerprint, proxiedImageUrl, readPictureAddress } from './plex-images.js';

const MARKER = 'picture-addresses-signed';

// Tables that hold one picture address per row, in a column.
const COLUMN_STORES = [
  ['corpus_index', 'thumb'],
  ['library_snapshots', 'thumb'],
  ['watch_later', 'thumb'],
  ['watchlist', 'thumb'],
  ['show_subscriptions', 'thumb'],
];

// Tables that hold a list of titles as JSON, each title with a `thumb`.
const JSON_STORES = [
  ['library_items_cache', 'cache_key', 'data'],
  ['swipe_sessions', 'code', 'deck'],
];

const ROWS_AT_A_TIME = 5000;

/**
 * One stored address, signed with the current key. Private to this file on
 * purpose: it signs without asking who wrote the value, which is right only
 * for rows that were in the database before anything could be refused.
 */
function signStored(thumb) {
  if (typeof thumb !== 'string') return thumb;
  // From before posters stopped carrying the Plex token: the token is dropped
  // and the result is one of our own addresses.
  if (thumb.includes('X-Plex-Token=')) return detokenizeThumb(thumb);
  const own = readPictureAddress(thumb);
  // A TMDB poster, or something that was never a working address: as it was.
  if (!own) return thumb;
  return proxiedImageUrl(own.server, own.path) || thumb;
}

/**
 * Sign every stored picture address, unless that has been done with the key
 * this install has now. Runs to the end before it returns; call it before the
 * first request is answered (index.js does, at the top of its listen
 * callback). Returns how many addresses were changed, or null when it had
 * already been done.
 */
export function signStoredPictureAddresses() {
  const db = openRatingsDb();
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS startup_markers (
        name TEXT PRIMARY KEY,
        value TEXT,
        at TEXT DEFAULT (datetime('now'))
      )
    `);
    const fingerprint = pictureKeyFingerprint();
    const done = db.prepare('SELECT value FROM startup_markers WHERE name = ?').get(MARKER);
    if (done && done.value === fingerprint) return null;

    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    let changed = 0;

    // Said before the work only when there is a lot of it, so that a start
    // that sits still for a while has its reason in the log.
    const started = Date.now();
    const titles = tableExists.get('corpus_index') ? db.prepare('SELECT COUNT(*) AS n FROM corpus_index').get().n : 0;
    if (titles > 50_000) {
      console.log('[pictures] signing the picture addresses kept in the database. This is done once and can take up to a minute for a very large library.');
    }

    for (const [table, column] of COLUMN_STORES) {
      if (!tableExists.get(table)) continue;
      const page = db.prepare(
        `SELECT rowid AS id, ${column} AS value FROM ${table}
         WHERE rowid > ? AND (${column} LIKE '/api/image?%' OR ${column} LIKE '%X-Plex-Token=%')
         ORDER BY rowid LIMIT ${ROWS_AT_A_TIME}`
      );
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      const signPage = db.transaction((rows) => {
        for (const row of rows) {
          const signed = signStored(row.value);
          if (signed === row.value) continue;
          update.run(signed, row.id);
          changed += 1;
        }
      });
      // A few thousand rows at a time, so a search index of several hundred
      // thousand titles is never held in memory at once.
      let after = 0;
      for (;;) {
        const rows = page.all(after);
        if (rows.length === 0) break;
        signPage(rows);
        after = rows[rows.length - 1].id;
      }
    }

    for (const [table, keyColumn, column] of JSON_STORES) {
      if (!tableExists.get(table)) continue;
      const keys = db.prepare(`SELECT ${keyColumn} AS key FROM ${table}`).all();
      const read = db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${keyColumn} = ?`);
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumn} = ?`);
      // One row at a time: a single cached library can be tens of megabytes.
      for (const { key } of keys) {
        let titles;
        try {
          titles = JSON.parse(read.get(key)?.value ?? 'null');
        } catch {
          // A row that cannot be read is skipped here as it is everywhere else.
          continue;
        }
        if (!Array.isArray(titles)) continue;
        let changedHere = 0;
        for (const title of titles) {
          if (!title || typeof title.thumb !== 'string') continue;
          const signed = signStored(title.thumb);
          if (signed === title.thumb) continue;
          title.thumb = signed;
          changedHere += 1;
        }
        if (changedHere === 0) continue;
        update.run(JSON.stringify(titles), key);
        changed += changedHere;
      }
    }

    // Written last. A start that is cut short before this line does the whole
    // pass again next time, which is harmless: signing a signed address gives
    // the same address.
    db.prepare("INSERT OR REPLACE INTO startup_markers (name, value, at) VALUES (?, ?, datetime('now'))").run(
      MARKER,
      fingerprint
    );
    if (changed > 0) {
      console.log(`[pictures] signed ${changed} stored picture addresses in ${Math.ceil((Date.now() - started) / 1000)}s (done once)`);
    }
    return changed;
  } finally {
    db.close();
  }
}
