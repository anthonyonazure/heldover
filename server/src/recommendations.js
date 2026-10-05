import { getRecommendationBoost, getAllRatings } from './personal-ratings.js';
import { getNotInterestedSet } from './feedback.js';
import { rowMatchesItem } from './server-keyed.js';

// Every function here takes `serverKey`, the Plex server `items` came from.
// Library items do not carry it themselves, and thumbs and hidden titles are
// kept per server.

/**
 * "Because you liked X" — TMDB similar would require a network roundtrip; we
 * approximate locally by matching on shared genres + similar runtime + similar
 * era against the user's library. Fast, no API quota, surprisingly good on a
 * library of any size.
 */
export function becauseYouLiked({ items, seedItem, serverKey, count = 12, profileId = 1 }) {
  if (!seedItem) throw new Error('seedItem is required');
  const seedGenres = new Set((seedItem.genres || []).map((g) => g.toLowerCase()));
  const seedYear = seedItem.year || 2000;
  const seedRuntime = seedItem.duration || 110 * 60 * 1000;
  const skip = getNotInterestedSet(profileId);
  const seedKey = String(seedItem.ratingKey || seedItem.plex_key || seedItem.plexKey || '');

  const scored = items
    .filter((it) => {
      const key = String(it.ratingKey || it.plex_key || it.plexKey || '');
      return key && key !== seedKey && !skip.has(it, serverKey);
    })
    .map((it) => {
      const itemGenres = new Set((it.genres || []).map((g) => g.toLowerCase()));
      let genreOverlap = 0;
      for (const g of itemGenres) if (seedGenres.has(g)) genreOverlap++;
      const genreScore = seedGenres.size ? genreOverlap / seedGenres.size : 0;
      const yearGap = Math.abs((it.year || seedYear) - seedYear);
      const yearScore = Math.max(0, 1 - yearGap / 30);
      const runtimeGap = Math.abs((it.duration || seedRuntime) - seedRuntime);
      const runtimeScore = Math.max(0, 1 - runtimeGap / (60 * 60 * 1000));
      const ratingScore = ((it.imdbRating || 0) + (it.tmdbRating || 0)) / 20;
      const boost = getRecommendationBoost(it, profileId) * 0.25;
      const score = genreScore * 0.55 + yearScore * 0.15 + runtimeScore * 0.05 + ratingScore * 0.25 + boost;
      return { item: it, score };
    })
    .filter((x) => x.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, count);

  return scored.map((x) => x.item);
}

/**
 * Hidden Gems — high rated, low watched, in your library. The classic
 * "underseen but excellent" surface.
 */
export function hiddenGems({ items, serverKey, count = 20, profileId = 1 }) {
  const skip = getNotInterestedSet(profileId);
  return items
    .filter((it) => {
      const rating = Math.max(it.imdbRating || 0, it.tmdbRating || 0);
      const watched = (it.viewCount || 0) > 0;
      return rating >= 7.5 && !watched && !skip.has(it, serverKey);
    })
    .map((it) => {
      const rating = Math.max(it.imdbRating || 0, it.tmdbRating || 0);
      const votes = it.imdbVoteCount || it.tmdbVoteCount || 0;
      const obscurity = votes > 0 ? Math.max(0, 1 - votes / 200000) : 0.5;
      return { item: it, score: rating + obscurity * 2 + getRecommendationBoost(it, profileId) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((x) => x.item);
}

/**
 * Recently added items the current profile has not started yet. The personal
 * twist on "what's new" — it's actually new *to you*.
 */
export function recentlyAddedNotYetSeen({ items, serverKey, days = 30, count = 20, profileId = 1 }) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const skip = getNotInterestedSet(profileId);
  return items
    .filter((it) => {
      if (skip.has(it, serverKey)) return false;
      if ((it.viewCount || 0) > 0) return false;
      if (!it.addedAt) return false;
      const addedMs = typeof it.addedAt === 'number' ? it.addedAt * 1000 : new Date(it.addedAt).getTime();
      return !Number.isNaN(addedMs) && addedMs >= cutoff;
    })
    .sort((a, b) => {
      const aMs = typeof a.addedAt === 'number' ? a.addedAt * 1000 : new Date(a.addedAt).getTime();
      const bMs = typeof b.addedAt === 'number' ? b.addedAt * 1000 : new Date(b.addedAt).getTime();
      return bMs - aMs;
    })
    .slice(0, count);
}

/**
 * Compute a 0-100 personalized match score for an item based on the user's
 * up/down ratings + the item's global quality. Used for the "94% match" badge.
 */
export function percentMatch(item, profileId = 1) {
  if (!item) return 0;
  const boost = getRecommendationBoost(item, profileId);
  const quality = Math.max(item.imdbRating || 0, item.tmdbRating || 0) / 10;
  const raw = quality * 0.6 + (boost + 1) * 0.5 * 0.4;
  return Math.round(Math.max(0, Math.min(1, raw)) * 100);
}

/**
 * "Because You Liked" rows — for each of the user's most recent thumbs-up
 * items, generate a row of similar items in their library. Returns up to N
 * rows.
 */
export function becauseYouLikedRows({ items, serverKey, count = 3, profileId = 1 }) {
  // Only thumbs that can be about this server: its own, and older ones saved
  // before the server was stored (those are matched by title below).
  const liked = getAllRatings('up', profileId)
    .filter((row) => !row.server_key || !serverKey || row.server_key === serverKey)
    .slice(0, count * 2);
  const rows = [];
  const seedKeys = new Set();
  for (const seed of liked) {
    if (rows.length >= count) break;
    const key = String(seed.plex_key);
    if (seedKeys.has(key)) continue;
    const seedItem = items.find((it) => rowMatchesItem(seed, it, serverKey));
    if (!seedItem) continue;
    const picks = becauseYouLiked({ items, seedItem, serverKey, count: 12, profileId });
    if (picks.length >= 4) {
      rows.push({ seed: seedItem, items: picks });
      seedKeys.add(key);
    }
  }
  return rows;
}
