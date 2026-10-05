// The new-additions table (library_snapshots) is filled by a background scan
// from what each Plex server lists, and a server may be someone else's. It
// used to keep a row for every item number a server had ever listed: nothing
// took a row away, a library rebuilt under new numbers was listed twice, and
// every request for the front page's "new" row read the whole table.
//
// These checks pin the rules that replaced that: the table is brought in line
// with what a complete read of a library holds, rows too old for any screen
// are dropped, nothing is removed on the strength of a read that failed, and
// a request reads through an index.
// Runs against a throwaway data folder and stand-in Plex servers.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DUMMY_TOKEN, listenForTest, startStandInPlex, stubPlexTv } from './helpers/stand-in-plex.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = DUMMY_TOKEN;
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY']) delete process.env[key];

const SERVER = 'stand-in-new-additions';
const OTHER = 'stand-in-switched-off';
const GONE = 'stand-in-no-longer-shared';
const N = 20;
const DAY = 24 * 60 * 60;
const nowSeconds = Math.floor(Date.now() / 1000);

/** The same 20 dummy films, numbered from `base` + 1, each added a few minutes after the one before. */
const films = (base, count = N) =>
  Array.from({ length: count }, (_, i) => ({
    ratingKey: String(base + i + 1),
    type: 'movie',
    title: `Dummy Film ${i + 1}`,
    year: 1990 + i,
    addedAt: nowSeconds - 3600 + i * 60,
  }));

// Both are handed to the stand-in by reference and changed between scans, the
// way a server's answers change.
const sections = [{ key: '1', type: 'movie', title: 'Films' }];
const items = { 1: films(1000) };
const plex = await startStandInPlex({ serverKey: SERVER, sections, items });
const other = await startStandInPlex({
  serverKey: OTHER,
  sections: [{ key: '3', type: 'movie', title: 'Other films' }],
  items: { 3: films(7000, 4) },
});
const refused = stubPlexTv([plex, other]);

const { app, ensureServers } = await import('../src/app.js');
await import('../src/routes/monitoring.js');
const monitor = await import('../src/monitor.js');
const backoff = await import('../src/server-backoff.js');
const { openRatingsDb } = await import('../src/db.js');
const { call, close } = await listenForTest(app);
const db = openRatingsDb();

after(async () => {
  await close();
  await plex.stop();
  db.close();
});

const servers = await ensureServers();
/** The scan the six-hour timer runs. */
const scan = (list = servers) => monitor.scanForNewAdditions(list, DUMMY_TOKEN);
/** A failed read puts a server on hold for a while; a test that causes one lifts the hold again. */
const liftHold = () => {
  backoff.recordSuccess(SERVER);
  backoff.recordSuccess(OTHER);
};

const rowsOf = (serverKey) =>
  db.prepare('SELECT * FROM library_snapshots WHERE server_key = ? ORDER BY CAST(item_key AS INTEGER)').all(serverKey);
const keysOf = (serverKey) => rowsOf(serverKey).map((row) => `${row.library_key}/${row.item_key}`);
const insertRow = db.prepare(`
  INSERT INTO library_snapshots (server_key, library_key, library_title, item_key, title, year, type, added_at, first_seen_at)
  VALUES (?, ?, 'Films', ?, ?, 2000, 'movie', ?, ?)
`);
const iso = (secondsAgo) => new Date((nowSeconds - secondsAgo) * 1000).toISOString();
const sqlTime = (secondsAgo) => iso(secondsAgo).slice(0, 19).replace('T', ' ');
/** What a device that may only look is given for the "new" row. */
const newAdditions = async (query = '') => (await call('GET', `/api/new-additions${query}`, { lookOnly: true })).body.additions;

test('a library that is rebuilt under new item numbers is listed once, not once for every rebuild', async () => {
  await scan();
  assert.equal(rowsOf(SERVER).length, N);

  items[1] = films(2000);
  await scan();
  items[1] = films(3000);
  await scan();

  assert.equal(rowsOf(SERVER).length, N, 'the rows of the old item numbers are gone');
  assert.deepEqual(keysOf(SERVER), films(3000).map((f) => `1/${f.ratingKey}`));
  const shown = (await newAdditions('?limit=500')).filter((row) => row.server_key === SERVER);
  assert.equal(shown.length, N, 'each film is shown once');
  assert.equal(new Set(shown.map((row) => row.title)).size, N);
});

test('a title that is removed from its library leaves the list', async () => {
  items[1] = films(3000, 5);
  await scan();
  assert.deepEqual(keysOf(SERVER), films(3000, 5).map((f) => `1/${f.ratingKey}`));
  items[1] = films(3000);
  await scan();
  assert.equal(rowsOf(SERVER).length, N, 'and is back when the server lists it again');
});

