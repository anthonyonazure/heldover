/**
 * Compute library statistics from an array of enriched items.
 *
 * @param {Array} items - Enriched Plex items with ratings
 * @returns {object} Statistics object
 */
export function getLibraryStats(items) {
  if (!items || items.length === 0) {
    return {
      totalCount: 0,
      movieCount: 0,
      showCount: 0,
      genreBreakdown: {},
      decadeBreakdown: {},
      ratingDistribution: {},
      averageImdbRating: null,
      averageTmdbRating: null,
      totalRuntimeMs: 0,
      totalRuntimeFormatted: '0h 0m',
      topRated: [],
      contentRatingBreakdown: {},
    };
  }

  const movieCount = items.filter((i) => i.type === 'movie').length;
  const showCount = items.filter((i) => i.type === 'show').length;

  // Genre breakdown
  const genreBreakdown = {};
  for (const item of items) {
    if (item.genres && Array.isArray(item.genres)) {
      for (const genre of item.genres) {
        genreBreakdown[genre] = (genreBreakdown[genre] || 0) + 1;
      }
    }
  }

  // Decade breakdown
  const decadeBreakdown = {};
  for (const item of items) {
    if (item.year) {
      const decade = `${Math.floor(item.year / 10) * 10}s`;
      decadeBreakdown[decade] = (decadeBreakdown[decade] || 0) + 1;
    }
  }

  // IMDB rating distribution (histogram: 0-1, 1-2, ..., 9-10)
  const ratingDistribution = {};
  for (let i = 0; i < 10; i++) {
    ratingDistribution[`${i}-${i + 1}`] = 0;
  }
  for (const item of items) {
    if (item.imdbRating != null) {
      const bucket = Math.min(Math.floor(item.imdbRating), 9);
      const key = `${bucket}-${bucket + 1}`;
      ratingDistribution[key] = (ratingDistribution[key] || 0) + 1;
    }
  }

  // Average ratings
  const imdbRatings = items.filter((i) => i.imdbRating != null).map((i) => i.imdbRating);
  const tmdbRatings = items.filter((i) => i.tmdbRating != null).map((i) => i.tmdbRating);

  const averageImdbRating = imdbRatings.length > 0
    ? Math.round((imdbRatings.reduce((a, b) => a + b, 0) / imdbRatings.length) * 100) / 100
    : null;

  const averageTmdbRating = tmdbRatings.length > 0
    ? Math.round((tmdbRatings.reduce((a, b) => a + b, 0) / tmdbRatings.length) * 100) / 100
    : null;

  // Total runtime (sum of durations in milliseconds)
  const totalRuntimeMs = items.reduce((sum, item) => sum + (item.duration || 0), 0);
  const totalMinutes = Math.floor(totalRuntimeMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const totalRuntimeFormatted = `${hours}h ${minutes}m`;

  // Top rated (top 10 by IMDB rating)
  const topRated = items
    .filter((i) => i.imdbRating != null)
    .sort((a, b) => b.imdbRating - a.imdbRating)
    .slice(0, 10)
    .map((item) => ({
      title: item.title,
      year: item.year,
      imdbRating: item.imdbRating,
      tmdbRating: item.tmdbRating,
      rottenTomatoes: item.rottenTomatoes,
      ratingKey: item.ratingKey,
      type: item.type,
      thumb: item.thumb,
    }));

  // Content rating breakdown
  const contentRatingBreakdown = {};
  for (const item of items) {
    const cr = item.contentRating || 'Unrated';
    contentRatingBreakdown[cr] = (contentRatingBreakdown[cr] || 0) + 1;
  }

  return {
    totalCount: items.length,
    movieCount,
    showCount,
    genreBreakdown,
    decadeBreakdown,
    ratingDistribution,
    averageImdbRating,
    averageTmdbRating,
    totalRuntimeMs,
    totalRuntimeFormatted,
    topRated,
    contentRatingBreakdown,
  };
}
