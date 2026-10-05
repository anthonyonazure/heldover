import { CACHE_MAX_AGE_MS, checkMdblistRateLimit, checkOmdbRateLimit, getCache, getCacheByTitle, getCacheByTitleType, ratingsKeyFor, upsertCache } from './ratings-store.js';
import { getTmdbExternalIds, getTmdbSearchMetadata, searchTmdb, titleLooksLikeMatch, yearLooksLikeMatch } from './ratings-tmdb.js';
import { getMdblistRatings } from './ratings-mdblist.js';

/**
 * Get ratings from OMDB (IMDB, Rotten Tomatoes, Metacritic).
 */
async function getOmdbRatings(imdbId, title, apiKey) {
  const params = new URLSearchParams({ apikey: apiKey });

  if (imdbId) {
    params.set('i', imdbId);
  } else {
    params.set('t', title);
  }

  const url = `https://www.omdbapi.com/?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok) return null;

  const data = await res.json();
  if (data.Response === 'False') return null;

  let rottenTomatoes = null;
  let metacritic = null;
  let imdbRating = null;
  let imdbVoteCount = null;

  // Parse IMDB rating
  if (data.imdbRating && data.imdbRating !== 'N/A') {
    imdbRating = parseFloat(data.imdbRating);
  }

  if (data.imdbVotes && data.imdbVotes !== 'N/A') {
    const parsedVotes = parseInt(String(data.imdbVotes).replace(/,/g, ''), 10);
    if (Number.isFinite(parsedVotes)) imdbVoteCount = parsedVotes;
  }

  // Parse Metascore
  if (data.Metascore && data.Metascore !== 'N/A') {
    metacritic = parseInt(data.Metascore, 10);
  }

  // Parse Rotten Tomatoes from Ratings array
  if (data.Ratings) {
    const rt = data.Ratings.find(
      (r) => r.Source === 'Rotten Tomatoes'
    );
    if (rt && rt.Value) {
      rottenTomatoes = parseInt(rt.Value.replace('%', ''), 10);
    }
  }

  return {
    imdbRating,
    imdbVoteCount,
    rottenTomatoes,
    metacritic,
    imdbId: data.imdbID || imdbId,
  };
}

// TMDB returns vote_average=10 for obscure titles with a single 10/10 rating.
// Below this many votes, the value is noise and we suppress it at display time.
// Truth stays in the cache so we can revisit the threshold later.
const TMDB_MIN_VOTES = 10;

function trustedTmdb(rating, voteCount) {
  if (rating == null) return null;
  if (voteCount != null && voteCount < TMDB_MIN_VOTES) return null;
  return rating;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function shapeCached(row) {
  const tmdbRating = trustedTmdb(row.tmdb_rating, row.tmdb_vote_count);
  return {
    tmdbRating,
    rawTmdbRating: row.tmdb_rating,
    tmdbRatingLowConfidence: row.tmdb_rating != null && tmdbRating == null,
    tmdbVoteCount: row.tmdb_vote_count,
    imdbRating: row.imdb_rating,
    imdbVoteCount: row.imdb_vote_count,
    rottenTomatoes: row.rotten_tomatoes_score,
    metacritic: row.metacritic_score,
    imdbId: row.imdb_id,
    tmdbId: row.tmdb_id,
    tvdbId: row.tvdb_id ?? null,
    tmdbKeywords: parseJsonArray(row.tmdb_keywords),
    tmdbLanguage: row.tmdb_language ?? null,
    tmdbCountries: parseJsonArray(row.tmdb_countries),
    posterUrl: row.poster_url,
    letterboxdRating: row.letterboxd_rating ?? null,
    traktRating: row.trakt_rating ?? null,
    rtAudienceScore: row.rt_audience_score ?? null,
    mdblistScore: row.mdblist_score ?? null,
    backdropUrl: row.backdrop_url ?? null,
    clearlogoUrl: row.clearlogo_url ?? null,
  };
}

export async function getRatings(title, year, type, ratingKey) {
  const plexKey = ratingsKeyFor(ratingKey, title, year);
  const tmdbApiKey = process.env.TMDB_API_KEY;
  const omdbApiKey = process.env.OMDB_API_KEY;
  const mdblistApiKey = process.env.MDBLIST_API_KEY;

  const cached = getCache.get(plexKey)
    || (title && year && type ? getCacheByTitleType.get(title, year, type) : null)
    || (title && year ? getCacheByTitle.get(title, year) : null);
  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (age < CACHE_MAX_AGE_MS) {
      if (cached.plex_key !== plexKey) {
        try {
          upsertCache.run({ ...cached, plex_key: plexKey, fetched_at: cached.fetched_at });
        } catch { /* ignore duplicate */ }
      }
      return shapeCached(cached);
    }
  }

  let tmdbId = null;
  let tmdbRating = null;
  let tmdbVoteCount = null;
  let imdbId = null;
  let tvdbId = null;
  let imdbRating = null;
  let imdbVoteCount = null;
  let rottenTomatoes = null;
  let metacritic = null;
  let posterUrl = null;
  let letterboxdRating = null;
  let traktRating = null;
  let rtAudienceScore = null;
  let mdblistScore = null;
  let mdblistFetchedAt = null;
  let tmdbKeywords = [];
  let tmdbLanguage = null;
  let tmdbCountries = [];

  if (tmdbApiKey) {
    try {
      const tmdbResult = await searchTmdb(title, year, type, tmdbApiKey);
      if (tmdbResult && titleLooksLikeMatch(title, tmdbResult.title) && yearLooksLikeMatch(year, tmdbResult.date)) {
        tmdbId = tmdbResult.id;
        tmdbRating = tmdbResult.rating;
        tmdbVoteCount = tmdbResult.voteCount;
        posterUrl = tmdbResult.posterPath;

        try {
          const externalIds = await getTmdbExternalIds(tmdbId, type, tmdbApiKey);
          if (externalIds) {
            imdbId = externalIds.imdbId;
            tvdbId = externalIds.tvdbId;
          }
        } catch { /* skip */ }

        try {
          const metadata = await getTmdbSearchMetadata(tmdbId, type, tmdbApiKey);
          tmdbKeywords = metadata.keywords;
          tmdbLanguage = metadata.language;
          tmdbCountries = metadata.countries;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  if (omdbApiKey && checkOmdbRateLimit()) {
    try {
      const omdb = await getOmdbRatings(imdbId, title, omdbApiKey);
      if (omdb) {
        imdbRating = omdb.imdbRating;
        imdbVoteCount = omdb.imdbVoteCount;
        rottenTomatoes = omdb.rottenTomatoes;
        metacritic = omdb.metacritic;
        if (!imdbId) imdbId = omdb.imdbId;
      }
    } catch { /* skip */ }
  }

  if (mdblistApiKey && checkMdblistRateLimit()) {
    try {
      const mdb = await getMdblistRatings(imdbId, tmdbId, type, mdblistApiKey);
      if (mdb) {
        letterboxdRating = mdb.letterboxdRating;
        traktRating = mdb.traktRating;
        rtAudienceScore = mdb.rtAudienceScore;
        mdblistScore = mdb.mdblistScore;
        if (imdbRating == null) imdbRating = mdb.imdbFallback;
        if (rottenTomatoes == null) rottenTomatoes = mdb.rottenTomatoesFallback;
        if (metacritic == null) metacritic = mdb.metacriticFallback;
      }
      mdblistFetchedAt = new Date().toISOString();
    } catch { /* skip */ }
  }

  try {
    upsertCache.run({
      plex_key: plexKey,
      title,
      year: year || null,
      tmdb_id: tmdbId,
      tmdb_rating: tmdbRating,
      tmdb_vote_count: tmdbVoteCount,
      imdb_id: imdbId,
      imdb_rating: imdbRating,
      imdb_vote_count: imdbVoteCount,
      rotten_tomatoes_score: rottenTomatoes,
      metacritic_score: metacritic,
      poster_url: posterUrl,
      fetched_at: new Date().toISOString(),
      letterboxd_rating: letterboxdRating,
      trakt_rating: traktRating,
      rt_audience_score: rtAudienceScore,
      mdblist_score: mdblistScore,
      mdblist_fetched_at: mdblistFetchedAt,
      type: type || null,
      tvdb_id: tvdbId,
      tmdb_keywords: JSON.stringify(tmdbKeywords),
      tmdb_language: tmdbLanguage,
      tmdb_countries: JSON.stringify(tmdbCountries),
      backdrop_url: null,
      clearlogo_url: null,
      fanart_fetched_at: null,
    });
  } catch (e) {
    console.error('Failed to cache ratings:', e.message);
  }

  const displayTmdbRating = trustedTmdb(tmdbRating, tmdbVoteCount);
  return {
    tmdbRating: displayTmdbRating,
    rawTmdbRating: tmdbRating,
    tmdbRatingLowConfidence: tmdbRating != null && displayTmdbRating == null,
    tmdbVoteCount,
    imdbRating,
    imdbVoteCount,
    rottenTomatoes,
    metacritic,
    imdbId,
    tmdbId,
    tvdbId,
    tmdbKeywords,
    tmdbLanguage,
    tmdbCountries,
    posterUrl,
    letterboxdRating,
    traktRating,
    rtAudienceScore,
    mdblistScore,
    backdropUrl: null,
    clearlogoUrl: null,
  };
}

/**
 * Synchronous cache lookup. Returns the shaped rating shape for an item if
 * cached, or null if not. Lets enrichItems serve cached items without paying
 * the async/throttle tax.
 */
function getCachedRatingsSync(title, year, type, ratingKey) {
  const cached = getCache.get(ratingsKeyFor(ratingKey, title, year))
    || (title && year && type ? getCacheByTitleType.get(title, year, type) : null)
    || (title && year ? getCacheByTitle.get(title, year) : null);
  if (!cached) return null;
  const age = Date.now() - new Date(cached.fetched_at).getTime();
  if (age >= CACHE_MAX_AGE_MS) return null;
  return shapeCached(cached);
}

/**
 * Ratings already on file, merged into items, with no network calls. For
 * background work that writes library caches: a cache written without these
 * served a library with every rating missing until it next went stale.
 */
export function applyCachedRatings(items) {
  return (items || []).map((item) => {
    const cached = getCachedRatingsSync(item.title, item.year, item.type, item.ratingKey);
    return cached ? { ...item, ...cached } : item;
  });
}

/**
 * Enrich an array of Plex items with ratings.
 *
 * Fast path: synchronous cache lookups for everything. With a hot cache (which
 * is the steady state) we never await an external API and the whole library
 * returns in milliseconds.
 *
 * Slow path: items that miss cache go through getRatings (which hits TMDB/OMDB).
 * These are batched with throttling so we don't burst external APIs.
 */
export async function enrichItems(items) {
  const enriched = new Array(items.length);
  const misses = [];

  // First pass: cache hits — instant.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const cached = getCachedRatingsSync(item.title, item.year, item.type, item.ratingKey);
    if (cached) {
      enriched[i] = { ...item, ...cached };
    } else {
      misses.push(i);
    }
  }

  if (misses.length === 0) return enriched;

  console.log(`  Enriching ${misses.length} cache miss(es) of ${items.length} total...`);

  // Slow path: only run for actual cache misses.
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 250;

  for (let b = 0; b < misses.length; b += BATCH_SIZE) {
    const batchIdxs = misses.slice(b, b + BATCH_SIZE);
    await Promise.all(
      batchIdxs.map(async (i) => {
        const item = items[i];
        try {
          const ratings = await getRatings(item.title, item.year, item.type, item.ratingKey);
          enriched[i] = { ...item, ...ratings };
        } catch {
          enriched[i] = item;
        }
      })
    );
    if (b + BATCH_SIZE < misses.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return enriched;
}
