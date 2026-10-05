/**
 * Heldover Wrapped — aggregate watched-in-window stats from cached library
 * data. We don't need Plex's session log for this; library items already carry
 * viewCount + lastViewedAt. Defaults to the last 90 days but accepts any window.
 */

function isWatchedInWindow(item, sinceMs) {
  if (!item.lastViewedAt) return false;
  const lastMs = typeof item.lastViewedAt === 'number'
    ? item.lastViewedAt * 1000
    : new Date(item.lastViewedAt).getTime();
  if (Number.isNaN(lastMs)) return false;
  return lastMs >= sinceMs;
}

function formatRuntime(totalMs) {
  const hours = Math.floor(totalMs / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days > 0) return `${days}d ${remHours}h`;
  const mins = Math.floor((totalMs % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}h ${mins}m`;
}

export function buildWrapped({ items, days = 90 }) {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const watched = items.filter((it) => isWatchedInWindow(it, sinceMs));

  const totalWatched = watched.length;
  const movieCount = watched.filter((it) => it.type === 'movie').length;
  const showCount = watched.filter((it) => it.type === 'show').length;

  const totalRuntimeMs = watched.reduce((acc, it) => {
    const dur = it.duration || 0;
    const views = Math.max(1, it.viewCount || 1);
    return acc + dur * views;
  }, 0);

  const genreCount = {};
  for (const it of watched) {
    for (const g of it.genres || []) {
      genreCount[g] = (genreCount[g] || 0) + 1;
    }
  }
  const topGenres = Object.entries(genreCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([genre, count]) => ({ genre, count }));

  const decadeCount = {};
  for (const it of watched) {
    if (!it.year) continue;
    const decade = `${Math.floor(it.year / 10) * 10}s`;
    decadeCount[decade] = (decadeCount[decade] || 0) + 1;
  }
  const topDecade = Object.entries(decadeCount).sort((a, b) => b[1] - a[1])[0];

  const sortedByRating = watched
    .filter((it) => (it.imdbRating || 0) > 0)
    .sort((a, b) => (b.imdbRating || 0) - (a.imdbRating || 0));

  const sortedByRuntime = watched
    .filter((it) => (it.duration || 0) > 0)
    .sort((a, b) => (b.duration || 0) - (a.duration || 0));

  const totalRatings = watched.reduce((acc, it) => acc + ((it.imdbRating || 0) > 0 ? 1 : 0), 0);
  const sumRatings = watched.reduce((acc, it) => acc + (it.imdbRating || 0), 0);
  const avgRating = totalRatings ? sumRatings / totalRatings : 0;

  return {
    windowDays: days,
    totalWatched,
    movieCount,
    showCount,
    totalRuntimeMs,
    totalRuntimeFormatted: formatRuntime(totalRuntimeMs),
    topGenres,
    topDecade: topDecade ? { decade: topDecade[0], count: topDecade[1] } : null,
    avgRating: Math.round(avgRating * 10) / 10,
    highestRated: sortedByRating[0] ? pickCard(sortedByRating[0]) : null,
    longestWatched: sortedByRuntime[0] ? pickCard(sortedByRuntime[0]) : null,
    mostRewatched: pickMostRewatched(watched),
    sample: watched.slice(0, 12).map(pickCard),
  };
}

function pickCard(it) {
  return {
    title: it.title,
    year: it.year,
    poster: it.posterUrl || it.thumb || null,
    rating: it.imdbRating || it.tmdbRating || null,
    runtime: it.duration || null,
    viewCount: it.viewCount || 0,
  };
}

function pickMostRewatched(watched) {
  const rewatches = watched.filter((it) => (it.viewCount || 0) >= 2);
  if (rewatches.length === 0) return null;
  rewatches.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
  return pickCard(rewatches[0]);
}
