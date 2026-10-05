// Streaming availability layer. Answers "where can I watch this" for any TMDB
// title, and "what is on service X right now" for browse rows. Everything that
// mentions Netflix (badges, filters, the On Netflix menu) reads from here.

import { openRatingsDb } from './db.js';

const db = openRatingsDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS availability_cache (
    cache_key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  )
`);

// Availability changes on licensing cycles, not hourly. A day is plenty fresh
// and keeps us far under TMDB's rate limits on a big library sweep.
const AVAILABILITY_TTL_MS = 24 * 60 * 60 * 1000;
const DISCOVER_TTL_MS = 6 * 60 * 60 * 1000;

const getCacheStmt = db.prepare('SELECT data, fetched_at FROM availability_cache WHERE cache_key = ?');
const upsertCacheStmt = db.prepare(`
  INSERT OR REPLACE INTO availability_cache (cache_key, data, fetched_at)
  VALUES (?, ?, ?)
`);

function readCache(key, ttlMs) {
  const row = getCacheStmt.get(key);
  if (!row) return null;
  if (Date.now() - new Date(row.fetched_at).getTime() > ttlMs) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

// Rows past their freshness window are dead weight, and the table grows with
// every title anyone scrolls past. Swept now and then from the write path.
const pruneCacheStmt = db.prepare(
  "DELETE FROM availability_cache WHERE fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')"
);
let writesSincePrune = 0;

function writeCache(key, value) {
  try {
    upsertCacheStmt.run(key, JSON.stringify(value), new Date().toISOString());
    if (++writesSincePrune >= 500) {
      writesSincePrune = 0;
      pruneCacheStmt.run();
    }
  } catch (e) {
    console.error('Failed to cache availability:', e.message);
  }
}

// TMDB answers in well under a second. Without a limit, one stalled request
// held a whole batch, and every badge waiting on it, open indefinitely.
const TMDB_TIMEOUT_MS = 10_000;

/** Two-letter region codes only; anything else becomes the default. */
export function cleanRegion(region) {
  return typeof region === 'string' && /^[A-Z]{2}$/.test(region) ? region : 'US';
}

/**
 * The services worth showing. TMDB knows about hundreds of providers, most of
 * them noise for a US household. Order here is the order they render in.
 */
// One service, several of TMDB's ids. TMDB does not have a row called
// "Paramount+" or "Netflix"; it has a row per plan, and it renames and renumbers
// them as the services restructure. Paramount+ used to be id 531 and simply
// stopped existing, which is why that tab went blank while every other one kept
// working: the app asked for a plan nobody sells any more and got an honest
// empty answer back.
//
// So a service is a list of ids rather than one. `ids` are the plans that mean
// "you can watch this here" — the ad tier counts, since it is still the service
// — and the first is the canonical one. Deliberately excluded: buying the same
// content as an add-on through Amazon or Roku, and storefronts that rent by the
// title, because neither is something a subscriber can just press play on.
export const PROVIDERS = [
  { ids: [8, 1796, 175], name: 'Netflix', slug: 'netflix', color: '#E50914', deepLink: 'https://www.netflix.com/search?q=' },
  { ids: [337], name: 'Disney+', slug: 'disney-plus', color: '#0B65F7', deepLink: 'https://www.disneyplus.com/search?q=' },
  { ids: [1899], name: 'Max', slug: 'max', color: '#0046FF', deepLink: 'https://play.max.com/search?q=' },
  { ids: [9, 2100], name: 'Prime Video', slug: 'prime-video', color: '#00A8E1', deepLink: 'https://www.amazon.com/s?k=' },
  { ids: [15], name: 'Hulu', slug: 'hulu', color: '#1CE783', deepLink: 'https://www.hulu.com/search?q=' },
  { ids: [350], name: 'Apple TV+', slug: 'apple-tv-plus', color: '#8F8F94', deepLink: 'https://tv.apple.com/search?term=' },
  { ids: [2303, 2616], name: 'Paramount+', slug: 'paramount-plus', color: '#0064FF', deepLink: 'https://www.paramountplus.com/search/?q=' },
  { ids: [386, 387], name: 'Peacock', slug: 'peacock', color: '#FA6400', deepLink: 'https://www.peacocktv.com/search?q=' },
  { ids: [283], name: 'Crunchyroll', slug: 'crunchyroll', color: '#F47521', deepLink: 'https://www.crunchyroll.com/search?q=' },
  { ids: [73], name: 'Tubi', slug: 'tubi', color: '#FA382B', deepLink: 'https://tubitv.com/search/' },
].map((p) => ({ ...p, id: p.ids[0] }));

// Every id a service owns points back at it, so a title reported as being on
// the ad tier is still recognised as being on the service.
const PROVIDER_BY_ID = new Map(PROVIDERS.flatMap((p) => p.ids.map((id) => [id, p])));
const PROVIDER_BY_SLUG = new Map(PROVIDERS.map((p) => [p.slug, p]));

export function resolveProvider(idOrSlug) {
  if (idOrSlug === undefined || idOrSlug === null) return null;
  const asNum = Number(idOrSlug);
  if (!Number.isNaN(asNum) && PROVIDER_BY_ID.has(asNum)) return PROVIDER_BY_ID.get(asNum);
  return PROVIDER_BY_SLUG.get(String(idOrSlug).toLowerCase()) || null;
}

function tmdbMediaType(type) {
  return type === 'show' || type === 'tv' ? 'tv' : 'movie';
}

function requireApiKey() {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error('TMDB_API_KEY not configured');
  return apiKey;
}

/**
 * Where a single title streams, in the given region. Returns the subscription
 * services first (`streaming`), then rent/buy, plus TMDB's own "watch now"
 * link as a fallback for anything we do not have a deep link for.
 */
export async function getAvailability(type, tmdbId, region = 'US') {
  const apiKey = process.env.TMDB_API_KEY;
  region = cleanRegion(region);
  if (!apiKey || !/^\d+$/.test(String(tmdbId || ''))) return { streaming: [], rent: [], buy: [], link: null };

  const mediaType = tmdbMediaType(type);
  const cacheKey = `avail:${mediaType}:${tmdbId}:${region}`;
  const cached = readCache(cacheKey, AVAILABILITY_TTL_MS);
  if (cached) return cached;

  const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/watch/providers?api_key=${apiKey}`;
  // A failed lookup throws rather than answering "streams nowhere". That
  // answer was cached by the phones for the rest of the visit, so one TMDB
  // hiccup hid a title's badges until the page was reloaded.
  const res = await fetch(url, { signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`TMDB watch providers: ${res.status}`);
  const payload = await res.json();

  const regionData = (payload.results || {})[region] || {};

  // Only surface the services we actually care about, and dedupe: TMDB lists
  // "Netflix" and "Netflix basic with Ads" as separate providers.
  const pick = (list) => {
    const seen = new Set();
    const out = [];
    for (const entry of list || []) {
      const provider = PROVIDER_BY_ID.get(entry.provider_id);
      if (!provider || seen.has(provider.id)) continue;
      seen.add(provider.id);
      out.push({ id: provider.id, name: provider.name, slug: provider.slug, color: provider.color });
    }
    return out;
  };

  const result = {
    streaming: pick(regionData.flatrate),
    rent: pick(regionData.rent),
    buy: pick(regionData.buy),
    link: regionData.link || null,
  };

  writeCache(cacheKey, result);
  return result;
}

