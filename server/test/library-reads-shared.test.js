// Reading a whole library from a Plex server is the heaviest thing this app
// does: every title of it is held in memory at once. Requests arriving
// together used to start one full read each, on any route but one, and nothing
// limited how many ran. These checks pin the rule that replaced that: one read
// per library at a time, shared by everyone who asks; a small ceiling on reads
// overall; and a read nobody is waiting for any more is stopped.
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

const SERVER = 'stand-in-reads';
const PAGE_SIZE = 500; // as in plex-library.js
const film = (key, n) => ({
  ratingKey: String(key * 10000 + n), type: 'movie', title: `Dummy Film ${key}-${n}`, year: 2000,
  Role: [{ tag: `Dummy Actor ${key}` }], Director: [{ tag: `Dummy Director ${key}` }],
});
const small = (key) => [film(key, 1)];
// Five pages, so there is time to hang up in the middle of a read.
const big = (key) => Array.from({ length: 2100 }, (_, n) => film(key, n));
const BIG_PAGES = Math.ceil(2100 / PAGE_SIZE);

const smallKeys = ['1', '2', '3', '4', '5', '6', '7'];
const bigKeys = ['9', '10', '11'];
const plex = await startStandInPlex({
  serverKey: SERVER,
  sections: [...smallKeys, ...bigKeys].map((key) => ({ key, type: 'movie', title: `Films ${key}` })),
  items: Object.fromEntries([...smallKeys.map((key) => [key, small(Number(key))]), ...bigKeys.map((key) => [key, big(Number(key))])]),
  // Slow enough that requests sent together really do overlap.
  pageDelayMs: 60,
});
const refused = stubPlexTv([plex]);

const { app } = await import('../src/app.js');
await import('../src/routes/library.js');
await import('../src/routes/search.js');
await import('../src/routes/streaming-stats.js');
await import('../src/routes/discovery.js');
const cache = await import('../src/library-cache.js');
const plexLibrary = await import('../src/plex-library.js');
const { call, close } = await listenForTest(app);
const connections = [{ uri: plex.uri, local: true, protocol: 'http' }];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => {
  await close();
  await plex.stop();
});

test('the app knows which libraries it lists', async () => {
  const res = await call('GET', '/api/libraries');
  assert.equal(res.body.libraries.length, smallKeys.length + bigKeys.length);
});

test('six requests for the same library at the same moment are one read of it', async () => {
  const answers = await Promise.all(
    Array.from({ length: 6 }, () => call('GET', `/api/library/${SERVER}/1`, { lookOnly: true }))
  );
  for (const res of answers) {
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((item) => item.title), ['Dummy Film 1-1']);
  }
  assert.equal(plex.readsOf(1), 1, 'the stand-in server was read once, not six times');
});

test('one library asked for through six different parts of the app is still one read', async () => {
  const answers = await Promise.all(
    [
      `/api/library/${SERVER}/2`,
      `/api/stats/${SERVER}/2`,
      `/api/random/${SERVER}/2`,
      `/api/actors?serverKey=${SERVER}&libraryKey=2`,
      `/api/directors?serverKey=${SERVER}&libraryKey=2`,
      `/api/discovery/recently-added?serverKey=${SERVER}&libraryKey=2`,
    ].map((route) => call('GET', route, { lookOnly: true }))
  );
  assert.deepEqual(answers.map((res) => res.status), [200, 200, 200, 200, 200, 200]);
  assert.equal(plex.readsOf(2), 1);
});

test('actors and directors come from the stored library, not from a new read each time', async () => {
  await until(() => cache.getCachedItems(SERVER, '1'), 'library 1 to be stored');
  const before = plex.readsOf(1);
  for (let i = 0; i < 3; i += 1) {
    const actors = await call('GET', `/api/actors?serverKey=${SERVER}&libraryKey=1`, { lookOnly: true });
    assert.deepEqual(actors.body, { actors: ['Dummy Actor 1'], count: 1 });
    const directors = await call('GET', `/api/directors?serverKey=${SERVER}&libraryKey=1`, { lookOnly: true });
    assert.deepEqual(directors.body, { directors: ['Dummy Director 1'], count: 1 });
  }
  assert.equal(plex.readsOf(1), before, 'the stand-in server was not read again');
});

test('refresh=true still reads the library again, and two at once share that read', async () => {
  const before = plex.readsOf(1);
  const one = await call('GET', `/api/library/${SERVER}/1?refresh=true`);
  assert.equal(one.body.fromCache, false);
  assert.equal(plex.readsOf(1), before + 1, 'a forced re-read asks Plex although a copy is stored');

  const both = await Promise.all([
    call('GET', `/api/library/${SERVER}/1?refresh=true`),
    call('GET', `/api/library/${SERVER}/1?refresh=true`),
  ]);
  assert.deepEqual(both.map((res) => res.body.fromCache), [false, false]);
  assert.equal(plex.readsOf(1), before + 2);
});

