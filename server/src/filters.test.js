import { describe, expect, test } from 'bun:test';
import { applyFilters } from './filters.js';

const MIN = 60 * 1000;

const items = [
  {
    title: 'Alpha',
    type: 'movie',
    year: 1975,
    genres: ['Drama'],
    imdbRating: 7.2,
    imdbVoteCount: 20000,
    duration: 85 * MIN,
    contentRating: 'PG',
    viewCount: 0,
    media: [{ videoResolution: '4k' }],
  },
  {
    title: 'bravo',
    type: 'movie',
    year: 2010,
    genres: ['Comedy', 'Romance'],
    imdbRating: 9.1,
    imdbVoteCount: 40,
    tmdbRating: 6.0,
    duration: 160 * MIN,
    contentRating: 'R',
    viewCount: 3,
    summary: 'A heist in the desert',
  },
  {
    title: 'Charlie',
    type: 'show',
    year: 2020,
    genres: ['comedy'],
    imdbRating: 8.0,
    imdbVoteCount: 3000,
    duration: 30 * MIN,
    contentRating: 'TV-MA',
    viewCount: 0,
  },
];

const titles = (list) => list.map((i) => i.title);

describe('applyFilters', () => {
  test('does not mutate the input array', () => {
    const copy = [...items];
    applyFilters(items, { sortBy: 'year' });
    expect(items).toEqual(copy);
  });

  test('filters by type and ignores "all"', () => {
    expect(titles(applyFilters(items, { type: 'show' }))).toEqual(['Charlie']);
    expect(applyFilters(items, { type: 'all' })).toHaveLength(3);
  });

  test('distrusts a high IMDb score with few votes and falls back to TMDB', () => {
    // bravo has IMDb 9.1 from 40 votes, so its effective rating is TMDB 6.0.
    expect(titles(applyFilters(items, { minRating: 7, sortOrder: 'asc' }))).toEqual(['Alpha', 'Charlie']);
  });

  test('genre include is OR and case-insensitive; exclude removes any match', () => {
    expect(titles(applyFilters(items, { genres: ['COMEDY'], sortOrder: 'asc' }))).toEqual(['bravo', 'Charlie']);
    expect(titles(applyFilters(items, { excludeGenres: ['romance'], sortOrder: 'asc' }))).toEqual(['Alpha', 'Charlie']);
  });

  test('excludes content ratings regardless of case', () => {
    expect(titles(applyFilters(items, { excludeContentRatings: ['r', 'tv-ma'] }))).toEqual(['Alpha']);
  });

  test('runtime bounds are given in minutes against millisecond durations', () => {
    expect(titles(applyFilters(items, { minRuntime: 60, maxRuntime: 120 }))).toEqual(['Alpha']);
  });

  test('year range and excludeWatched combine', () => {
    expect(titles(applyFilters(items, { yearFrom: 2000, excludeWatched: true }))).toEqual(['Charlie']);
  });

  test('smart search turns words into rules and leaves the rest as text terms', () => {
    expect(titles(applyFilters(items, { search: 'unwatched 4k' }))).toEqual(['Alpha']);
    expect(titles(applyFilters(items, { search: 'long "heist in the desert"' }))).toEqual(['bravo']);
    expect(titles(applyFilters(items, { search: 'classic' }))).toEqual(['Alpha']);
    expect(titles(applyFilters(items, { search: 'under 45 min' }))).toEqual(['Charlie']);
    expect(applyFilters(items, { search: 'no such words here' })).toHaveLength(0);
  });

  test('sorts by title case-insensitively and by year, descending unless asc', () => {
    expect(titles(applyFilters(items, { sortOrder: 'asc' }))).toEqual(['Alpha', 'bravo', 'Charlie']);
    expect(titles(applyFilters(items, { sortBy: 'year' }))).toEqual(['Charlie', 'bravo', 'Alpha']);
  });
});
