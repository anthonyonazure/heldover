// The search check exactly as it was before a search was read once for the
// whole list: a copy of the top of server/src/filters.js at commit a21fdfa,
// unchanged, in which every title has the search read again for itself.
// search-read-once.test.js compares the app's results with this one's. It is
// here to be compared against, not to be kept in step with filters.js.

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

export function matchesKeywordSearch(item, query) {
  const { rules, terms } = smartSearchRules(query);
  if (!rules.every((rule) => rule(item))) return false;
  if (terms.length === 0) return true;

  const text = keywordText(item);
  return terms.every((term) => text.includes(term));
}
