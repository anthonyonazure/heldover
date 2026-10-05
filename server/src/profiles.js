// Viewer profiles.
//
// Two people share this app and they do not have the same taste. Blending both
// sets of thumbs into one score produces recommendations that suit neither —
// the average of "loves horror" and "hates horror" is a shrug. Everything
// personal (thumbs, not-interested, the queue, the watchlist) is therefore
// scoped to whoever is watching.
//
// Identity belongs in the key. The original tables made plex_key unique on its
// own, which silently means "one opinion per title, globally". The migration
// below widens that to (profile_id, plex_key) so two people can disagree.

import { openRatingsDb } from './db.js';

const db = openRatingsDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    emoji TEXT,
    color TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const listStmt = db.prepare('SELECT * FROM profiles ORDER BY id');
const getStmt = db.prepare('SELECT * FROM profiles WHERE id = ?');
const insertStmt = db.prepare('INSERT INTO profiles (name, emoji, color) VALUES (?, ?, ?)');
const updateStmt = db.prepare('UPDATE profiles SET name = ?, emoji = ?, color = ? WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM profiles WHERE id = ?');

/**
 * Tables that hold "what this person thinks", and how they must stay unique.
 * The first two are widened again, to one row per Plex server, by the modules
 * that own them (see server-keyed.js).
 */
const SCOPED_TABLES = [
  { table: 'personal_ratings', unique: ['profile_id', 'plex_key'] },
  { table: 'not_interested', unique: ['profile_id', 'plex_key'] },
  { table: 'watch_later', unique: null },
  { table: 'watchlist', unique: null },
];

function hasColumn(table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch {
    return false;
  }
}

function tableExists(table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}

/**
 * Give every personal table a profile_id, and re-point its uniqueness at
 * (profile_id, plex_key). SQLite cannot alter a constraint in place, so the
 * tables that carry one are rebuilt: new table, copy, swap. Existing rows
 * become profile 1, which is whoever was using the app before profiles existed.
 */
function migrateScopedTables() {
  for (const { table, unique } of SCOPED_TABLES) {
    if (!tableExists(table) || hasColumn(table, 'profile_id')) continue;

    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const columnNames = columns.map((c) => c.name);

    if (!unique) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_profile ON ${table}(profile_id)`);
      console.log(`[profiles] added profile_id to ${table}`);
      continue;
    }

    // Rebuild: same columns plus profile_id, with the widened unique key.
    const defs = columns.map((c) => {
      let def = `${c.name} ${c.type || 'TEXT'}`;
      if (c.pk && c.type && c.type.toUpperCase() === 'INTEGER' && c.name === 'id') {
        def += ' PRIMARY KEY AUTOINCREMENT';
      }
      if (c.notnull && !c.pk) def += ' NOT NULL';
      if (c.dflt_value != null) {
        // PRAGMA hands back expression defaults unwrapped — `datetime('now')`
        // rather than `(datetime('now'))` — and SQLite refuses to accept them
        // that way in a CREATE. Literals must stay unwrapped.
        const raw = String(c.dflt_value);
        const isLiteral = /^(-?\d+(\.\d+)?|'.*'|NULL|CURRENT_(DATE|TIME|TIMESTAMP))$/i.test(raw);
        def += ` DEFAULT ${isLiteral ? raw : `(${raw})`}`;
      }
      return def;
    });
    defs.push('profile_id INTEGER NOT NULL DEFAULT 1');

    const rebuild = db.transaction(() => {
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
      db.exec(
        `CREATE TABLE ${table} (\n  ${defs.join(',\n  ')},\n  UNIQUE(${unique.join(', ')})\n)`
      );
      db.exec(
        `INSERT INTO ${table} (${columnNames.join(', ')}, profile_id)
         SELECT ${columnNames.join(', ')}, 1 FROM ${table}_old`
      );
      db.exec(`DROP TABLE ${table}_old`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_profile ON ${table}(profile_id)`);
    });

    rebuild();
    console.log(`[profiles] rebuilt ${table} with per-profile uniqueness`);
  }
}

// Runs at import, not at boot. The modules that own these tables prepare their
// statements the moment they are imported, so an old-shaped table has to be
// widened before any of them get a look at it — which means this module must be
// imported ahead of them.
migrateScopedTables();

/** Seeds the default profiles. Safe to call repeatedly. */
export function initProfiles(seedNames = ['Me']) {
  // One starter profile, renamed on the setup screen ("Who watches here?").
  if (listStmt.all().length === 0) {
    const palette = [
      { emoji: '🎬', color: '#F59E0B' },
      { emoji: '🎨', color: '#EC4899' },
    ];
    seedNames.forEach((name, i) => {
      const look = palette[i % palette.length];
      insertStmt.run(name, look.emoji, look.color);
    });
    console.log(`[profiles] created ${seedNames.join(' and ')}`);
  }

  return listProfiles();
}

export function listProfiles() {
  return listStmt.all();
}

export function getProfile(id) {
  return getStmt.get(id) || null;
}

export function createProfile(name, emoji = '🍿', color = '#38BDF8') {
  const info = insertStmt.run(name, emoji, color);
  knownIds = null;
  return getProfile(info.lastInsertRowid);
}

export function updateProfile(id, { name, emoji, color }) {
  const existing = getProfile(id);
  if (!existing) return null;
  updateStmt.run(name ?? existing.name, emoji ?? existing.emoji, color ?? existing.color, id);
  return getProfile(id);
}

export function deleteProfile(id) {
  // Profile 1 is the account the app was set up with; deleting it would orphan
  // every row that predates profiles.
  if (Number(id) === 1) throw new Error('The first profile cannot be deleted');
  // A person's thumbs, hides and lists go with them. Left behind, they sat in
  // the database for good with no profile to belong to.
  const remove = db.transaction(() => {
    for (const { table } of SCOPED_TABLES) {
      if (tableExists(table)) db.prepare(`DELETE FROM ${table} WHERE profile_id = ?`).run(id);
    }
    return deleteStmt.run(id).changes > 0;
  });
  const removed = remove();
  knownIds = null;
  return removed;
}

/**
 * Whose data is this request about? The client sends it as a header so every
 * existing endpoint can become profile-aware without changing its URL.
 */
// The ids that exist, held so this per-request check is not a query each time.
let knownIds = null;

export function profileIdFrom(req) {
  const raw = req.get?.('X-Profile-Id') || req.query?.profileId || req.body?.profileId;
  const id = parseInt(raw, 10);
  // A phone can remember a profile that has since been deleted. Its thumbs
  // and hides were being filed under that dead id; they now go to the first
  // profile, which is also what the phone falls back to showing.
  if (!knownIds) knownIds = new Set(listStmt.all().map((p) => p.id));
  return Number.isFinite(id) && knownIds.has(id) ? id : 1;
}
