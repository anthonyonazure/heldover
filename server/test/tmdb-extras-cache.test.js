// Cast lists and trailers are looked up at TMDB by a title's id and the
// answers are stored for a week, so TMDB is asked once per title and not once
// per look. The id comes from the address of the request. Every different
// number anyone asked about left a row behind, including numbers TMDB had
// never heard of, and nothing ever removed a row: a device that may only look
// could grow the shared database for as long as it kept asking.
//
// TMDB is a stand-in inside this process and the routes are asked over this
// computer's loopback, as a device on the Wi-Fi that may only look. Dummy key,
// dummy titles, throwaway data folder, no network.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_MDNS = '1';
process.env.TMDB_API_KEY = 'dummy-tmdb-key';
delete process.env.PLEX_TOKEN;
delete process.env.TRUST_PROXY;

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

// A database left by an earlier version: three answers past their week and
// one from yesterday. Made before the app is imported, so the app finds it
// the way it would at a real start.
const peek = new Database(path.join(dataDir, 'ratings.db'));
peek.exec('CREATE TABLE tmdb_extras_cache (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at TEXT NOT NULL)');
const store = peek.prepare('INSERT OR REPLACE INTO tmdb_extras_cache (cache_key, data, fetched_at) VALUES (?, ?, ?)');
store.run('trailer:movie:101', '{"key":null}', daysAgo(8));
store.run('trailer:movie:102', '{"key":"old-key"}', daysAgo(30));
store.run('cast:tv:103', '[]', daysAgo(400));
store.run('trailer:movie:104', '{"key":"kept-key"}', daysAgo(1));
const rows = () => peek.prepare('SELECT COUNT(*) AS n FROM tmdb_extras_cache').get().n;
const stored = (key) => peek.prepare('SELECT data FROM tmdb_extras_cache WHERE cache_key = ?').get(key)?.data ?? null;

// TMDB, played by a stand-in for fetch. It knows the ids below 1,000,000 and
// answers 404 for the rest, unless a test says it is having a bad moment.
const tmdb = { calls: 0, trouble: null };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname !== 'api.themoviedb.org') throw new Error('fetch failed (the tests use no network)');
  tmdb.calls += 1;
  const [, , kind, id, what] = url.pathname.split('/');
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (tmdb.trouble) return answer(tmdb.trouble, { status_message: 'dummy trouble' });
  if (Number(id) >= 1_000_000) return answer(404, { status_message: 'The resource you requested could not be found.' });
  if (what === 'videos') {
    // Every tenth title has no trailer at all.
    const results = Number(id) % 10 === 0 ? [] : [{ site: 'YouTube', key: `yt-${kind}-${id}`, type: 'Trailer', official: true, size: 1080 }];
    return answer(200, { results });
  }
  return answer(200, { cast: [{ name: `Dummy Actor ${id}`, character: 'Dummy Role', profile_path: null }] });
};

const logged = [];
const realLog = console.log;
console.log = (...args) => {
  logged.push(args.join(' '));
};

// Imported only after DATA_DIR is set and the old rows are in place.
const extras = await import('../src/tmdb-extras.js');
const { app } = await import('../src/app.js');
await import('../src/routes/search.js');

const listener = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
after(() => {
  listener.close();
  peek.close();
  globalThis.fetch = realFetch;
  console.log = realLog;
});
const base = `http://127.0.0.1:${listener.address().port}`;

