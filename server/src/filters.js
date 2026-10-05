const LANGUAGE_NAMES = {
  en: 'english',
  es: 'spanish',
  fr: 'french',
  de: 'german',
  it: 'italian',
  ja: 'japanese',
  ko: 'korean',
  zh: 'chinese',
  cn: 'chinese',
  hi: 'hindi',
  pt: 'portuguese',
  ru: 'russian',
  sv: 'swedish',
  da: 'danish',
  no: 'norwegian',
};

function keywordText(item) {
  const mediaText = (Array.isArray(item.media) ? item.media : [])
    .flatMap((media) => [
      media.videoResolution,
      media.videoCodec,
      media.audioCodec,
      media.container,
      media.videoFrameRate,
      media.videoDynamicRange,
      media.width ? `${media.width}p` : null,
      ...(Array.isArray(media.parts) ? media.parts.map((part) => part.file) : []),
    ]);

  return [
    item.title,
    item.originalTitle,
    item.summary,
    item.tagline,
    item.studio,
    item.director,
    item.contentRating,
    item.resolution,
    item.hdr,
    item.audioCodec,
    item.serverName,
    item.libraryTitle,
    item.tmdbLanguage,
    LANGUAGE_NAMES[item.tmdbLanguage],
    ...(Array.isArray(item.genres) ? item.genres : []),
    ...(Array.isArray(item.actors) ? item.actors : []),
    ...(Array.isArray(item.writers) ? item.writers : []),
    ...(Array.isArray(item.collections) ? item.collections : []),
    ...(Array.isArray(item.countries) ? item.countries : []),
    ...(Array.isArray(item.tmdbKeywords) ? item.tmdbKeywords : []),
    ...(Array.isArray(item.tmdbCountries) ? item.tmdbCountries : []),
    ...mediaText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function runtimeMinutes(item) {
  const duration = item.duration || item.media?.[0]?.duration;
  return duration ? duration / 60000 : null;
}

function isFriendlyContent(item) {
  return ['G', 'PG', 'TV-Y', 'TV-G', 'TV-PG'].includes(item.contentRating);
}

function voteCount(item) {
  return Math.max(item.imdbVoteCount || 0, item.tmdbVoteCount || 0);
}

function isSuspiciousHighImdb(item) {
  if (item.imdbRating == null || item.imdbRating < 8.5) return false;
  if (item.imdbVoteCount == null) return true;
  return item.imdbVoteCount < 100;
}

function effectiveRating(item) {
  if (!isSuspiciousHighImdb(item) && item.imdbRating != null) return item.imdbRating;
  return item.tmdbRating ?? item.imdbRating ?? -1;
}

function hasQuality(item, pattern) {
  return pattern.test(keywordText(item));
}

function smartSearchRules(query) {
  const rules = [];
  let text = String(query || '').toLowerCase();

  if (/\b(unwatched|never watched|not watched)\b/.test(text)) {
    rules.push((item) => !item.viewCount && !item.lastViewedAt);
    text = text.replace(/\b(unwatched|never watched|not watched)\b/g, ' ');
  } else if (/\bwatched\b/.test(text)) {
    rules.push((item) => Boolean(item.viewCount || item.lastViewedAt));
    text = text.replace(/\bwatched\b/g, ' ');
  }

  if (/\b(partial|partially watched|in progress)\b/.test(text)) {
    rules.push((item) => Boolean(item.viewOffset));
    text = text.replace(/\b(partial|partially watched|in progress)\b/g, ' ');
  }

  if (/\b(4k|uhd|2160p)\b/.test(text)) {
    rules.push((item) => hasQuality(item, /\b(4k|uhd|2160p|3840p)\b/));
    text = text.replace(/\b(4k|uhd|2160p)\b/g, ' ');
  }
  if (/\b(1080p|full hd)\b/.test(text)) {
    rules.push((item) => hasQuality(item, /\b(1080p|full hd)\b/));
    text = text.replace(/\b(1080p|full hd)\b/g, ' ');
  }
  if (/\b(720p|hd)\b/.test(text)) {
    rules.push((item) => hasQuality(item, /\b(720p|hd)\b/));
    text = text.replace(/\b(720p|hd)\b/g, ' ');
  }
  if (/\bhdr\b/.test(text)) {
    rules.push((item) => hasQuality(item, /\b(hdr|hdr10|dolby vision|dv)\b/));
    text = text.replace(/\bhdr\b/g, ' ');
  }
  if (/\b(atmos|dolby)\b/.test(text)) {
    rules.push((item) => hasQuality(item, /\b(atmos|truehd|dolby|eac3|e-ac-3)\b/));
    text = text.replace(/\b(atmos|dolby)\b/g, ' ');
  }
  if (/\b(hevc|h265|x265)\b/.test(text)) {
    rules.push((item) => hasQuality(item, /\b(hevc|h265|h\.265|x265|x\.265)\b/));
    text = text.replace(/\b(hevc|h265|x265)\b/g, ' ');
  }

  text = text.replace(/\b(under|less than|shorter than)\s+(\d+)\s*(m|min|minutes)?\b/g, (_, __, n) => {
    rules.push((item) => runtimeMinutes(item) != null && runtimeMinutes(item) <= Number(n));
    return ' ';
  });
  text = text.replace(/\b(over|more than|longer than)\s+(\d+)\s*(m|min|minutes)?\b/g, (_, __, n) => {
    rules.push((item) => runtimeMinutes(item) != null && runtimeMinutes(item) >= Number(n));
    return ' ';
  });

  if (/\bshort\b/.test(text)) {
    rules.push((item) => runtimeMinutes(item) != null && runtimeMinutes(item) <= 90);
    text = text.replace(/\bshort\b/g, ' ');
  }
  if (/\blong\b/.test(text)) {
    rules.push((item) => runtimeMinutes(item) != null && runtimeMinutes(item) >= 150);
    text = text.replace(/\blong\b/g, ' ');
  }
  if (/\bbingeable\b/.test(text)) {
    rules.push((item) => item.type === 'show' && runtimeMinutes(item) != null && runtimeMinutes(item) <= 45);
    text = text.replace(/\bbingeable\b/g, ' ');
  }

  if (/\b(family friendly|family|kids|kid friendly)\b/.test(text)) {
    rules.push((item) => isFriendlyContent(item) || /\b(family|kids|children)\b/.test(keywordText(item)));
    text = text.replace(/\b(family friendly|family|kids|kid friendly)\b/g, ' ');
  }

  if (/\bhigh confidence\b/.test(text)) {
    rules.push((item) => voteCount(item) >= 1000);
    text = text.replace(/\bhigh confidence\b/g, ' ');
  }
  if (/\blow confidence\b/.test(text)) {
    rules.push((item) => voteCount(item) > 0 && voteCount(item) < 100);
    text = text.replace(/\blow confidence\b/g, ' ');
  }
  if (/\bhidden gem(s)?\b/.test(text)) {
    rules.push((item) => effectiveRating(item) >= 7 && voteCount(item) > 0 && voteCount(item) < 5000);
    text = text.replace(/\bhidden gem(s)?\b/g, ' ');
  }

  if (/\bclassic(s)?\b/.test(text)) {
    rules.push((item) => item.year != null && item.year <= 1980);
    text = text.replace(/\bclassic(s)?\b/g, ' ');
  }
  if (/\brecently added\b/.test(text)) {
    const cutoff = Date.now() / 1000 - 30 * 24 * 60 * 60;
    rules.push((item) => Number(item.addedAt || 0) >= cutoff);
    text = text.replace(/\brecently added\b/g, ' ');
  }

  const phrases = [];
  text = text.replace(/"([^"]+)"/g, (_, phrase) => {
    if (phrase.trim()) phrases.push(phrase.trim());
    return ' ';
  });

  const terms = text
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  return { rules, terms: [...phrases, ...terms] };
}

