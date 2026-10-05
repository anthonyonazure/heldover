// Thumbs and "not interested" are kept per Plex server. A rating key is only
// unique inside one server, so two films that share a number on two servers
// must never share a thumb or a hidden state. Rows saved before servers were
// stored have to survive the table rebuild and keep working for the film they
// were given to. Runs against a throwaway data folder, never the real one.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.DATA_DIR = dataDir;
delete process.env.PLEX_TOKEN;

// The two tables as they were before this change (the shape the live database
// had), with rows in them, so that importing the modules below has something
// to rebuild.
const OLD_NOT_INTERESTED = `
  CREATE TABLE not_interested (
    plex_key TEXT,
    title TEXT,
    year INTEGER,
    type TEXT,
    marked_at TEXT DEFAULT (datetime('now')),
    profile_id INTEGER NOT NULL DEFAULT 1,
    UNIQUE(profile_id, plex_key)
  )`;
const OLD_PERSONAL_RATINGS = `
  CREATE TABLE personal_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    year INTEGER,
    type TEXT,
    plex_key TEXT,
    guid TEXT,
    genres TEXT,
    rating TEXT NOT NULL,
    rated_at TEXT DEFAULT (datetime('now')),
    profile_id INTEGER NOT NULL DEFAULT 1,
    UNIQUE(profile_id, plex_key)
  )`;

