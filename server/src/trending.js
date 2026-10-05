import { openRatingsDb } from './db.js';

const db = openRatingsDb();

// Create trending cache table
db.exec(`
  CREATE TABLE IF NOT EXISTS trending_cache (
    cache_key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  )
`);

const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

const getCacheStmt = db.prepare('SELECT data, fetched_at FROM trending_cache WHERE cache_key = ?');
const upsertCacheStmt = db.prepare(`
  INSERT OR REPLACE INTO trending_cache (cache_key, data, fetched_at)
  VALUES (@cache_key, @data, @fetched_at)
`);

/**
 * Get trending titles from TMDB.
 * @param {string} type - 'movie' or 'tv' (default: 'movie')
 * @param {string} timeWindow - 'day' or 'week' (default: 'week')
 * @returns {Promise<Array>} Top 20 trending titles
 */
export async function getTrending(type = 'movie', timeWindow = 'week') {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    throw new Error('TMDB_API_KEY not configured');
  }

  // Normalize type
  const mediaType = type === 'show' || type === 'tv' ? 'tv' : 'movie';
  const window = timeWindow === 'day' ? 'day' : 'week';
  const cacheKey = `trending:${mediaType}:${window}`;

  // Check cache
  const cached = getCacheStmt.get(cacheKey);
  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < CACHE_MAX_AGE_MS) {
      try {
        return JSON.parse(cached.data);
      } catch {
        // Cache corrupted, fetch fresh
      }
    }
  }

  // Fetch from TMDB
  const url = `https://api.themoviedb.org/3/trending/${mediaType}/${window}?api_key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok) {
    throw new Error(`TMDB trending API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const results = (data.results || []).slice(0, 20);

  const titleField = mediaType === 'tv' ? 'name' : 'title';
  const dateField = mediaType === 'tv' ? 'first_air_date' : 'release_date';

  const trending = results.map((item) => ({
    tmdbId: item.id,
    title: item[titleField],
    year: item[dateField] ? parseInt(item[dateField].split('-')[0], 10) : null,
    overview: item.overview,
    posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
    backdropUrl: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : null,
    rating: item.vote_average,
    voteCount: item.vote_count,
    popularity: item.popularity,
    mediaType: mediaType,
    genreIds: item.genre_ids || [],
  }));

  // Cache the results
  try {
    upsertCacheStmt.run({
      cache_key: cacheKey,
      data: JSON.stringify(trending),
      fetched_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Failed to cache trending data:', e.message);
  }

  return trending;
}