/**
 * Availability for a page of cards in one call. The client sends the whole grid
 * and gets back a map keyed `<mediaType>:<tmdbId>`, so a scroll never fires
 * dozens of separate requests.
 */
export const MAX_BATCH = 300;

export async function getAvailabilityBatch(items, region = 'US') {
  const out = {};
  if (!Array.isArray(items) || items.length === 0) return out;

  // Cap concurrency so a 200-card grid does not open 200 sockets at once. The
  // phones send at most MAX_BATCH per request, so nothing is cut off here in
  // normal use; titles past the cap are simply absent from the answer, which
  // the phones treat as "ask again", never as "streams nowhere".
  const CONCURRENCY = 8;
  const queue = items.slice(0, MAX_BATCH);
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      const tmdbId = item.tmdbId || item.tmdb_id;
      if (!tmdbId) continue;
      const mediaType = tmdbMediaType(item.type || item.mediaType);
      try {
        out[`${mediaType}:${tmdbId}`] = await getAvailability(mediaType, tmdbId, region);
      } catch {
        // A single failed lookup must not sink the batch.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return out;
}

/**
 * What is on a service right now — the data behind the "On Netflix" menu.
 * Returns the same card shape as the trending row so the existing components
 * render it with no translation layer.
 */
export async function discoverByProvider(providerIdOrSlug, options = {}) {
  const apiKey = requireApiKey();
  const provider = resolveProvider(providerIdOrSlug);
  if (!provider) throw new Error(`Unknown provider: ${providerIdOrSlug}`);

  const mediaType = tmdbMediaType(options.type);
  const page = Math.max(1, Math.min(500, parseInt(options.page, 10) || 1));
  const region = cleanRegion(options.region);
  const sortBy = options.sortBy || 'popularity.desc';
  const minRating = options.minRating ? Number(options.minRating) : null;
  const minVotes = options.minVotes ? Number(options.minVotes) : 200;
  const genre = options.genre || null;

  // The plan ids are part of the key, not just the service. Changing which
  // plans a service covers changes the answer, and without this the old answer
  // would keep being served as though nothing had been fixed.
  const cacheKey = `discover:${provider.ids.join('+')}:${mediaType}:${region}:${page}:${sortBy}:${minRating || 0}:${minVotes}:${genre || 'all'}`;
  const cached = readCache(cacheKey, DISCOVER_TTL_MS);
  if (cached) return cached;

  const params = new URLSearchParams({
    api_key: apiKey,
    // Every plan the service sells, so a title on the ad tier still shows up.
    with_watch_providers: provider.ids.join('|'),
    watch_region: region,
    with_watch_monetization_types: 'flatrate',
    sort_by: sortBy,
    page: String(page),
    'vote_count.gte': String(minVotes),
    include_adult: 'false',
  });
  if (minRating) params.set('vote_average.gte', String(minRating));
  if (genre) params.set('with_genres', String(genre));

  const url = `https://api.themoviedb.org/3/discover/${mediaType}?${params.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`TMDB discover error: ${res.status} ${res.statusText}`);
  const data = await res.json();

  const titleField = mediaType === 'tv' ? 'name' : 'title';
  const dateField = mediaType === 'tv' ? 'first_air_date' : 'release_date';

  const results = (data.results || []).map((item) => ({
    tmdbId: item.id,
    title: item[titleField],
    year: item[dateField] ? parseInt(item[dateField].split('-')[0], 10) : null,
    overview: item.overview,
    posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
    backdropUrl: item.backdrop_path ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}` : null,
    tmdbRating: item.vote_average,
    voteCount: item.vote_count,
    popularity: item.popularity,
    mediaType,
    genreIds: item.genre_ids || [],
    onProvider: { id: provider.id, name: provider.name, slug: provider.slug, color: provider.color },
    watchUrl: provider.deepLink + encodeURIComponent(item[titleField] || ''),
  }));

  const payload = {
    provider: { id: provider.id, name: provider.name, slug: provider.slug, color: provider.color },
    page: data.page || page,
    totalPages: Math.min(data.total_pages || 1, 500),
    totalResults: data.total_results || results.length,
    results,
  };

  writeCache(cacheKey, payload);
  return payload;
}

/**
 * Search link into a service's own app/site. Used by the "Open on Netflix"
 * button — deep-linking straight to a title needs that service's own ID, which
 * TMDB does not expose, so a pre-filled search is the reliable path.
 */
export function watchUrlFor(providerIdOrSlug, title) {
  const provider = resolveProvider(providerIdOrSlug);
  if (!provider) return null;
  return provider.deepLink + encodeURIComponent(title || '');
}