// A search is a few words. Only this much of one is read, so the number of
// words every title is compared with has a ceiling. It covers a search kept
// in a saved view or in saved criteria too, since they come through here.
const MAX_SEARCH_CHARS = 500;

// `parsed` is the search already read into rules and words. applyFilters reads
// it once and hands the same result to every title.
function matchesKeywordSearch(item, query, parsed = smartSearchRules(query)) {
  const { rules, terms } = parsed;
  if (!rules.every((rule) => rule(item))) return false;
  if (terms.length === 0) return true;

  const text = keywordText(item);
  return terms.every((term) => text.includes(term));
}

/**
 * Apply filters and sorting to an array of enriched media items.
 *
 * @param {Array} items - Enriched Plex items with ratings
 * @param {Object} filters - Filter/sort criteria
 * @returns {Array} Filtered and sorted items
 */
export function applyFilters(items, filters = {}) {
  let result = [...items];

  // Filter by type
  if (filters.type && filters.type !== 'all') {
    result = result.filter((item) => item.type === filters.type);
  }

  // Filter by minimum IMDB rating
  if (filters.minRating != null) {
    const min = parseFloat(filters.minRating);
    result = result.filter(
      (item) => effectiveRating(item) >= min
    );
  }

  // Filter by minimum TMDB rating
  if (filters.minTmdbRating != null) {
    const min = parseFloat(filters.minTmdbRating);
    result = result.filter(
      (item) => item.tmdbRating != null && item.tmdbRating >= min
    );
  }

  // Filter by minimum Rotten Tomatoes score
  if (filters.minRottenTomatoes != null) {
    const min = parseInt(filters.minRottenTomatoes, 10);
    result = result.filter(
      (item) => item.rottenTomatoes != null && item.rottenTomatoes >= min
    );
  }

  // Filter by genres (OR logic — item matches if it has any of the specified genres)
  if (filters.genres && filters.genres.length > 0) {
    const genreSet = new Set(
      filters.genres.map((g) => g.toLowerCase())
    );
    result = result.filter(
      (item) =>
        item.genres &&
        item.genres.some((g) => genreSet.has(g.toLowerCase()))
    );
  }

  // Exclude genres — item is removed if it has ANY of the excluded genres
  if (filters.excludeGenres && filters.excludeGenres.length > 0) {
    const excludeSet = new Set(
      filters.excludeGenres.map((g) => g.toLowerCase())
    );
    result = result.filter(
      (item) =>
        !item.genres ||
        !item.genres.some((g) => excludeSet.has(g.toLowerCase()))
    );
  }

  // Exclude content ratings (e.g., ['TV-MA', 'R', 'NC-17'])
  if (filters.excludeContentRatings && filters.excludeContentRatings.length > 0) {
    const excludeSet = new Set(
      filters.excludeContentRatings.map((r) => r.toUpperCase())
    );
    result = result.filter(
      (item) =>
        !item.contentRating ||
        !excludeSet.has(item.contentRating.toUpperCase())
    );
  }

  // Filter by actor name (case-insensitive partial match)
  if (filters.actor) {
    const actorTerm = filters.actor.toLowerCase();
    result = result.filter(
      (item) =>
        item.actors &&
        item.actors.some((a) => a.toLowerCase().includes(actorTerm))
    );
  }

  // Filter by director name (case-insensitive partial match)
  if (filters.director) {
    const dirTerm = filters.director.toLowerCase();
    result = result.filter(
      (item) =>
        item.director &&
        item.director.toLowerCase().includes(dirTerm)
    );
  }

  // Filter by minimum runtime (minutes). item.duration is in milliseconds.
  if (filters.minRuntime != null) {
    const minMs = parseFloat(filters.minRuntime) * 60 * 1000;
    result = result.filter(
      (item) => item.duration != null && item.duration >= minMs
    );
  }

  // Filter by maximum runtime (minutes)
  if (filters.maxRuntime != null) {
    const maxMs = parseFloat(filters.maxRuntime) * 60 * 1000;
    result = result.filter(
      (item) => item.duration != null && item.duration <= maxMs
    );
  }

  // Filter by release date (YYYY-MM-DD) — released after
  if (filters.releasedAfter) {
    result = result.filter(
      (item) =>
        item.originallyAvailableAt &&
        item.originallyAvailableAt >= filters.releasedAfter
    );
  }

  // Filter by release date (YYYY-MM-DD) — released before
  if (filters.releasedBefore) {
    result = result.filter(
      (item) =>
        item.originallyAvailableAt &&
        item.originallyAvailableAt <= filters.releasedBefore
    );
  }

  // Exclude watched items (viewCount > 0)
  if (filters.excludeWatched) {
    result = result.filter(
      (item) => !item.viewCount || item.viewCount === 0
    );
  }

  // Filter by year range
  if (filters.yearFrom != null) {
    const from = parseInt(filters.yearFrom, 10);
    result = result.filter((item) => item.year != null && item.year >= from);
  }
  if (filters.yearTo != null) {
    const to = parseInt(filters.yearTo, 10);
    result = result.filter((item) => item.year != null && item.year <= to);
  }

  // Keyword search across title, plot, genres, cast, crew, studio, and rating.
  // The search is read once for the whole list. It used to be read again for
  // every title (about thirty passes over the text each time), so the work
  // was the size of the library multiplied by the length of the search, and a
  // very long search over a large library held the whole app up for seconds.
  if (filters.search) {
    const search = String(filters.search).slice(0, MAX_SEARCH_CHARS);
    const parsed = smartSearchRules(search);
    result = result.filter((item) => matchesKeywordSearch(item, search, parsed));
  }

  // Sort
  const sortBy = filters.sortBy || 'title';
  const sortOrder = filters.sortOrder === 'asc' ? 1 : -1;

  result.sort((a, b) => {
    let valA, valB;

    switch (sortBy) {
      case 'rating':
        valA = effectiveRating(a);
        valB = effectiveRating(b);
        break;
      case 'rottenTomatoes':
        valA = a.rottenTomatoes ?? -1;
        valB = b.rottenTomatoes ?? -1;
        break;
      case 'year':
        valA = a.year ?? 0;
        valB = b.year ?? 0;
        break;
      case 'added':
        valA = a.originallyAvailableAt || '';
        valB = b.originallyAvailableAt || '';
        break;
      case 'title':
      default:
        valA = (a.title || '').toLowerCase();
        valB = (b.title || '').toLowerCase();
        return valA < valB ? -1 * sortOrder : valA > valB ? 1 * sortOrder : 0;
    }

    return (valA - valB) * sortOrder;
  });

  return result;
}