test('a library the server no longer lists takes its rows with it', async () => {
  sections.splice(0, sections.length, { key: '7', type: 'movie', title: 'Films' });
  items[7] = films(3000);
  await scan();
  assert.deepEqual(keysOf(SERVER), films(3000).map((f) => `7/${f.ratingKey}`));
});

test('an answer that comes back empty removes nothing', async () => {
  const before = keysOf(SERVER);
  const listed = items[7];
  items[7] = [];
  try {
    await scan();
  } finally {
    items[7] = listed;
  }
  assert.deepEqual(keysOf(SERVER), before);
});

test('a server that cannot list its libraries loses nothing', async () => {
  const before = keysOf(SERVER);
  plex.sectionListDown = true;
  try {
    await scan();
  } finally {
    plex.sectionListDown = false;
    liftHold();
  }
  assert.deepEqual(keysOf(SERVER), before);
});

test('a server that lists no libraries for a moment loses nothing', async () => {
  const before = keysOf(SERVER);
  const listed = sections.splice(0, sections.length);
  try {
    await scan();
  } finally {
    sections.push(...listed);
  }
  assert.deepEqual(keysOf(SERVER), before);
});

test('a library that cannot be read loses nothing, while the one beside it is still brought up to date', async () => {
  // Handed to the scan with no list of connections, so a page that fails is
  // not tried again for a quarter of a minute.
  const direct = servers.filter((s) => s.clientIdentifier === SERVER).map((s) => ({ ...s, connections: undefined }));
  sections.push({ key: '8', type: 'movie', title: 'More films' });
  items[8] = films(8000, 3);
  await scan(direct);
  assert.equal(rowsOf(SERVER).length, N + 3);

  // Section 7 stops answering; section 8 loses one film.
  const listed = items[7];
  delete items[7];
  items[8] = films(8000, 2);
  try {
    await scan(direct);
  } finally {
    items[7] = listed;
    liftHold();
  }
  const keys = keysOf(SERVER);
  assert.equal(keys.filter((key) => key.startsWith('7/')).length, N, 'the library that failed keeps every row');
  assert.deepEqual(keys.filter((key) => key.startsWith('8/')), ['8/8001', '8/8002'], 'the library that was read is reconciled');

  sections.pop();
  delete items[8];
  await scan();
  assert.equal(rowsOf(SERVER).length, N);
});

test('a server that is switched off, or missing from the server list, loses nothing', async () => {
  assert.equal(rowsOf(OTHER).length, 4, 'the earlier scans stored its four films');

  // Missing from the list handed to the scan: a server that is switched off
  // can drop off the list and come back.
  await scan(servers.filter((s) => s.clientIdentifier !== OTHER));
  assert.equal(rowsOf(OTHER).length, 4);

  await other.stop();
  try {
    await scan();
  } finally {
    liftHold();
  }
  assert.equal(rowsOf(OTHER).length, 4);
  assert.equal(rowsOf(SERVER).length, N);
});

test('a title the server gives no date for keeps the day it was first seen, so it is not shown as new again', async () => {
  items[7] = [...films(3000), { ratingKey: '3500', type: 'movie', title: 'Dummy Film With No Date', year: 1980 }];
  insertRow.run(SERVER, '7', '3500', 'Dummy Film With No Date', null, '2020-01-01 00:00:00');
  const before = rowsOf(SERVER).find((row) => row.item_key === '3500');

  await scan();
  await scan();

  const kept = rowsOf(SERVER).find((row) => row.item_key === '3500');
  assert.equal(kept.id, before.id, 'the same row, not a new one');
  assert.equal(kept.first_seen_at, '2020-01-01 00:00:00');
  assert.equal((await newAdditions('?limit=500')).some((row) => row.item_key === '3500'), false);

  // And it goes when its library no longer lists it.
  items[7] = films(3000);
  await scan();
  assert.equal(rowsOf(SERVER).some((row) => row.item_key === '3500'), false);
});

test('a title added long ago is not kept, and the next scan does not store it again', async () => {
  // One the server lists with an old date, and one already on file from before this rule.
  items[7] = [...films(3000), { ratingKey: '3600', type: 'movie', title: 'Dummy Old Film', year: 1970, addedAt: nowSeconds - 400 * DAY }];
  insertRow.run(SERVER, '7', '3601', 'Dummy Older Film', iso(500 * DAY), sqlTime(500 * DAY));
  items[7].push({ ratingKey: '3601', type: 'movie', title: 'Dummy Older Film', year: 1960, addedAt: nowSeconds - 500 * DAY });
  // And one on file with an old date that the server now says it added an
  // hour ago: the date the server states now is the one that counts.
  db.prepare("UPDATE library_snapshots SET added_at = ? WHERE server_key = ? AND item_key = '3001'").run(iso(400 * DAY), SERVER);
  try {
    await scan();
    assert.equal(rowsOf(SERVER).some((row) => row.item_key === '3600'), false, 'not stored');
    assert.equal(rowsOf(SERVER).some((row) => row.item_key === '3601'), false, 'the row on file is removed');
    assert.equal(rowsOf(SERVER).find((row) => row.item_key === '3001').added_at >= iso(DAY), true);
    await scan();
    assert.equal(rowsOf(SERVER).length, N, 'and neither is stored again');
  } finally {
    items[7] = films(3000);
  }
});

