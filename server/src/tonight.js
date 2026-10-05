import { applyFilters } from './filters.js';
import { getMoodById } from './mood-presets.js';
import { getAllRatings, getRecommendationBoost } from './personal-ratings.js';
import { getNotInterestedSet, titleMatcher } from './feedback.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isAddedWithinDays(item, days) {
  if (!item.addedAt) return false;
  const addedMs = typeof item.addedAt === 'number'
    ? item.addedAt * 1000
    : new Date(item.addedAt).getTime();
  if (Number.isNaN(addedMs)) return false;
  return Date.now() - addedMs <= days * DAY_MS;
}

/**
 * Best rating we have for a title, on a 0-10 scale.
 *
 * Only enriched items carry imdbRating/tmdbRating, and enrichment needs API
 * keys that are not always configured. Plex's own audienceRating is present on
 * three quarters of the library for free — ignoring it made every unenriched
 * title score zero, which is how a "cozy night" shelf ended up ranking by
 * nothing at all.
 */
// Deliberately does NOT read item.rating. On these libraries that field comes
// back as a flat 9.4 for thousands of unrelated titles — it is not an audience
// score, and trusting it made every shelf tie for first place and fall back to
// alphabetical order.
export function bestRating(item) {
  const candidates = [item.imdbRating, item.tmdbRating, item.audienceRating]
    .map((v) => (typeof v === 'number' ? v : Number.NaN))
    .filter((v) => Number.isFinite(v) && v > 0);
  return candidates.length ? Math.max(...candidates) : null;
}

function smartScore(item, profileId = 1) {
  const baseRating = bestRating(item) || 0;
  const boost = getRecommendationBoost(item, profileId);
  return baseRating + boost * 2;
}

/**
 * Pick N items for a given mood. Filters with the mood preset, removes
 * not_interested and (optionally) already-watched, then ranks by personalized
 * smart score (IMDB/TMDB + recommendation boost from up/down ratings) and
 * takes the top N. `serverKey` is the Plex server the items came from; thumbs
 * and hidden titles are kept per server.
 */
export function pickTonight({ items, serverKey, moodId, count = 5, includeWatched = false, profileId = 1 }) {
  const mood = getMoodById(moodId);
  if (!mood) throw new Error(`Unknown mood: ${moodId}`);

  let pool = items.slice();

  if (mood.filters.addedWithinDays) {
    pool = pool.filter((it) => isAddedWithinDays(it, mood.filters.addedWithinDays));
  }

  if (mood.filters.onlyLiked) {
    const liked = titleMatcher(getAllRatings('up', profileId));
    pool = pool.filter((it) => liked.has(it, serverKey));
  }

  const passThrough = { ...mood.filters };
  delete passThrough.addedWithinDays;
  delete passThrough.onlyLiked;

  if (!includeWatched && !mood.filters.onlyLiked) {
    passThrough.excludeWatched = true;
  }

  pool = applyFilters(pool, passThrough);

  const skip = getNotInterestedSet(profileId);
  pool = pool.filter((it) => !skip.has(it, serverKey));

  pool.sort((a, b) => smartScore(b, profileId) - smartScore(a, profileId));

  return pool.slice(0, count);
}