test('five requests that find the same out-of-date copy start one refresh of it', async () => {
  // Age the stored copy past six hours, the way time would.
  const db = new Database(path.join(process.env.DATA_DIR, 'ratings.db'));
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE library_items_cache SET fetched_at = ? WHERE cache_key = ?').run(old, `${SERVER}:1`);
  db.close();
  const before = plex.readsOf(1);

  const answers = await Promise.all(
    Array.from({ length: 5 }, () => call('GET', `/api/library/${SERVER}/1`, { lookOnly: true }))
  );
  assert.deepEqual(answers.map((res) => res.body.stale), [true, true, true, true, true], 'each is served the old copy at once');
  await until(() => cache.getCachedItems(SERVER, '1').stale === false, 'the background refresh to store a new copy');
  await pause(150);
  assert.equal(plex.readsOf(1), before + 1, 'one read in the background, not five');
});

test('requests for more libraries than the ceiling wait their turn; none fails', async () => {
  const { MAX_LIBRARY_READS } = plexLibrary;
  const wanted = ['3', '4', '5', '6', '7'];
  assert.ok(wanted.length > MAX_LIBRARY_READS);
  plex.mostSectionsBusy = 0;
  const answers = await Promise.all(wanted.map((key) => call('GET', `/api/library/${SERVER}/${key}`, { lookOnly: true })));
  assert.deepEqual(answers.map((res) => res.status), [200, 200, 200, 200, 200]);
  for (const key of wanted) assert.equal(plex.readsOf(key), 1);
  assert.ok(
    plex.mostSectionsBusy <= MAX_LIBRARY_READS,
    `never more than ${MAX_LIBRARY_READS} libraries are read at once (saw ${plex.mostSectionsBusy})`
  );
  assert.ok(plex.mostSectionsBusy >= 2, 'and they are not read one by one either');
});

test('a read goes on while anyone still waits for it, and stops once the last one has gone', async () => {
  const { getLibraryItems } = plexLibrary;
  const read = (signal) => getLibraryItems(plex.uri, '9', DUMMY_TOKEN, connections, signal ? { signal } : undefined);

  // Two people waiting; one leaves. The other still gets the library.
  const first = new AbortController();
  const second = new AbortController();
  const left = read(first.signal);
  const stayed = read(second.signal);
  setTimeout(() => first.abort(), 20);
  await assert.rejects(left);
  assert.equal((await stayed).length, 2100);
  assert.equal(plex.pagesOf(9), BIG_PAGES, 'one full read');

  // A person and background work waiting; the person leaves. Background work never does.
  const person = new AbortController();
  const gone = read(person.signal);
  const background = read();
  setTimeout(() => person.abort(), 20);
  await assert.rejects(gone);
  assert.equal((await background).length, 2100);
  assert.equal(plex.pagesOf(9), BIG_PAGES * 2);

  // One person waiting, and they leave: the read stops before its next page.
  const alone = new AbortController();
  const abandoned = read(alone.signal);
  setTimeout(() => alone.abort(), 20);
  await assert.rejects(abandoned);
  await pause(400);
  assert.equal(plex.pagesOf(9), BIG_PAGES * 2 + 1, 'only the page already asked for; the rest of the library was not read');

  // And an abandoned read leaves nothing behind: the next one starts afresh.
  assert.equal((await read()).length, 2100);
});

test('a device that hangs up before its answer stops the read it was the only one waiting for', async () => {
  const hangUp = new AbortController();
  const request = call('GET', `/api/library/${SERVER}/10`, { lookOnly: true, signal: hangUp.signal });
  setTimeout(() => hangUp.abort(), 30);
  await assert.rejects(request);
  await pause(400);
  assert.equal(plex.pagesOf(10), 1, 'the read stopped after the page already asked for');
  assert.equal(cache.getCachedItems(SERVER, '10'), null);
});

test('four reads of one library at once, straight at the function every caller uses, are one read', async () => {
  // The address form, with no list of connections: the path whose requests
  // this file sends itself.
  const { getLibraryItems } = plexLibrary;
  const results = await Promise.all(Array.from({ length: 4 }, () => getLibraryItems(plex.uri, '11', DUMMY_TOKEN, null)));
  assert.deepEqual(results.map((items) => items.length), [2100, 2100, 2100, 2100]);
  assert.equal(plex.pagesOf(11), BIG_PAGES, 'one set of pages, not four');
  assert.equal(results.every((items) => items === results[0]), true, 'and one copy in memory, not four');
});

test("the server's token travels in a header, never in the address", async () => {
  const { getLibraries, getItemDetails } = plexLibrary;
  const from = plex.seen.length;
  await getLibraries(plex.uri, DUMMY_TOKEN, null);
  await assert.rejects(getItemDetails(plex.uri, '999999', DUMMY_TOKEN), (err) => {
    assert.equal(err.message.includes(DUMMY_TOKEN), false, 'and it is not in the error text');
    return true;
  });
  const asked = [...plex.seen.slice(from), ...plex.seen.filter((r) => r.section === '11')];
  assert.ok(asked.length >= 2 + BIG_PAGES);
  assert.deepEqual([...new Set(asked.map((r) => r.tokenIn))], ['header']);
});

test('nothing in these checks left this computer', () => {
  assert.deepEqual(refused, []);
});
