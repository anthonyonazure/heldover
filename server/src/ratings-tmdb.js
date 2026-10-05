import { getNextKeywordBackfillRow, updateKeywordFields } from './ratings-store.js';

/**
 * Get TMDB recommendations + similar titles for a given TMDB ID.
 * Returns array of { tmdbId, title, year, posterUrl, rating, overview }.
 */
export async function getTmdbSimilar(tmdbId, type) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || !tmdbId) return [];

  const mediaType = type === 'show' ? 'tv' : 'movie';
  const titleField = type === 'show' ? 'name' : 'title';
  const dateField = type === 'show' ? 'first_air_date' : 'release_date';

  // Fetch both recommendations and similar in parallel
  const [recsRes, simRes] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/recommendations?api_key=${apiKey}`, { signal: AbortSignal.timeout(15_000) }),
    fetch(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/similar?api_key=${apiKey}`, { signal: AbortSignal.timeout(15_000) }),
  ]);

  const recs = recsRes.ok ? (await recsRes.json()).results || [] : [];
  const sims = simRes.ok ? (await simRes.json()).results || [] : [];

  // Merge and dedupe by TMDB ID
  const seen = new Set();
  const merged = [];
  for (const item of [...recs, ...sims]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push({
      tmdbId: item.id,
      title: item[titleField],
      year: item[dateField] ? parseInt(item[dateField].split('-')[0], 10) : null,
      posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
      rating: item.vote_average,
      overview: item.overview,
    });
  }

  return merged;
}

/**
 * Search TMDB for a title and return the best match.
 */
export async function searchTmdb(title, year, type, apiKey) {
  const mediaType = type === 'show' ? 'tv' : 'movie';
  const params = new URLSearchParams({
    api_key: apiKey,
    query: title,
  });
  if (year) params.set(type === 'show' ? 'first_air_date_year' : 'year', String(year));

  const url = `https://api.themoviedb.org/3/search/${mediaType}?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok) return null;

  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;

  const match = data.results[0];
  return {
    id: match.id,
    title: match.title || match.name || null,
    date: match.release_date || match.first_air_date || null,
    rating: match.vote_average,
    voteCount: match.vote_count,
    posterPath: match.poster_path
      ? `https://image.tmdb.org/t/p/w500${match.poster_path}`
      : null,
  };
}

let keywordBackfillTimer = null;
let keywordBackfillIdle = false;

export function startTmdbKeywordBackfill({ intervalMs = 1200 } = {}) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || keywordBackfillTimer) return;

  console.log('TMDB keyword backfill worker started (1 row every', intervalMs, 'ms)');

  const tick = async () => {
    if (keywordBackfillIdle) return;
    const row = getNextKeywordBackfillRow.get();
    if (!row) {
      if (!keywordBackfillIdle) {
        console.log('TMDB keyword backfill: nothing left to enrich, idling.');
        keywordBackfillIdle = true;
      }
      return;
    }

    try {
      const metadata = await getTmdbSearchMetadata(row.tmdb_id, row.type, apiKey);
      updateKeywordFields.run({
        plex_key: row.plex_key,
        tmdb_keywords: JSON.stringify(metadata.keywords),
        tmdb_language: metadata.language,
        tmdb_countries: JSON.stringify(metadata.countries),
      });
    } catch {
      updateKeywordFields.run({
        plex_key: row.plex_key,
        tmdb_keywords: JSON.stringify([]),
        tmdb_language: null,
        tmdb_countries: JSON.stringify([]),
      });
    }
  };
  keywordBackfillTimer = setInterval(() => void tick(), intervalMs);
}

export function stopTmdbKeywordBackfill() {
  if (keywordBackfillTimer) {
    clearInterval(keywordBackfillTimer);
    keywordBackfillTimer = null;
  }
  keywordBackfillIdle = false;
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, 'and')
    .replace(/\b(us|uk|au|ca)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function titleLooksLikeMatch(inputTitle, matchTitle) {
  const input = normalizeTitle(inputTitle);
  const match = normalizeTitle(matchTitle);
  if (!input || !match) return false;
  return input === match || input.includes(match) || match.includes(input);
}

export function yearLooksLikeMatch(inputYear, matchDate) {
  if (!inputYear || !matchDate) return true;
  const matchYear = parseInt(String(matchDate).slice(0, 4), 10);
  if (!Number.isFinite(matchYear)) return true;
  return Math.abs(Number(inputYear) - matchYear) <= 1;
}

/**
 * Get external IDs (IMDB, TVDB) from TMDB.
 */
export async function getTmdbExternalIds(tmdbId, type, apiKey) {
  const mediaType = type === 'show' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids?api_key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok) return null;

  const data = await res.json();
  return {
    imdbId: data.imdb_id || null,
    tvdbId: data.tvdb_id || null,
  };
}

export async function getTmdbSearchMetadata(tmdbId, type, apiKey) {
  if (!tmdbId || !apiKey) return { keywords: [], language: null, countries: [] };
  const mediaType = type === 'show' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${apiKey}&append_to_response=keywords`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!res.ok) return { keywords: [], language: null, countries: [] };

  const data = await res.json();
  const rows = type === 'show' ? data.keywords?.results : data.keywords?.keywords;
  const keywords = Array.isArray(rows)
    ? rows
      .map((keyword) => keyword?.name)
      .filter(Boolean)
      .slice(0, 80)
    : [];

  const countries = [
    ...(Array.isArray(data.origin_country) ? data.origin_country : []),
    ...(Array.isArray(data.production_countries) ? data.production_countries.map((c) => c?.name || c?.iso_3166_1) : []),
  ].filter(Boolean);

  return {
    keywords,
    language: data.original_language || null,
    countries: [...new Set(countries)],
  };
}
