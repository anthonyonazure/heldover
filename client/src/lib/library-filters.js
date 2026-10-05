// Searching, filtering and sorting a library, kept apart from App.jsx so the
// rules can be read (and tested) without the page around them.

export const CONTENT_RATINGS_ALL = [
  'G', 'PG', 'PG-13', 'R', 'NC-17',
  'TV-Y', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA',
];

export const DEFAULT_FILTERS = {
  search: '',
  mediaType: 'all',
  minImdb: 0,
  minRt: 0,
  genres: [],
  excludeGenres: [],
  contentRatings: [...CONTENT_RATINGS_ALL],
  actor: '',
  director: '',
  minRuntime: null,
  maxRuntime: null,
  releasedAfter: null,
  releasedBefore: null,
  excludeWatched: false,
  hideDisliked: false,
  likedOnly: false,
  yearFrom: null,
  yearTo: null,
  sortBy: 'imdb',
  sortOrder: 'desc',
};

export const LANGUAGE_NAMES = {
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

export function keywordText(item) {
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

export function runtimeMinutes(item) {
  const duration = item.duration || item.media?.[0]?.duration;
  return duration ? duration / 60000 : null;
}

export function isFriendlyContent(item) {
  return ['G', 'PG', 'TV-Y', 'TV-G', 'TV-PG'].includes(item.contentRating);
}

export function voteCount(item) {
  return Math.max(item.imdbVoteCount || 0, item.tmdbVoteCount || 0);
}

export function isSuspiciousHighImdb(item) {
  if (item.imdbRating == null || item.imdbRating < 8.5) return false;
  if (item.imdbVoteCount == null) return true;
  return item.imdbVoteCount < 100;
}

export function effectiveRating(item) {
  if (!isSuspiciousHighImdb(item) && item.imdbRating != null) return item.imdbRating;
  return item.tmdbRating ?? item.imdbRating ?? -1;
}

export function hasQuality(item, pattern) {
  return pattern.test(keywordText(item));
}

export function smartSearchRules(query) {
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

export function matchesKeywordSearch(item, query) {
  const { rules, terms } = smartSearchRules(query);
  if (!rules.every((rule) => rule(item))) return false;
  if (terms.length === 0) return true;

  const text = keywordText(item);
  return terms.every((term) => text.includes(term));
}

// Where you were, kept between visits.
//
// Nothing about the session used to survive a reload, and on a phone a reload
// is not a rare event: leaving the app and coming back to it later is usually
// enough. You would return to "select a library" every time, having lost the
// library you were browsing and any filters you had set up.
//
// The address bar cannot carry this. Once the app is installed to a home
// screen it always relaunches at "/", so anything kept in the URL is gone by
// the time you see the app again. It has to be written down locally.

/** The items that pass every filter, in the chosen sort order. */
export function applyLibraryFilters(items, filters) {
  let result = [...items];

  // Search
  if (filters.search) {
    result = result.filter((item) => matchesKeywordSearch(item, filters.search));
  }

  // Media type
  if (filters.mediaType !== 'all') {
    result = result.filter((item) => item.type === filters.mediaType);
  }

  // Min IMDB (falls back to TMDB rating if IMDB unavailable)
  if (filters.minImdb > 0) {
    result = result.filter((item) => {
      const rating = effectiveRating(item);
      return rating != null && rating >= filters.minImdb;
    });
  }

  // Min RT (falls back to TMDB percentage if RT unavailable)
  if (filters.minRt > 0) {
    result = result.filter((item) => {
      if (item.rottenTomatoes != null) return item.rottenTomatoes >= filters.minRt;
      // Fall back to TMDB as percentage (multiply by 10)
      if (item.tmdbRating != null) return (item.tmdbRating * 10) >= filters.minRt;
      return false;
    });
  }

  // Include Genres
  if (filters.genres && filters.genres.length > 0) {
    result = result.filter((item) =>
      filters.genres.some((g) => (item.genres || []).includes(g))
    );
  }

  // Exclude Genres
  if (filters.excludeGenres && filters.excludeGenres.length > 0) {
    result = result.filter((item) =>
      !filters.excludeGenres.some((g) => (item.genres || []).includes(g))
    );
  }

  // Content Ratings
  if (filters.contentRatings && filters.contentRatings.length > 0 && filters.contentRatings.length < CONTENT_RATINGS_ALL.length) {
    result = result.filter((item) => {
      if (!item.contentRating) return true; // Keep items without a content rating
      return filters.contentRatings.includes(item.contentRating);
    });
  }

  // Actor
  if (filters.actor) {
    const actorLower = filters.actor.toLowerCase();
    result = result.filter((item) =>
      (item.actors || []).some((a) => {
        const name = typeof a === 'string' ? a : a.name || a.tag || '';
        return name.toLowerCase().includes(actorLower);
      })
    );
  }

  // Director
  if (filters.director) {
    const dirLower = filters.director.toLowerCase();
    result = result.filter((item) => {
      const dir = item.director || '';
      const dirs = Array.isArray(item.directors) ? item.directors : [dir];
      return dirs.some((d) => {
        const name = typeof d === 'string' ? d : d.name || d.tag || '';
        return name.toLowerCase().includes(dirLower);
      });
    });
  }

  // Runtime range (duration is in ms from Plex)
  if (filters.minRuntime) {
    const minMs = filters.minRuntime * 60000;
    result = result.filter((item) => item.duration && item.duration >= minMs);
  }
  if (filters.maxRuntime) {
    const maxMs = filters.maxRuntime * 60000;
    result = result.filter((item) => item.duration && item.duration <= maxMs);
  }

  // Release date range
  if (filters.releasedAfter) {
    const afterTime = new Date(filters.releasedAfter).getTime();
    result = result.filter((item) => {
      if (!item.originallyAvailableAt) return false;
      return new Date(item.originallyAvailableAt).getTime() >= afterTime;
    });
  }
  if (filters.releasedBefore) {
    const beforeTime = new Date(filters.releasedBefore).getTime();
    result = result.filter((item) => {
      if (!item.originallyAvailableAt) return false;
      return new Date(item.originallyAvailableAt).getTime() <= beforeTime;
    });
  }

  // Exclude watched
  if (filters.excludeWatched) {
    result = result.filter((item) => !item.viewCount || item.viewCount === 0);
  }

  // Year range
  if (filters.yearFrom) {
    result = result.filter((item) => item.year && item.year >= filters.yearFrom);
  }
  if (filters.yearTo) {
    result = result.filter((item) => item.year && item.year <= filters.yearTo);
  }

  // Personal rating filters
  if (filters.hideDisliked) {
    result = result.filter((item) => item.personalRating !== 'down');
  }
  if (filters.likedOnly) {
    result = result.filter((item) => item.personalRating === 'up');
  }

  // Sort
  const sortKey = filters.sortBy;
  const dir = filters.sortOrder === 'asc' ? 1 : -1;

  result.sort((a, b) => {
    let va, vb;
    switch (sortKey) {
      case 'imdb':
        va = effectiveRating(a);
        vb = effectiveRating(b);
        break;
      case 'rt':
        va = a.rottenTomatoes ?? (a.tmdbRating != null ? a.tmdbRating * 10 : -1);
        vb = b.rottenTomatoes ?? (b.tmdbRating != null ? b.tmdbRating * 10 : -1);
        break;
      case 'tmdb':
        va = a.tmdbRating ?? -1;
        vb = b.tmdbRating ?? -1;
        break;
      case 'year':
        va = a.year ?? 0;
        vb = b.year ?? 0;
        break;
      case 'title':
        va = (a.title || '').toLowerCase();
        vb = (b.title || '').toLowerCase();
        return dir * va.localeCompare(vb);
      default:
        va = 0;
        vb = 0;
    }
    return dir * (va - vb);
  });

  return result;
}
