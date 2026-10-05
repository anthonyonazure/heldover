// A search is read into rules ("unwatched", "4k", "under 90") and words. That
// reading, about thirty passes over the text, was done again for every title
// in the library, and nothing limited the length of the text. So the work was
// the size of the library multiplied by the length of the search: one long
// search over a 10,000-title library held the whole app up for two seconds,
// and any device that may look could send it.
//
// The search is now read once for the whole list. Every screen searches
// through this function, so the results must not move: each text below is
// run both ways over a dummy library, the app's way and the way it was
// (helpers/search-as-it-was.js, a copy of the old check), and the two must
// give the same titles in the same order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters } from '../src/filters.js';
import { matchesKeywordSearch as matchedBefore } from './helpers/search-as-it-was.js';

const MIN = 60 * 1000;
const NOW_S = Math.floor(Date.now() / 1000);

const TITLES = [
  'Alpha Heist', 'Quiet River', 'The Long Goodbye Road', 'Desert Storm Rising', 'Short Circuit City', 'Midnight Garden',
  'Paper Lanterns', 'Iron Harbor', 'Second Summer', 'The Watched Pot', 'Glass Mountain', 'Family Table',
];
const SUMMARIES = [
  'A heist in the desert goes wrong for a retired safecracker.',
  'Two sisters follow a quiet river back to the town they left.',
  'A long drive across the country with a stranger and a dog.',
  'Kids build a rocket in the summer of 1994.',
  'A detective who has never watched a film solves a case in a cinema.',
  'An in progress portrait of a chef, filmed over ten years.',
];
const GENRES = ['Comedy', 'Drama', 'Horror', 'Sci-Fi', 'Family', 'Documentary', 'Thriller', 'Animation'];
const ACTORS = ['Tom Dummy', 'Ada Example', 'Lee Placeholder', 'Sam Standin', 'Kim Sample'];
const RATINGS = ['G', 'PG', 'PG-13', 'R', 'TV-MA', 'TV-PG', undefined];
const LANGUAGES = ['en', 'fr', 'ja', 'ko'];
const RUNTIMES = [25, 44, 88, 95, 120, 151, 185, null];
const PICTURE = [
  { videoResolution: '4k', width: 3840, videoCodec: 'hevc', audioCodec: 'truehd', videoDynamicRange: 'HDR10', file: '2160p.x265.Atmos' },
  { videoResolution: '1080', width: 1920, videoCodec: 'h264', audioCodec: 'eac3', videoDynamicRange: 'SDR', file: '1080p.x264' },
  { videoResolution: '720', width: 1280, videoCodec: 'h264', audioCodec: 'aac', videoDynamicRange: 'SDR', file: '720p.HD' },
  { videoResolution: 'sd', width: 720, videoCodec: 'mpeg4', audioCodec: 'mp3', videoDynamicRange: null, file: 'dvd' },
];

// Ninety-six titles that between them have every kind of thing a search can
// ask about: watched and not, part watched, every picture quality, short and
// long, old and new, well known and barely rated.
const library = Array.from({ length: 96 }, (_, i) => {
  const picture = PICTURE[i % PICTURE.length];
  const title = `${TITLES[i % TITLES.length]} ${i}`;
  const runtime = RUNTIMES[i % RUNTIMES.length];
  const watched = i % 3 === 0;
  return {
    ratingKey: String(i),
    title,
    originalTitle: i % 9 === 0 ? `Titre Original ${i}` : undefined,
    summary: SUMMARIES[i % SUMMARIES.length],
    tagline: i % 4 === 0 ? 'A classic in the making' : undefined,
    studio: i % 2 ? 'Dummy Pictures' : 'Placeholder Films',
    director: i % 5 === 0 ? 'Pat Director' : 'Robin Helmer',
    type: i % 5 === 0 ? 'show' : 'movie',
    year: 1950 + ((i * 7) % 75),
    duration: runtime == null ? undefined : runtime * MIN,
    viewCount: watched ? 2 : 0,
    lastViewedAt: watched ? NOW_S - 86400 : undefined,
    viewOffset: i % 4 === 1 ? 600000 : undefined,
    contentRating: RATINGS[i % RATINGS.length],
    imdbRating: [9.1, 7.4, 6.2, null][i % 4],
    imdbVoteCount: [40, 2500, 90000, null][i % 4],
    tmdbRating: [7.2, 6.8, null][i % 3],
    tmdbVoteCount: [60, 1200, null][i % 3],
    addedAt: i % 6 === 0 ? NOW_S - 5 * 86400 : NOW_S - 400 * 86400,
    originallyAvailableAt: `${1950 + ((i * 7) % 75)}-06-01`,
    genres: [GENRES[i % GENRES.length], GENRES[(i * 3 + 1) % GENRES.length]],
    actors: [ACTORS[i % ACTORS.length], ACTORS[(i + 2) % ACTORS.length]],
    writers: ['Wren Writer'],
    collections: i % 8 === 0 ? ['Dummy Collection'] : [],
    countries: [i % 2 ? 'France' : 'United States'],
    tmdbLanguage: LANGUAGES[i % LANGUAGES.length],
    tmdbKeywords: i % 7 === 0 ? ['time travel', 'robot'] : ['friendship'],
    serverName: i % 2 ? 'Den server' : 'Attic server',
    libraryTitle: i % 5 === 0 ? 'TV Shows' : 'Films',
    resolution: picture.videoResolution,
    hdr: picture.videoDynamicRange === 'HDR10' ? 'HDR' : undefined,
    audioCodec: picture.audioCodec,
    media: [
      {
        videoResolution: picture.videoResolution,
        videoCodec: picture.videoCodec,
        audioCodec: picture.audioCodec,
        container: 'mkv',
        width: picture.width,
        videoDynamicRange: picture.videoDynamicRange,
        duration: runtime == null ? undefined : runtime * MIN,
        parts: [{ file: `/dummy/${title}/${title}.${picture.file}.mkv` }],
      },
    ],
  };
});

