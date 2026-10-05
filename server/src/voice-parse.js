/**
 * Parse a natural language voice query into the filter object the existing
 * applyFilters() engine understands. This is a regex-based parser — predictable,
 * no LLM dependency, fast enough for a phone press-and-hold. Returns a partial
 * filter object that the client merges into its current filter state.
 */

import { MOODS } from './mood-presets.js';

const GENRE_KEYWORDS = {
  action: 'Action',
  thriller: 'Thriller',
  comedy: 'Comedy',
  comedies: 'Comedy',
  funny: 'Comedy',
  horror: 'Horror',
  scary: 'Horror',
  romance: 'Romance',
  romantic: 'Romance',
  drama: 'Drama',
  documentary: 'Documentary',
  documentaries: 'Documentary',
  doc: 'Documentary',
  scifi: 'Sci-Fi',
  'sci-fi': 'Sci-Fi',
  'science fiction': 'Science Fiction',
  fantasy: 'Fantasy',
  animation: 'Animation',
  animated: 'Animation',
  family: 'Family',
  mystery: 'Mystery',
  crime: 'Crime',
  war: 'War',
  western: 'Western',
  musical: 'Music',
  music: 'Music',
};

// People say "under two hours", not "under 2 hours". Without this the length
// half of a request is silently dropped.
const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  ninety: 90, sixty: 60, thirty: 30, forty: 40, fifty: 50,
  'an hour': 1, 'a hour': 1,
};

function numeralise(text) {
  let out = text;
  for (const [word, value] of Object.entries(WORD_NUMBERS)) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'g'), String(value));
  }
  return out;
}

function parseRuntime(rawText) {
  const text = numeralise(rawText);
  const underMin = text.match(/under\s+(\d+)\s*(?:min|minute|minutes|mins)/);
  if (underMin) return { maxRuntime: parseInt(underMin[1], 10) };
  const underHr = text.match(/under\s+(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs)/);
  if (underHr) return { maxRuntime: Math.round(parseFloat(underHr[1]) * 60) };
  const overHr = text.match(/(?:over|at least|more than)\s+(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs)/);
  if (overHr) return { minRuntime: Math.round(parseFloat(overHr[1]) * 60) };
  const overMin = text.match(/(?:over|at least|more than)\s+(\d+)\s*(?:min|minute|minutes|mins)/);
  if (overMin) return { minRuntime: parseInt(overMin[1], 10) };
  return null;
}

