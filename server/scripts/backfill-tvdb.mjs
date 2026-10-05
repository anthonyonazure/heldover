// One-shot: discover type (movie/show) and tvdb_id for cache rows the fanart
// worker can't classify yet. After this finishes, the fanart worker uses the
// correct endpoint on the first try.
//
// CRITICAL: TMDB IDs are NOT shared between /tv/ and /movie/ namespaces, but
// both can return 200 for the same numeric id (different titles!). So we must
// VERIFY the response title matches the cached title before trusting it.
//
// Run: node scripts/backfill-tvdb.mjs (from server/ dir)
// Throttled to ~25 req/sec well under TMDB's 50/s free-tier limit.

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { openRatingsDb } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const TMDB_API_KEY = process.env.TMDB_API_KEY;
if (!TMDB_API_KEY) {
  console.error('TMDB_API_KEY missing from .env');
  process.exit(1);
}

const db = openRatingsDb();

const candidates = db.prepare(`
  SELECT plex_key, tmdb_id, title, year
  FROM ratings_cache
  WHERE tmdb_id IS NOT NULL
    AND type IS NULL
  ORDER BY fetched_at DESC
`).all();

console.log(`Candidates: ${candidates.length} rows`);
if (candidates.length === 0) process.exit(0);

const updateRow = db.prepare(`
  UPDATE ratings_cache SET
    type = @type,
    tvdb_id = @tvdb_id,
    fanart_fetched_at = CASE WHEN backdrop_url IS NULL THEN NULL ELSE fanart_fetched_at END
  WHERE plex_key = @plex_key
`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function classify(tmdbId, expectedTitle) {
  const expected = norm(expectedTitle);
  if (!expected) return null;

  // Try TV first — TMDB returns `name` on TV endpoint, plus external_ids when
  // appended. Verify the title matches the cache row before trusting it.
  try {
    const tvUrl = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    const tvRes = await fetch(tvUrl);
    if (tvRes.ok) {
      const tv = await tvRes.json();
      const titleMatch =
        norm(tv.name) === expected ||
        norm(tv.original_name) === expected;
      if (titleMatch) {
        return { type: 'show', tvdb_id: tv.external_ids?.tvdb_id || null };
      }
    }
  } catch { /* fall through */ }

  // Try movie endpoint.
  try {
    const mvUrl = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`;
    const mvRes = await fetch(mvUrl);
    if (mvRes.ok) {
      const mv = await mvRes.json();
      const titleMatch =
        norm(mv.title) === expected ||
        norm(mv.original_title) === expected;
      if (titleMatch) {
        return { type: 'movie', tvdb_id: null };
      }
    }
  } catch { /* fall through */ }

  return null;
}

let shows = 0;
let movies = 0;
let unknown = 0;
let errors = 0;
const start = Date.now();

for (let i = 0; i < candidates.length; i++) {
  const row = candidates[i];
  try {
    const result = await classify(row.tmdb_id, row.title);
    if (result?.type === 'show') {
      updateRow.run({ plex_key: row.plex_key, type: 'show', tvdb_id: result.tvdb_id });
      shows++;
    } else if (result?.type === 'movie') {
      updateRow.run({ plex_key: row.plex_key, type: 'movie', tvdb_id: null });
      movies++;
    } else {
      unknown++;
    }
  } catch {
    errors++;
  }

  if ((i + 1) % 100 === 0) {
    const elapsed = (Date.now() - start) / 1000;
    const rate = (i + 1) / elapsed;
    const remaining = (candidates.length - i - 1) / rate;
    console.log(
      `[${i + 1}/${candidates.length}] shows=${shows} movies=${movies} unknown=${unknown} errors=${errors} `
      + `(${rate.toFixed(1)}/s, ~${Math.round(remaining / 60)}m left)`
    );
  }

  await sleep(40);
}

console.log('---');
console.log(`Done. shows=${shows} movies=${movies} unknown=${unknown} errors=${errors}`);
console.log('Fanart worker will pick up the newly-typed rows on next ticks.');