test('an item with no item number is not stored, and one stored earlier is removed', async () => {
  items[7] = [...films(3000), { ratingKey: null, type: 'movie', title: 'Dummy Film With No Number', year: 1999, addedAt: nowSeconds - 60 }];
  insertRow.run(SERVER, '7', null, 'Dummy Film With No Number', iso(60), sqlTime(60));
  try {
    await scan();
    await scan();
    assert.equal(rowsOf(SERVER).length, N);
    assert.equal(rowsOf(SERVER).some((row) => row.item_key === null), false);
  } finally {
    items[7] = films(3000);
  }
});

test('only the newest titles of one library are kept', async () => {
  monitor.setSnapshotLimitsForTests({ perLibrary: 5 });
  try {
    await scan();
    // films() dates each one a minute after the one before, so the last five are the newest.
    assert.deepEqual(keysOf(SERVER), films(3000).slice(-5).map((f) => `7/${f.ratingKey}`));
  } finally {
    monitor.setSnapshotLimitsForTests({ perLibrary: 2000 });
  }
  await scan();
  assert.equal(rowsOf(SERVER).length, N, 'and the rest are stored again when there is room');
});

test('rows too old for any screen are removed a few at a time, whatever server they came from, and a second run removes nothing', async () => {
  // A server that is no longer shared: no scan will ever read it again.
  for (let i = 0; i < 25; i++) insertRow.run(GONE, '1', String(100 + i), `Dummy Gone Film ${i}`, iso((40 + i) * DAY), sqlTime((40 + i) * DAY));
  insertRow.run(GONE, '1', '200', 'Dummy Gone Film Recent', iso(2 * DAY), sqlTime(2 * DAY));
  insertRow.run(GONE, '1', '201', 'Dummy Gone Film No Date', null, sqlTime(90 * DAY));

  monitor.setSnapshotLimitsForTests({ chunkRows: 10 });
  try {
    assert.equal(await monitor.removeOldSnapshots(), 25);
    assert.deepEqual(keysOf(GONE), ['1/200', '1/201'], 'a recent row and a row with no date stay');
    assert.equal(await monitor.removeOldSnapshots(), 0);
  } finally {
    monitor.setSnapshotLimitsForTests({ chunkRows: 1000 });
  }
  assert.equal(rowsOf(SERVER).length, N, 'nothing recent was touched');
});

test('a request may look back 30 days at most, which is as far as rows are kept', async () => {
  insertRow.run(GONE, '1', '300', 'Dummy Gone Film 20 Days', iso(20 * DAY), sqlTime(20 * DAY));
  insertRow.run(GONE, '1', '301', 'Dummy Gone Film 45 Days', iso(45 * DAY), sqlTime(45 * DAY));
  const titles = (await newAdditions('?days=3650&limit=500')).map((row) => row.title);
  assert.equal(titles.includes('Dummy Gone Film 20 Days'), true);
  assert.equal(titles.includes('Dummy Gone Film 45 Days'), false);
  assert.equal((await newAdditions()).some((row) => row.title === 'Dummy Gone Film 20 Days'), false, 'the default is still 7 days');
});

test('a request for new additions reads through an index instead of reading and sorting the whole table', () => {
  // The statement getNewAdditions runs (monitor.js).
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM library_snapshots
       WHERE COALESCE(added_at, first_seen_at) >= datetime('now', '-' || ? || ' days')
       ORDER BY COALESCE(added_at, first_seen_at) DESC
       LIMIT ?`
    )
    .all(7, 100)
    .map((row) => row.detail);
  assert.equal(plan.some((line) => line.startsWith('SCAN')), false, plan.join(' | '));
  assert.equal(plan.some((line) => line.includes('TEMP B-TREE')), false, plan.join(' | '));
  assert.equal(plan.some((line) => line.includes('USING INDEX')), true, plan.join(' | '));
});

test('the log says how many rows a scan removed, and never a title', async () => {
  items[7] = films(3000, 15);
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await scan();
  } finally {
    console.log = realLog;
    items[7] = films(3000);
  }
  const said = lines.filter((line) => line.startsWith('[new additions]'));
  assert.equal(said.length, 1, 'one line');
  assert.match(said[0], /removed \d+: 5 for titles no longer in their library/);
  assert.equal(lines.some((line) => line.includes('Dummy Film')), false);
});

test('nothing in these checks left this computer', () => {
  assert.deepEqual(refused, []);
});