function fillOldTables(db) {
  db.exec(OLD_NOT_INTERESTED);
  db.exec('CREATE INDEX idx_not_interested_profile ON not_interested(profile_id)');
  db.exec(OLD_PERSONAL_RATINGS);
  db.exec('CREATE INDEX idx_personal_ratings_profile ON personal_ratings(profile_id)');
  const hide = db.prepare('INSERT INTO not_interested (plex_key, title, year, type, marked_at, profile_id) VALUES (?, ?, ?, ?, ?, ?)');
  hide.run('5', 'Alpha', 2001, 'movie', '2026-01-02 03:04:05', 1);
  hide.run('6', 'No Year', null, 'movie', '2026-01-03 03:04:05', 1);
  hide.run('9', null, null, null, '2026-01-04 03:04:05', 1);
  hide.run('5', 'Alpha', 2001, 'movie', '2026-01-05 03:04:05', 2);
  const rate = db.prepare(
    'INSERT INTO personal_ratings (id, title, year, type, plex_key, guid, genres, rating, rated_at, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  rate.run(3, 'Alpha', 2001, 'movie', '5', 'plex://movie/a', 'Drama, Crime', 'up', '2026-02-02 03:04:05', 1);
  rate.run(7, 'Gamma', 1999, 'movie', '8', null, 'Horror', 'down', '2026-02-03 03:04:05', 1);
  rate.run(8, 'Alpha', 2001, 'movie', '5', null, 'Drama', 'down', '2026-02-04 03:04:05', 2);
}

const seed = new Database(path.join(dataDir, 'ratings.db'));
fillOldTables(seed);
seed.close();

// Imported only after the old tables exist: the rebuild runs on import.
const feedback = await import('../src/feedback.js');
const ratings = await import('../src/personal-ratings.js');
const { addServerKey } = await import('../src/server-keyed.js');
const recommendations = await import('../src/recommendations.js');
const { pickTonight } = await import('../src/tonight.js');
const { app } = await import('../src/app.js');
// The browser's half of the same rule: plain JavaScript, so it loads here too.
const clientRatings = await import('../../client/src/lib/personal-ratings.js');
await import('../src/routes/lists.js');
await import('../src/routes/moods-curated.js');

const peek = new Database(path.join(dataDir, 'ratings.db'));
after(() => peek.close());
const columnsOf = (table) => peek.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const countOf = (table) => peek.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const tableSql = (table) => peek.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;

const SERVER_A = 'server-a-identifier';
const SERVER_B = 'server-b-identifier';

test('tables saved before servers were stored are rebuilt without losing a row', () => {
  assert.ok(columnsOf('not_interested').includes('server_key'));
  assert.ok(columnsOf('personal_ratings').includes('server_key'));
  assert.match(tableSql('not_interested'), /UNIQUE\(profile_id, server_key, plex_key\)/);
  assert.match(tableSql('personal_ratings'), /UNIQUE\(profile_id, server_key, plex_key\)/);

  assert.deepEqual(
    peek.prepare('SELECT plex_key, title, year, type, marked_at, profile_id, server_key FROM not_interested ORDER BY marked_at').all(),
    [
      { plex_key: '5', title: 'Alpha', year: 2001, type: 'movie', marked_at: '2026-01-02 03:04:05', profile_id: 1, server_key: null },
      { plex_key: '6', title: 'No Year', year: null, type: 'movie', marked_at: '2026-01-03 03:04:05', profile_id: 1, server_key: null },
      { plex_key: '9', title: null, year: null, type: null, marked_at: '2026-01-04 03:04:05', profile_id: 1, server_key: null },
      { plex_key: '5', title: 'Alpha', year: 2001, type: 'movie', marked_at: '2026-01-05 03:04:05', profile_id: 2, server_key: null },
    ]
  );
  assert.deepEqual(
    peek.prepare('SELECT id, title, year, plex_key, guid, genres, rating, rated_at, profile_id, server_key FROM personal_ratings ORDER BY id').all(),
    [
      { id: 3, title: 'Alpha', year: 2001, plex_key: '5', guid: 'plex://movie/a', genres: 'Drama, Crime', rating: 'up', rated_at: '2026-02-02 03:04:05', profile_id: 1, server_key: null },
      { id: 7, title: 'Gamma', year: 1999, plex_key: '8', guid: null, genres: 'Horror', rating: 'down', rated_at: '2026-02-03 03:04:05', profile_id: 1, server_key: null },
      { id: 8, title: 'Alpha', year: 2001, plex_key: '5', guid: null, genres: 'Drama', rating: 'down', rated_at: '2026-02-04 03:04:05', profile_id: 2, server_key: null },
    ]
  );
});

test('rebuilding a second time changes nothing', () => {
  const before = [tableSql('not_interested'), tableSql('personal_ratings'), countOf('not_interested'), countOf('personal_ratings')];
  assert.equal(feedback.migrateNotInterested(), false);
  assert.equal(ratings.migratePersonalRatings(), false);
  assert.deepEqual([tableSql('not_interested'), tableSql('personal_ratings'), countOf('not_interested'), countOf('personal_ratings')], before);
  assert.equal(peek.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'").get().n, 0);
});

test('the rebuild reports that it ran once, and a failed rebuild leaves the old table untouched', () => {
  const scratch = new Database(path.join(dataDir, 'scratch.db'));
  try {
    fillOldTables(scratch);
    const shape = (name) => OLD_NOT_INTERESTED.replace('not_interested', name).replace(
      'UNIQUE(profile_id, plex_key)',
      'server_key TEXT,\n    UNIQUE(profile_id, server_key, plex_key)'
    );
    const columns = ['plex_key', 'title', 'year', 'type', 'marked_at', 'profile_id'];

    // A new shape that cannot take the old rows: everything is rolled back.
    const tooStrict = (name) => shape(name).replace('title TEXT', 'title TEXT NOT NULL');
    assert.throws(() => addServerKey(scratch, { table: 'not_interested', createSql: tooStrict, columns }));
    assert.equal(scratch.prepare('SELECT COUNT(*) AS n FROM not_interested').get().n, 4);
    assert.equal(scratch.prepare('PRAGMA table_info(not_interested)').all().some((c) => c.name === 'server_key'), false);

    assert.equal(addServerKey(scratch, { table: 'not_interested', createSql: shape, columns }), true);
    assert.equal(scratch.prepare('SELECT COUNT(*) AS n FROM not_interested').get().n, 4);
    assert.equal(addServerKey(scratch, { table: 'not_interested', createSql: shape, columns }), false);
    // A table that is not there yet is left for its own CREATE.
    assert.equal(addServerKey(scratch, { table: 'no_such_table', createSql: shape, columns }), false);
  } finally {
    scratch.close();
  }
});

test('an older thumb is honored for the film it was given to, and no other', () => {
  const alpha = { plex_key: '5', title: 'Alpha', year: 2001 };
  assert.equal(ratings.getRating(alpha, 1, SERVER_A).rating, 'up');
  assert.deepEqual(ratings.getRating(alpha, 1, SERVER_A).genres, ['Drama', 'Crime']);
  // Same number, different film, on a server that happens to reuse the number.
  assert.equal(ratings.getRating({ plex_key: '5', title: 'Bravo', year: 2002 }, 1, SERVER_B), null);
  assert.equal(ratings.getRating({ plex_key: '5', title: 'Alpha', year: 1968 }, 1, SERVER_B), null);
  // The other viewer's older thumb is theirs alone.
  assert.equal(ratings.getRating(alpha, 2, SERVER_A).rating, 'down');
});

test('an older hidden title still hides that film, and only that film', () => {
  const hidden = feedback.getNotInterestedSet(1);
  assert.equal(hidden.has({ ratingKey: '5', title: 'Alpha', year: 2001 }, SERVER_A), true);
  assert.equal(hidden.has({ ratingKey: '5', title: 'Bravo', year: 2002 }, SERVER_A), false);
  // Saved without a year: the title decides.
  assert.equal(hidden.has({ ratingKey: '6', title: 'No Year', year: 2010 }, SERVER_A), true);
  // Saved without a title: the number is all there is.
  assert.equal(hidden.has({ ratingKey: '9', title: 'Anything', year: 1999 }, SERVER_B), true);
  // Items from the search index carry their own server.
  assert.equal(hidden.has({ ratingKey: '5', serverKey: SERVER_B, title: 'Alpha', year: 2001 }), true);
});

test('rating a different film with the same number leaves the older thumb alone', () => {
  const before = countOf('personal_ratings');
  ratings.rateItem({ plex_key: '8', serverKey: SERVER_B, title: 'Delta', year: 2020, genres: ['Comedy'] }, 'up', 1);
  assert.equal(countOf('personal_ratings'), before + 1);
  assert.equal(ratings.getRating({ plex_key: '8', title: 'Gamma', year: 1999 }, 1, SERVER_A).rating, 'down');
  assert.equal(ratings.getRating({ plex_key: '8', title: 'Delta', year: 2020 }, 1, SERVER_B).rating, 'up');
  assert.equal(ratings.getRating({ plex_key: '8', title: 'Delta', year: 2020 }, 1, SERVER_B).title, 'Delta');
});

test('re-rating a film an older thumb matches adopts the row instead of adding one', () => {
  const before = countOf('personal_ratings');
  ratings.rateItem({ plex_key: '5', serverKey: SERVER_A, title: 'Alpha', year: 2001, genres: ['Drama', 'Crime'] }, 'down', 1);
  assert.equal(countOf('personal_ratings'), before);
  const row = peek.prepare('SELECT id, server_key, rating FROM personal_ratings WHERE profile_id = 1 AND plex_key = ?').get('5');
  assert.deepEqual(row, { id: 3, server_key: SERVER_A, rating: 'down' });
  // It now belongs to server A, so the same number elsewhere has no thumb.
  assert.equal(ratings.getRating({ plex_key: '5', title: 'Alpha', year: 2001 }, 1, SERVER_B), null);
  // The other viewer's row was not touched.
  assert.equal(peek.prepare('SELECT server_key FROM personal_ratings WHERE id = 8').get().server_key, null);
});

test('hiding a film an older row matches adopts the row; un-hiding removes it', () => {
  const before = countOf('not_interested');
  const alpha = { plex_key: '5', serverKey: SERVER_A, title: 'Alpha', year: 2001, type: 'movie' };
  feedback.markNotInterested(alpha, 1);
  assert.equal(countOf('not_interested'), before);
  assert.equal(peek.prepare('SELECT server_key FROM not_interested WHERE profile_id = 1 AND plex_key = ?').get('5').server_key, SERVER_A);
  assert.equal(feedback.getNotInterestedSet(1).has({ ratingKey: '5', title: 'Alpha', year: 2001 }, SERVER_B), false);

  // An older row for the same film goes when the film is un-hidden.
  assert.equal(feedback.unmarkNotInterested({ plex_key: '6', title: 'No Year', year: 2010 }, 1, SERVER_A), true);
  assert.equal(feedback.getNotInterestedSet(1).has({ ratingKey: '6', title: 'No Year', year: 2010 }, SERVER_A), false);
  // An older row for another film stays.
  assert.equal(feedback.unmarkNotInterested({ plex_key: '5', title: 'Bravo', year: 2002 }, 2, SERVER_A), false);
  assert.equal(feedback.getNotInterestedSet(2).has({ ratingKey: '5', title: 'Alpha', year: 2001 }, SERVER_A), true);
});

test('two films with the same number on two servers get their own thumbs', () => {
  const heat = { plex_key: '100', serverKey: SERVER_A, title: 'Heat', year: 1995, type: 'movie', genres: ['Crime', 'Thriller'] };
  const bear = { plex_key: '100', serverKey: SERVER_B, title: 'Paddington', year: 2014, type: 'movie', genres: ['Family'] };
  ratings.rateItem(heat, 'up', 3);
  ratings.rateItem(bear, 'down', 3);

  const onA = ratings.getRating(heat, 3);
  const onB = ratings.getRating(bear, 3);
  assert.deepEqual([onA.rating, onA.title, onA.server_key], ['up', 'Heat', SERVER_A]);
  assert.deepEqual([onB.rating, onB.title, onB.server_key], ['down', 'Paddington', SERVER_B]);
  // Recommendations learn each film's own genres.
  assert.deepEqual(ratings.getLikedGenres(3), { Crime: 1, Thriller: 1 });
  assert.deepEqual(ratings.getDislikedGenres(3), { Family: 1 });

  // Changing one thumb changes that row only.
  ratings.rateItem(heat, 'down', 3);
  assert.equal(ratings.getRating(heat, 3).rating, 'down');
  assert.equal(ratings.getRating(bear, 3).rating, 'down');
  assert.equal(ratings.getAllRatings('all', 3).length, 2);

  // Un-rating one server's film leaves the other.
  assert.equal(ratings.removeRating(heat, 3), true);
  assert.equal(ratings.getRating(heat, 3), null);
  assert.equal(ratings.getRating(bear, 3).rating, 'down');
  assert.equal(ratings.removeRating(heat, 3), false);
});

test('two films with the same number on two servers are hidden separately', () => {
  const heat = { ratingKey: '100', title: 'Heat', year: 1995, type: 'movie' };
  const bear = { ratingKey: '100', title: 'Paddington', year: 2014, type: 'movie' };

  feedback.markNotInterested({ ...heat, serverKey: SERVER_A }, 3);
  assert.equal(feedback.getNotInterestedSet(3).has(heat, SERVER_A), true);
  assert.equal(feedback.getNotInterestedSet(3).has(bear, SERVER_B), false);

  // Hiding the second film used to do nothing, because the slot was taken.
  feedback.markNotInterested({ ...bear, serverKey: SERVER_B }, 3);
  assert.equal(feedback.isNotInterested(bear, 3, SERVER_B), true);
  assert.deepEqual(
    feedback.listNotInterested(3).map((row) => [row.server_key, row.title, row.year]).sort(),
    [[SERVER_A, 'Heat', 1995], [SERVER_B, 'Paddington', 2014]]
  );

  // Un-hiding one server's film leaves the other.
  assert.equal(feedback.unmarkNotInterested(heat, 3, SERVER_A), true);
  assert.equal(feedback.getNotInterestedSet(3).has(heat, SERVER_A), false);
  assert.equal(feedback.getNotInterestedSet(3).has(bear, SERVER_B), true);
  assert.equal(feedback.unmarkNotInterested(heat, 3, SERVER_A), false);
});

test('a request without a server behaves as before, and never touches a server\'s row', () => {
  ratings.rateItem({ plex_key: '200', serverKey: SERVER_A, title: 'Ran', year: 1985 }, 'up', 3);

  // An old page: no server. It gets its own row and stores its own title.
  ratings.rateItem({ plex_key: '200', title: 'Old Page Film', year: 1970 }, 'down', 3);
  assert.equal(ratings.getRating('200', 3).title, 'Old Page Film');
  ratings.rateItem({ plex_key: '200', title: 'Another Film', year: 1980, genres: ['Western'] }, 'up', 3);
  const old = ratings.getRating('200', 3);
  assert.deepEqual([old.title, old.year, old.rating, old.genres, old.server_key], ['Another Film', 1980, 'up', ['Western'], null]);
  assert.equal(ratings.getRating({ plex_key: '200', title: 'Ran', year: 1985 }, 3, SERVER_A).rating, 'up');

  assert.equal(ratings.removeRating('200', 3), true);
  assert.equal(ratings.removeRating('200', 3), false);
  assert.equal(ratings.getRating({ plex_key: '200', title: 'Ran', year: 1985 }, 3, SERVER_A).rating, 'up');

  feedback.markNotInterested({ plex_key: '300', title: 'First', year: 1990 }, 3);
  feedback.markNotInterested({ plex_key: '300', title: 'Second', year: 1991 }, 3);
  const rows = feedback.listNotInterested(3).filter((row) => row.plex_key === '300');
  assert.deepEqual(rows.map((row) => [row.server_key, row.title, row.year]), [[null, 'Second', 1991]]);
  assert.equal(feedback.unmarkNotInterested('300', 3), true);
});

test('shelves and picks skip a hidden film only on its own server', () => {
  const profile = 4;
  const film = { ratingKey: '400', title: 'Stalker', year: 1979, type: 'movie', genres: ['Sci-Fi'], imdbRating: 8.1, viewCount: 0 };
  feedback.markNotInterested({ ...film, serverKey: SERVER_A }, profile);

  assert.equal(recommendations.hiddenGems({ items: [film], serverKey: SERVER_A, profileId: profile }).length, 0);
  assert.equal(recommendations.hiddenGems({ items: [film], serverKey: SERVER_B, profileId: profile }).length, 1);
  assert.equal(pickTonight({ items: [film], serverKey: SERVER_A, moodId: 'mindbend', includeWatched: true, profileId: profile }).length, 0);
  assert.equal(pickTonight({ items: [film], serverKey: SERVER_B, moodId: 'mindbend', includeWatched: true, profileId: profile }).length, 1);
});

test('"because you liked" starts from this server\'s film, not another film with its number', () => {
  const profile = 5;
  const liked = { ratingKey: '500', title: 'Alien', year: 1979, type: 'movie', genres: ['Horror', 'Sci-Fi'], imdbRating: 8.5 };
  ratings.rateItem({ plex_key: '500', serverKey: SERVER_A, title: 'Alien', year: 1979, genres: liked.genres }, 'up', profile);

  const similar = [1, 2, 3, 4].map((n) => ({
    ratingKey: String(510 + n), title: `Space Horror ${n}`, year: 1980, type: 'movie', genres: ['Horror', 'Sci-Fi'], imdbRating: 7.5,
  }));
  const rowsOnA = recommendations.becauseYouLikedRows({ items: [liked, ...similar], serverKey: SERVER_A, profileId: profile });
  assert.equal(rowsOnA.length, 1);
  assert.equal(rowsOnA[0].seed.title, 'Alien');

  // Server B has an unrelated film numbered 500.
  const unrelated = { ratingKey: '500', title: 'Babe', year: 1995, type: 'movie', genres: ['Horror', 'Sci-Fi'], imdbRating: 7 };
  assert.equal(recommendations.becauseYouLikedRows({ items: [unrelated, ...similar], serverKey: SERVER_B, profileId: profile }).length, 0);
});

test('the page shows a thumb only on the film it belongs to', () => {
  const rows = [
    { server_key: SERVER_A, plex_key: '100', title: 'Heat', year: 1995, rating: 'up' },
    { server_key: null, plex_key: '5', title: 'Alpha', year: 2001, rating: 'down' },
  ];
  const ratingFor = clientRatings.ratingLookup(rows);
  assert.equal(ratingFor({ ratingKey: '100', title: 'Heat', year: 1995 }, SERVER_A), 'up');
  assert.equal(ratingFor({ ratingKey: '100', title: 'Paddington', year: 2014 }, SERVER_B), undefined);
  assert.equal(ratingFor({ ratingKey: '100', serverKey: SERVER_B, title: 'Heat', year: 1995 }, SERVER_A), undefined);
  // An older thumb follows its title, on whichever server that film is.
  assert.equal(ratingFor({ ratingKey: '5', title: 'Alpha', year: 2001 }, SERVER_B), 'down');
  assert.equal(ratingFor({ ratingKey: '5', title: 'Bravo', year: 2002 }, SERVER_B), undefined);

  // Re-rating the older film on server B replaces its row; un-rating removes it.
  const alpha = { ratingKey: '5', title: 'Alpha', year: 2001 };
  const rerated = clientRatings.withRatingChange(rows, alpha, SERVER_B, 'up');
  assert.deepEqual(rerated.map((row) => [row.server_key, row.plex_key, row.rating]), [[SERVER_B, '5', 'up'], [SERVER_A, '100', 'up']]);
  assert.equal(clientRatings.ratingLookup(rerated)(alpha, SERVER_A), undefined);
  assert.deepEqual(clientRatings.withRatingChange(rerated, alpha, SERVER_B, null).map((row) => row.plex_key), ['100']);
  // A change to another film with the same number leaves this one alone.
  assert.equal(clientRatings.withRatingChange(rows, { ratingKey: '100', title: 'Paddington', year: 2014 }, SERVER_B, 'down').length, 3);
});

test('the routes take the server from the request, and still answer a request without one', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Profile-Id': '1' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const query = (serverKey, title, year) => `?${new URLSearchParams({ serverKey, title, year: String(year) })}`;

  try {
    await call('POST', '/api/ratings/personal', { plexKey: '600', serverKey: SERVER_A, title: 'Jaws', year: 1975, genres: ['Thriller'], rating: 'up' });
    await call('POST', '/api/ratings/personal', { plexKey: '600', serverKey: SERVER_B, title: 'Up', year: 2009, genres: ['Family'], rating: 'down' });

    assert.equal((await call('GET', `/api/ratings/personal/600${query(SERVER_A, 'Jaws', 1975)}`)).body.rating.rating, 'up');
    assert.equal((await call('GET', `/api/ratings/personal/600${query(SERVER_B, 'Up', 2009)}`)).body.rating.rating, 'down');
    // An old page asks by number alone: there is no row without a server.
    assert.equal((await call('GET', '/api/ratings/personal/600')).body.rating, null);
    assert.equal((await call('DELETE', '/api/ratings/personal/600')).status, 404);

    const all = (await call('GET', '/api/ratings/personal')).body.ratings.filter((row) => row.plex_key === '600');
    assert.deepEqual(all.map((row) => row.server_key).sort(), [SERVER_A, SERVER_B]);

    assert.equal((await call('DELETE', `/api/ratings/personal/600${query(SERVER_A, 'Jaws', 1975)}`)).status, 200);
    assert.equal((await call('GET', `/api/ratings/personal/600${query(SERVER_A, 'Jaws', 1975)}`)).body.rating, null);
    assert.equal((await call('GET', `/api/ratings/personal/600${query(SERVER_B, 'Up', 2009)}`)).body.rating.rating, 'down');

    // An older thumb (no server) is found by title through the route, too.
    assert.equal((await call('GET', `/api/ratings/personal/8${query(SERVER_A, 'Gamma', 1999)}`)).body.rating.rating, 'down');
    assert.equal((await call('GET', `/api/ratings/personal/8${query(SERVER_A, 'Other', 1999)}`)).body.rating, null);
    // An old page still rates and un-rates by number alone.
    assert.equal((await call('POST', '/api/ratings/personal', { plexKey: '700', title: 'Old Page', year: 2000, rating: 'up' })).status, 200);
    assert.equal((await call('GET', '/api/ratings/personal/700')).body.rating.rating, 'up');
    assert.equal((await call('DELETE', '/api/ratings/personal/700')).status, 200);

    assert.equal((await call('POST', '/api/feedback/not-interested', { plex_key: '600', serverKey: SERVER_A, title: 'Jaws', year: 1975 })).status, 201);
    assert.equal((await call('POST', '/api/feedback/not-interested', { plex_key: '600', serverKey: SERVER_B, title: 'Up', year: 2009 })).status, 201);
    assert.equal((await call('DELETE', `/api/feedback/not-interested/600${query(SERVER_A, 'Jaws', 1975)}`)).status, 200);
    const hidden = (await call('GET', '/api/feedback/not-interested')).body.items.filter((row) => row.plex_key === '600');
    assert.deepEqual(hidden.map((row) => [row.server_key, row.title]), [[SERVER_B, 'Up']]);
    assert.equal((await call('DELETE', '/api/feedback/not-interested/600')).status, 404);
  } finally {
    server.close();
  }
});
