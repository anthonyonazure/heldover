// The library every device is served keeps its ratings, whatever a device that
// may only look asks for. A GET with skipRatings=true used to store the fresh
// Plex items, which carry no ratings, over the shared copy, and everyone was
// then served a library with every rating gone for six hours.
// Runs against a throwaway data folder and a stand-in Plex server.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { DUMMY_TOKEN, listenForTest, startStandInPlex, stubPlexTv, until } from './helpers/stand-in-plex.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = DUMMY_TOKEN;
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY']) delete process.env[key];

const SERVER = 'stand-in-ratings';
const plex = await startStandInPlex({
  serverKey: SERVER,
  sections: [{ key: '1', type: 'movie', title: 'Films' }],
  // A Plex answer carries no imdbRating, rottenTomatoes or tmdbRating.
  items: { 1: [{ ratingKey: '10', title: 'Dummy Film', year: 2001, type: 'movie' }] },
});
const refused = stubPlexTv([plex]);

const { app } = await import('../src/app.js');
await import('../src/routes/library.js');
const cache = await import('../src/library-cache.js');
const store = await import('../src/ratings-store.js');
const { call, close } = await listenForTest(app);

after(async () => {
  await close();
  await plex.stop();
});

// Ratings on file for the dummy title, as after a normal lookup.
store.upsertCache.run({
  plex_key: store.ratingsKeyFor('10', 'Dummy Film', 2001), title: 'Dummy Film', year: 2001, tmdb_id: 1, tmdb_rating: 7.1, tmdb_vote_count: 900,
  imdb_id: 'tt0000001', imdb_rating: 7.7, imdb_vote_count: 5000, rotten_tomatoes_score: 88, metacritic_score: 70, poster_url: null,
  fetched_at: new Date().toISOString(), letterboxd_rating: null, trakt_rating: null, rt_audience_score: null, mdblist_score: null,
  mdblist_fetched_at: null, type: 'movie', tvdb_id: null, tmdb_keywords: '[]', tmdb_language: 'en', tmdb_countries: '[]',
  backdrop_url: null, clearlogo_url: null, fanart_fetched_at: null,
});

const storedRating = () => cache.getCachedItems(SERVER, '1')?.items?.[0]?.imdbRating ?? null;
const ratedRow = () => until(() => storedRating() === 7.7, 'the shared copy to hold its ratings');

test('the owner opens a library and the shared copy holds its ratings', async () => {
  const first = await call('GET', `/api/library/${SERVER}/1`);
  assert.equal(first.status, 200);
  await ratedRow();
  const second = await call('GET', `/api/library/${SERVER}/1`);
  assert.equal(second.body.fromCache, true);
  assert.equal(second.body.items[0].imdbRating, 7.7);
});

test('a look-only device asking for skipRatings cannot strip the ratings from the shared copy', async () => {
  const who = await call('GET', '/api/auth/status', { lookOnly: true });
  assert.equal(who.body.canChange, false, 'the app sees this device as look-only');

  const forced = await call('GET', `/api/library/${SERVER}/1?refresh=true&skipRatings=true`, { lookOnly: true });
  assert.equal(forced.status, 200);
  // Give any background work the old code started time to finish.
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(storedRating(), 7.7, 'the stored copy still has its rating');
  const owner = await call('GET', `/api/library/${SERVER}/1`);
  assert.equal(owner.body.items[0].imdbRating, 7.7, 'and the owner is still served it');
  assert.equal(owner.body.items[0].rottenTomatoes, 88);
});

test('a forced re-read from a look-only device is still a read, and keeps the ratings', async () => {
  const before = plex.readsOf(1);
  const forced = await call('GET', `/api/library/${SERVER}/1?refresh=true`, { lookOnly: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.fromCache, false);
  assert.equal(plex.readsOf(1), before + 1, 'Plex was asked again');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(storedRating(), 7.7);
});

test('a stale copy refreshed in the background keeps its ratings, with or without skipRatings', async () => {
  // Age the stored copy past six hours, the way time would.
  const db = new Database(path.join(process.env.DATA_DIR, 'ratings.db'));
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE library_items_cache SET fetched_at = ? WHERE cache_key = ?').run(old, `${SERVER}:1`);
  db.close();
  assert.equal(cache.getCachedItems(SERVER, '1').stale, true);

  const served = await call('GET', `/api/library/${SERVER}/1?skipRatings=true`, { lookOnly: true });
  assert.equal(served.body.stale, true, 'the stale copy is served at once');

  await until(() => cache.getCachedItems(SERVER, '1').stale === false, 'the background refresh to store a new copy');
  assert.equal(storedRating(), 7.7, 'the refreshed copy still has its rating');
});

test('the unused streaming variant of the library route is gone', async () => {
  const before = plex.pagesOf(1);
  const res = await call('GET', `/api/library/${SERVER}/1/stream?skipRatings=true`, { lookOnly: true });
  assert.equal(res.status, 404);
  assert.equal(plex.pagesOf(1), before, 'and Plex is not asked');
});

test('nothing in these checks left this computer', () => {
  assert.deepEqual(refused, []);
});