function parseYear(text) {
  const decade = text.match(/(?:the\s+)?(\d{2})(?:'?s)/);
  if (decade) {
    const yy = parseInt(decade[1], 10);
    const base = yy >= 30 ? 1900 + yy : 2000 + yy;
    return { yearFrom: base, yearTo: base + 9 };
  }
  const decade4 = text.match(/(?:the\s+)?(19\d0|20[012]0)s/);
  if (decade4) {
    const base = parseInt(decade4[1], 10);
    return { yearFrom: base, yearTo: base + 9 };
  }
  const since = text.match(/(?:since|after|from)\s+(\d{4})/);
  if (since) return { yearFrom: parseInt(since[1], 10) };
  const before = text.match(/before\s+(\d{4})/);
  if (before) return { yearTo: parseInt(before[1], 10) };
  return null;
}

function parseRating(text) {
  const m = text.match(/(?:rated\s+)?(?:above|over|higher than|more than)\s+(\d(?:\.\d)?)/);
  if (m) return { minRating: parseFloat(m[1]) };
  if (/\b(highly|critically|well)\s+(rated|reviewed|acclaimed)\b/.test(text)) return { minRating: 7.5 };
  if (/\bclassic(s)?\b/.test(text)) return { minRating: 8 };
  return null;
}

function parseGenres(text) {
  const include = [];
  for (const [keyword, canonical] of Object.entries(GENRE_KEYWORDS)) {
    const re = new RegExp(`\\b${keyword.replace('-', '\\-')}\\b`, 'i');
    if (re.test(text)) include.push(canonical);
  }
  if (include.length === 0) return null;
  return { genres: Array.from(new Set(include)) };
}

// A typed or spoken request is one sentence. Only this much of it is read,
// so the work done for one request does not depend on how much text arrived:
// the routes accept a body of about 100,000 characters, and a text that long
// held the whole app up for a second (see parseActor).
export const MAX_REQUEST_CHARS = 500;

// "with tom hanks", up to the end of the name: a full stop, a comma, the end
// of the text, or one of a few words. The ending is only looked at, and the
// name has a longest length, so a "with" that no ending follows costs a fixed
// amount. Before, each such "with" was followed to the end of the text, and
// a text made of thousands of them took time that grew with the square of
// its length. The longest name is the longest text that is read, so no
// sentence gets a different answer than it did.
const ACTOR = new RegExp(
  `(?:starring|with|featuring)\\s+([a-z][a-z ]{1,${MAX_REQUEST_CHARS}}?)(?=\\.|,|$| in | from | under | rated)`,
  'i'
);

export function parseActor(text) {
  const starring = text.match(ACTOR);
  if (starring) {
    return { actor: starring[1].trim() };
  }
  return null;
}

function parseMood(text) {
  for (const mood of MOODS) {
    const re = new RegExp(`\\b(?:something\\s+)?${mood.id}\\b`, 'i');
    if (re.test(text) || new RegExp(`\\b${mood.label}\\b`, 'i').test(text)) {
      return { mood: mood.id, ...mood.filters };
    }
  }
  return null;
}

function parseType(text) {
  if (/\b(?:tv|show|series|episode|episodes)\b/i.test(text)) return { type: 'show' };
  if (/\b(?:movie|movies|film|films|flick|flicks)\b/i.test(text)) return { type: 'movie' };
  return null;
}

// "nothing sad", "no horror", "not scary" — the half of a request that says
// what someone does NOT want, which is often the more important half.
const EXCLUSION_WORDS = {
  sad: ['Drama'],
  depressing: ['Drama', 'War'],
  heavy: ['Drama', 'War'],
  scary: ['Horror', 'Thriller'],
  horror: ['Horror'],
  violent: ['War', 'Crime'],
  romantic: ['Romance'],
  romance: ['Romance'],
  animated: ['Animation'],
  cartoon: ['Animation'],
  documentary: ['Documentary'],
};

function parseExclusions(text) {
  const excluded = new Set();
  for (const [word, genres] of Object.entries(EXCLUSION_WORDS)) {
    const pattern = new RegExp(`\\b(?:nothing|no|not|non|without|avoid)\\s+(?:too\\s+)?${word}\\b`);
    if (pattern.test(text)) genres.forEach((g) => excluded.add(g));
  }
  return excluded.size ? { excludeGenres: Array.from(excluded) } : null;
}

export function parseVoiceQuery(transcript) {
  if (!transcript || typeof transcript !== 'string') return { filters: {}, transcript: '' };

  // Cut before anything else looks at it, so every pattern below works on a
  // sentence, whatever was sent.
  const text = transcript.slice(0, MAX_REQUEST_CHARS).toLowerCase().trim();
  const merged = Object.assign(
    {},
    parseRuntime(text),
    parseYear(text),
    parseRating(text),
    parseGenres(text),
    parseActor(text),
    parseMood(text),
    parseType(text),
    parseExclusions(text),
  );

  // "nothing scary" reads as both a request for Horror and a refusal of it,
  // because the genre keyword matcher does not see the negation in front of it.
  // The refusal wins: nobody says "nothing scary" hoping for a horror film.
  if (merged.excludeGenres?.length && merged.genres?.length) {
    const refused = new Set(merged.excludeGenres);
    merged.genres = merged.genres.filter((g) => !refused.has(g));
    if (merged.genres.length === 0) delete merged.genres;
  }

  return { filters: merged, transcript };
}