// A request that says it was forwarded is never "this computer" to auth.js,
// so this is a device on the Wi-Fi. With no PIN set it may look and no more.
async function guest(route) {
  const res = await realFetch(`${base}${route}`, { headers: { 'X-Forwarded-For': '192.168.1.50' } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Runs `ask` and says how many times TMDB was asked and how many rows were added. */
async function counting(ask) {
  const before = { calls: tmdb.calls, rows: rows() };
  const answer = await ask();
  return { answer, calls: tmdb.calls - before.calls, rows: rows() - before.rows };
}

test('at startup, answers left from more than seven days ago are removed and newer ones are kept', async () => {
  assert.equal(rows(), 1);
  assert.equal(stored('trailer:movie:104'), '{"key":"kept-key"}');
  assert.ok(logged.some((line) => /removed 3 stored cast and trailer answers older than 7 days/.test(line)), logged.join('\n'));
  // The one that was kept is still used: TMDB is not asked.
  const kept = await counting(() => guest('/api/trailer/movie/104'));
  assert.deepEqual(kept, { answer: { status: 200, body: { key: 'kept-key' } }, calls: 0, rows: 0 });
});

test('an answer for a real title is stored and TMDB is not asked again', async () => {
  const first = await counting(() => guest('/api/trailer/movie/603'));
  assert.deepEqual(first, { answer: { status: 200, body: { key: 'yt-movie-603' } }, calls: 1, rows: 1 });
  const again = await counting(() => guest('/api/trailer/movie/603'));
  assert.deepEqual(again, { answer: { status: 200, body: { key: 'yt-movie-603' } }, calls: 0, rows: 0 });

  // A series has its own numbering, so its own answer.
  const series = await counting(() => guest('/api/trailer/show/603'));
  assert.deepEqual(series, { answer: { status: 200, body: { key: 'yt-tv-603' } }, calls: 1, rows: 1 });

  const cast = await counting(() => guest('/api/cast/movie/603'));
  assert.equal(cast.answer.body.cast[0].name, 'Dummy Actor 603');
  assert.deepEqual({ calls: cast.calls, rows: cast.rows }, { calls: 1, rows: 1 });
  const castAgain = await counting(() => guest('/api/cast/movie/603'));
  assert.deepEqual({ name: castAgain.answer.body.cast[0].name, calls: castAgain.calls, rows: castAgain.rows }, { name: 'Dummy Actor 603', calls: 0, rows: 0 });
});

test('a real title that has no trailer is remembered too, so it is asked about once', async () => {
  const first = await counting(() => guest('/api/trailer/movie/610'));
  assert.deepEqual(first, { answer: { status: 200, body: { key: null } }, calls: 1, rows: 1 });
  const again = await counting(() => guest('/api/trailer/movie/610'));
  assert.deepEqual(again, { answer: { status: 200, body: { key: null } }, calls: 0, rows: 0 });
});

test('an id TMDB does not know leaves no row, however many different ones are asked about', async () => {
  const trailers = await counting(async () => {
    const statuses = new Set();
    for (let i = 1; i <= 12; i++) statuses.add((await guest(`/api/trailer/movie/${900000000 + i}`)).status);
    return [...statuses];
  });
  assert.deepEqual(trailers, { answer: [200], calls: 12, rows: 0 });
  const cast = await counting(() => guest('/api/cast/movie/900000001'));
  assert.deepEqual(cast, { answer: { status: 200, body: { cast: [] } }, calls: 1, rows: 0 });
});

test('a "slow down" or an error from TMDB is not remembered as "no trailer"', async () => {
  for (const trouble of [429, 500, 503]) {
    tmdb.trouble = trouble;
    const during = await counting(() => guest('/api/trailer/movie/777'));
    assert.deepEqual(during, { answer: { status: 200, body: { key: null } }, calls: 1, rows: 0 }, `TMDB answering ${trouble}`);
  }
  tmdb.trouble = null;
  // Once TMDB answers again the real trailer is found.
  const after = await counting(() => guest('/api/trailer/movie/777'));
  assert.deepEqual(after, { answer: { status: 200, body: { key: 'yt-movie-777' } }, calls: 1, rows: 1 });
});

test('only a plain whole number is taken as an id: anything else is refused before TMDB is asked', async () => {
  for (const raw of ['-5', '7junk', '99999999999999999999999', '12345678901', '0', '007', 'abc', '1e3', '7.5', '%207', 'undefined']) {
    for (const route of ['trailer', 'cast']) {
      const asked = await counting(() => guest(`/api/${route}/movie/${raw}`));
      assert.deepEqual({ status: asked.answer.status, calls: asked.calls, rows: asked.rows }, { status: 400, calls: 0, rows: 0 }, `${route} ${raw}`);
    }
  }
  // The largest id that is taken: ten digits.
  const ten = await counting(() => guest('/api/trailer/movie/1234567890'));
  assert.deepEqual({ status: ten.answer.status, calls: ten.calls }, { status: 200, calls: 1 });
});

test('the cleanup removes only answers past their week, says so in the log, and removes nothing when run again', async () => {
  const before = rows();
  store.run('trailer:movie:201', '{"key":"stale-1"}', daysAgo(7.5));
  store.run('cast:movie:202', '[]', daysAgo(9));
  store.run('trailer:movie:203', '{"key":"fresh"}', daysAgo(6.5));
  logged.length = 0;

  assert.deepEqual(extras.sweepExtrasCache(), { expired: 2, overLimit: 0 });
  assert.equal(rows(), before + 1);
  assert.equal(stored('trailer:movie:203'), '{"key":"fresh"}');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /removed 2 stored cast and trailer answers older than 7 days/);

  assert.deepEqual(extras.sweepExtrasCache(), { expired: 0, overLimit: 0 });
  assert.equal(rows(), before + 1);
  assert.equal(logged.length, 1, 'nothing removed, nothing said');
});

test('the table is held to its limit: when it is full the oldest answers go, the newest stay', async () => {
  // A limit small enough to reach: 10 rows, checked every 5 stored answers.
  extras.setLimitsForTests(10, 5);
  logged.length = 0;
  let most = 0;
  for (let id = 2001; id <= 2040; id++) {
    await extras.getTrailerKey('movie', id);
    most = Math.max(most, rows());
  }
  assert.ok(most <= 10 + 5, `the table reached ${most} rows`);
  assert.equal(rows(), 10, 'forty answers stored, ten kept');
  assert.ok(logged.some((line) => /and the \d+ oldest to stay within 10/.test(line)), logged.join('\n'));

  // The ten newest are the ones kept, and they are still answers: no call.
  for (let id = 2031; id <= 2040; id++) assert.ok(stored(`trailer:movie:${id}`), `answer for ${id} kept`);
  const newest = await counting(() => extras.getTrailerKey('movie', 2039));
  assert.deepEqual(newest, { answer: 'yt-movie-2039', calls: 0, rows: 0 });
  // An old one was dropped. Asking again simply looks it up again.
  assert.equal(stored('trailer:movie:2001'), null);
  const dropped = await counting(() => extras.getTrailerKey('movie', 2001));
  assert.deepEqual({ answer: dropped.answer, calls: dropped.calls }, { answer: 'yt-movie-2001', calls: 1 });

  // Run by hand, twice: the first brings the table to its limit, the second
  // finds nothing to do.
  const first = extras.sweepExtrasCache();
  assert.equal(rows(), 10);
  assert.equal(first.expired, 0);
  assert.deepEqual(extras.sweepExtrasCache(), { expired: 0, overLimit: 0 });
  assert.equal(rows(), 10);
});