// What a person types into the search box: plain words, phrases in quotes,
// and the words the search understands as rules, alone and mixed.
const SEARCHES = [
  // Plain words.
  'alpha', 'ALPHA Heist', '  quiet   river ', 'heist desert', 'nosuchword', 'river nosuchword', 'dummy', 'placeholder films',
  'tom', 'ada example', 'pat director', 'french', 'japanese', 'korean', 'france', 'mkv', 'friendship', 'time travel robot',
  'comedy', 'drama horror', 'sci-fi', 'documentary', 'thriller animation', 'tv shows', 'attic', 'r', 'pg-13', 'tv-ma',
  '7', '42', '1994', '1990 2000', '1990-1999', 'from 1990 to 1999', 'the 80s', 'x264', 'truehd', 'café', 'alpha, heist', 'alpha.heist',
  // Phrases in quotes.
  '"heist in the desert"', '"quiet river"', '"quiet river" sisters', '"quiet river" nosuchword', '"no such phrase"', '""', '" "',
  '"unclosed quote', 'alpha "heist in" desert', '"Heist In The Desert" "retired safecracker"', '"short circuit"', '"never watched"',
  // Watched or not.
  'unwatched', 'watched', 'never watched', 'not watched', 'unwatched comedy', 'watched drama', 'unwatched watched',
  'partial', 'partially watched', 'in progress', 'in progress chef',
  // Picture and sound.
  '4k', 'uhd', '2160p', '1080p', 'full hd', '720p', 'hd', 'hdr', 'atmos', 'dolby', 'hevc', 'h265', 'x265', '4k hdr atmos', '1080p hevc',
  // Length.
  'under 90', 'under 90 min', 'under 90m', 'under 45 minutes', 'less than 100', 'shorter than 30 min', 'over 150', 'over 150 minutes',
  'more than 120 min', 'longer than 180', 'over 60 under 120', 'under 9000', 'under ninety', 'short', 'long', 'bingeable',
  // Who it is for, and how well known.
  'family', 'family friendly', 'kids', 'kid friendly', 'high confidence', 'low confidence', 'hidden gem', 'hidden gems',
  'classic', 'classics', 'recently added',
  // Mixed, the way people use them.
  'unwatched 4k', 'unwatched 4k hdr comedy under 120', 'long "heist in the desert"', 'classic "quiet river"', 'recently added unwatched',
  'short comedy', 'long drama watched', 'family friendly under 100 unwatched', 'hidden gem sci-fi', 'high confidence classic thriller',
  'bingeable recently added', 'french unwatched 1080p', 'tom under 120 hd', 'kids animation short', 'Unwatched 4K HDR',
];

/** The titles the old check let through, sorted the way the app sorts. */
const before = (search, others = {}) => applyFilters(library.filter((item) => matchedBefore(item, search)), others);

test('every ordinary search gives the same titles, in the same order, as it did before', () => {
  let narrowed = 0;
  for (const search of SEARCHES) {
    const now = applyFilters(library, { search });
    assert.deepEqual(now, before(search), `search: ${search}`);
    if (now.length > 0 && now.length < library.length) narrowed += 1;
  }
  // The comparison means something only if the searches really pick titles.
  assert.ok(narrowed >= 80, `${narrowed} of ${SEARCHES.length} searches matched some titles and not others`);
});

test('a search combined with the other filters and a sort order is unchanged too', () => {
  const others = [
    { type: 'movie', sortBy: 'year', sortOrder: 'asc' },
    { genres: ['Comedy', 'Drama'], sortBy: 'rating' },
    { excludeWatched: true, minRuntime: 60, sortBy: 'added' },
    { yearFrom: 1980, yearTo: 2010, excludeContentRatings: ['R', 'TV-MA'] },
  ];
  for (const filters of others) {
    for (const search of SEARCHES) {
      assert.deepEqual(applyFilters(library, { ...filters, search }), before(search, filters), `search: ${search}`);
    }
  }
});

test('a search that is not text (a number, the same field sent twice) is read as before', () => {
  for (const search of [1994, ['alpha', 'heist'], ['unwatched', '4k']]) {
    assert.deepEqual(applyFilters(library, { search }), before(search), `search: ${String(search)}`);
  }
});

test('the search is read once for the whole library, not once for every title', () => {
  let read = 0;
  const search = { toString() { read += 1; return 'unwatched 4k'; } };
  const found = applyFilters(library, { search });
  assert.deepEqual(found, before('unwatched 4k'));
  assert.equal(read, 1, `the search text was read ${read} times for ${library.length} titles`);
});

test('a search of 500 characters is read to its last word', () => {
  // 496 characters that every title matches, then one word that none does.
  const search = `${'dummy '.repeat(83)}zzzq`.slice(-500);
  assert.equal(search.length, 500);
  assert.equal(applyFilters(library, { search: 'dummy' }).length, library.length);
  assert.deepEqual(applyFilters(library, { search }), []);
});

test('only the first 500 characters of a search are read', () => {
  const alpha = applyFilters(library, { search: 'alpha' });
  assert.ok(alpha.length > 0 && alpha.length < library.length);
  // A word past the limit no longer narrows the search...
  assert.deepEqual(applyFilters(library, { search: `alpha${' '.repeat(500)}zzzq` }), alpha);
  // ...and neither does a rule: the first 500 characters decide.
  assert.deepEqual(applyFilters(library, { search: `alpha ${'heist '.repeat(90)} unwatched 4k` }), applyFilters(library, { search: 'alpha heist' }));
});
