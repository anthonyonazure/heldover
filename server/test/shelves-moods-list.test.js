// The front-page shelves answer a list of preset names, and every name runs
// one query over the whole index before anything is sent back. The list was
// used as it arrived: "funny" written a hundred times ran a hundred queries
// and returned a hundred copies of the same shelf, and every other device
// waited while it did. Any device that may look could send that.
//
// Asked of the real route over this computer's loopback, as a device on the
// Wi-Fi that may only look. Dummy titles, throwaway data folder, no network.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_MDNS = '1';
delete process.env.PLEX_TOKEN;
delete process.env.TRUST_PROXY;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('http://127.0.0.1:')) return realFetch(input, init);
  throw new Error('fetch failed (the tests use no network)');
};

// Imported only after DATA_DIR is set: the database opens on import.
const { MOODS } = await import('../src/mood-presets.js');
const { app } = await import('../src/app.js');
await import('../src/routes/ask-swipe-shelves.js');

// A small index: short, recent, well-rated comedies. They fill the Funny,
// Cozy, Short and New shelves and leave Epic and Mind-Bend empty.
const seed = new Database(path.join(dataDir, 'ratings.db'));
const addTitle = seed.prepare(`
  INSERT INTO corpus_index
    (server_key, rating_key, library_key, title, title_norm, year, type, thumb, genres, duration, added_at, view_count)
  VALUES ('srvA', ?, '1', ?, ?, 2021, 'movie', ?, 'Comedy', ?, ?, 0)
`);
const addRating = seed.prepare('INSERT INTO ratings_cache (plex_key, title, year, imdb_rating, imdb_vote_count) VALUES (?, ?, 2021, 7.5, 100)');
for (let i = 1; i <= 8; i++) {
  const title = `Dummy Comedy ${i}`;
  addTitle.run(String(i), title, `dummy comedy ${i}`, `/library/metadata/${i}/thumb`, 90 * 60 * 1000, Math.floor(Date.now() / 1000));
  addRating.run(`${i}|${title}|2021`, title);
}
seed.close();

const listener = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
after(() => {
  listener.close();
  globalThis.fetch = realFetch;
});
const base = `http://127.0.0.1:${listener.address().port}`;

// A request that says it was forwarded is never "this computer" to auth.js,
// so this is a device on the Wi-Fi. With no PIN set it may look and no more.
async function shelves(query) {
  const res = await realFetch(`${base}/api/shelves${query}`, { headers: { 'X-Forwarded-For': '192.168.1.50' } });
  const body = await res.json();
  return { status: res.status, ids: (body.shelves || []).map((shelf) => shelf.id) };
}

test('with no list, the usual shelves come back in their usual order', async () => {
  assert.deepEqual(await shelves(''), { status: 200, ids: ['cozy', 'short', 'new', 'funny'] });
});

test('shelves come back in the order they were asked for', async () => {
  assert.deepEqual(await shelves('?moods=funny,short'), { status: 200, ids: ['funny', 'short'] });
  assert.deepEqual(await shelves('?moods=short,%20funny%20'), { status: 200, ids: ['short', 'funny'] });
});

test('a name written many times gives one shelf, not one for every time it is written', async () => {
  const hundred = Array(100).fill('funny').join(',');
  assert.deepEqual(await shelves(`?moods=${hundred}`), { status: 200, ids: ['funny'] });
  assert.deepEqual(await shelves('?moods=short,funny,short,funny,short'), { status: 200, ids: ['short', 'funny'] });
});

test('a name the app does not know is skipped, and the rest of the list is still answered', async () => {
  assert.deepEqual(await shelves('?moods=funny,retired-preset,short,,FUNNY'), { status: 200, ids: ['funny', 'short'] });
  assert.deepEqual(await shelves('?moods=retired-preset'), { status: 200, ids: [] });
});

test('one request never builds more shelves than there are presets', async () => {
  const everything = [...MOODS, ...MOODS, ...MOODS].map((mood) => mood.id);
  const junk = Array.from({ length: 200 }, (_, i) => `made-up-${i}`);
  const answer = await shelves(`?moods=${[...junk, ...everything, ...junk].join(',')}`);
  assert.equal(answer.status, 200);
  assert.ok(answer.ids.length <= MOODS.length, `${answer.ids.length} shelves`);
  assert.equal(new Set(answer.ids).size, answer.ids.length, 'no shelf twice');
});

test('the list written twice in the address is read as one list', async () => {
  assert.deepEqual(await shelves('?moods=funny&moods=funny,short'), { status: 200, ids: ['funny', 'short'] });
});
