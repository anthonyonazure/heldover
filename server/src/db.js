import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The desktop app passes DATA_DIR pointing at its per-user folder, because the
// installed app's own folder is read-only. Running from source keeps data
// beside the server, as before.
export const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const RATINGS_DB_PATH = join(DATA_DIR, 'ratings.db');

/**
 * Open a tuned connection to ratings.db.
 *
 * better-sqlite3 is synchronous and each call returns a fresh connection. The
 * pragmas applied here are connection-scoped (cache_size, mmap_size,
 * synchronous, temp_store) — every module that opens its own connection needs
 * them set, otherwise it falls back to the 2 MB default page cache.
 */
export function openRatingsDb() {
  const db = new Database(RATINGS_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('cache_size = -65536');     // 64 MB page cache
  db.pragma('mmap_size = 268435456');   // 256 MB memory-mapped reads
  db.pragma('synchronous = NORMAL');    // WAL-recommended default
  db.pragma('temp_store = MEMORY');
  return db;
}
