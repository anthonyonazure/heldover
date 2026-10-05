// New-episode alerts come from what a Plex server lists under a followed show,
// and the server may be someone else's. An alert row used to have no key for
// its episode: a list that got shorter and longer again stored the same
// episodes a second time, two checks that overlapped both stored them, and
// nothing limited or removed the rows while the show was followed.
//
// These checks pin the rules that replaced that: one row for one episode of a
// show, also for the rows already on file; a limit on what one check adds and
// on what one show keeps; one check at a time; and a bounded alert list.
// Runs against a throwaway data folder and a stand-in Plex server.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { DUMMY_TOKEN, listenForTest, startStandInPlex, stubPlexTv } from './helpers/stand-in-plex.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = DUMMY_TOKEN;
// The stand-in server here is plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY']) delete process.env[key];

const SERVER = 'stand-in-alerts';

// ---------- A database as the version before this rule left it ----------
//
// The two tables exactly as that version made them, with alerts stored more
// than once. Written before the app is imported, so the app finds them at
// start the way it will on a real install.

const OLD_SHOW = 1; // followed on a server that is no longer on the list
const LONG_SHOW = 2; // has more alerts on file than a show may keep
{
  const old = new Database(path.join(process.env.DATA_DIR, 'ratings.db'));
  old.exec(`
    CREATE TABLE show_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      plex_key TEXT,
      guid TEXT,
      server_key TEXT,
      library_key TEXT,
      thumb TEXT,
      last_known_episodes INTEGER DEFAULT 0,
      last_checked_at TEXT,
      new_episodes_count INTEGER DEFAULT 0,
      subscribed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(server_key, plex_key)
    );
    CREATE TABLE episode_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id INTEGER REFERENCES show_subscriptions(id) ON DELETE CASCADE,
      episode_title TEXT,
      season_number INTEGER,
      episode_number INTEGER,
      added_at TEXT,
      seen_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_episode_alerts_subscription ON episode_alerts(subscription_id);
  `);
  const follow = old.prepare('INSERT INTO show_subscriptions (id, title, plex_key, server_key, last_known_episodes) VALUES (?, ?, ?, ?, ?)');
  follow.run(OLD_SHOW, 'Dummy Old Series', '900', 'stand-in-not-on-the-list', 3);
  follow.run(LONG_SHOW, 'Dummy Long Series', '901', 'stand-in-not-on-the-list', 510);
  const alert = old.prepare('INSERT INTO episode_alerts (subscription_id, episode_title, season_number, episode_number, added_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)');
  const when = '2026-01-01T00:00:00.000Z';
  // Episode 1: three copies, the second one marked seen.
  alert.run(OLD_SHOW, 'Dummy Old Episode 1', 1, 1, when, null);
  alert.run(OLD_SHOW, 'Dummy Old Episode 1', 1, 1, when, '2026-01-05 10:00:00');
  alert.run(OLD_SHOW, 'Dummy Old Episode 1', 1, 1, when, null);
  // Episode 2: two copies, neither seen. The second was stored after the episode got its real title.
  alert.run(OLD_SHOW, 'Episode 2', 1, 2, when, null);
  alert.run(OLD_SHOW, 'Dummy Old Episode 2', 1, 2, when, null);
  // Episode 3: one row, seen.
  alert.run(OLD_SHOW, 'Dummy Old Episode 3', 1, 3, when, '2026-01-06 10:00:00');
  // Filed by date, with no episode number: two different days, the first stored twice.
  alert.run(OLD_SHOW, 'Dummy 2026-01-01', 2026, 0, when, null);
  alert.run(OLD_SHOW, 'Dummy 2026-01-02', 2026, 0, when, null);
  alert.run(OLD_SHOW, 'Dummy 2026-01-01', 2026, 0, when, null);
  old.transaction(() => {
    for (let n = 1; n <= 510; n++) alert.run(LONG_SHOW, `Dummy Long Episode ${n}`, 1, n, when, null);
  })();
  old.close();
}

// ---------- The stand-in server ----------

const episodesOf = (show, count, { retitleLast = false } = {}) =>
  Array.from({ length: count }, (_, i) => ({
    ratingKey: String(show * 1000 + i + 1),
    type: 'episode',
    title: retitleLast && i === count - 1 ? `Dummy Real Title ${i + 1}` : `Dummy Episode ${i + 1}`,
    parentIndex: 1,
    index: i + 1,
    addedAt: 1700000000 + i,
  }));

// The stand-in answers /allLeaves from these arrays, by reference, so a test
// changes one between checks the way a server's answer changes.
const SHOWS = ['21', '22', '23', '24'];
const leaves = Object.fromEntries(SHOWS.map((show) => [show, []]));
const setAnswer = (show, entries) => leaves[show].splice(0, leaves[show].length, ...entries);

const plex = await startStandInPlex({
  serverKey: SERVER,
  sections: [{ key: '2', type: 'show', title: 'Series' }],
  items: { 2: SHOWS.map((show) => ({ ratingKey: show, type: 'show', title: `Dummy Series ${show}`, year: 2005 })) },
  leaves,
});
const refused = stubPlexTv([plex]);

// What the app says while it starts, so the tidy-up line can be read.
const startLines = [];
const realLog = console.log;
console.log = (...args) => {
  startLines.push(args.join(' '));
  realLog(...args);
};
const { app, ensureServers } = await import('../src/app.js');
await import('../src/routes/subscriptions.js');
const subscriptions = await import('../src/subscriptions.js');
console.log = realLog;
const { openRatingsDb } = await import('../src/db.js');
const { call, close } = await listenForTest(app);
const db = openRatingsDb();

after(async () => {
  await close();
  await plex.stop();
  db.close();
});

const servers = await ensureServers();
/** The check the hourly timer and the six-hour scan both run. */
const check = () => subscriptions.checkForNewEpisodes(servers, DUMMY_TOKEN);
const rowsOf = (subscriptionId) => db.prepare('SELECT * FROM episode_alerts WHERE subscription_id = ? ORDER BY id').all(subscriptionId);
const countAll = () => db.prepare('SELECT COUNT(*) AS c FROM episode_alerts').get().c;
const asked = (show) => plex.asked(`/library/metadata/${show}/allLeaves`);

/** Follow a show while the server lists no episodes under it, as the owner. Returns the subscription id. */
async function follow(show) {
  setAnswer(show, []);
  const made = await call('POST', '/api/subscriptions', { body: { title: `Dummy Series ${show}`, plex_key: show, server_key: SERVER } });
  assert.equal(made.status, 201);
  assert.equal(made.body.subscription.last_known_episodes, 0);
  return made.body.subscription.id;
}

// ---------- The rows already on file ----------

test('alerts stored before this rule keep one row for each episode, and a copy that was marked seen keeps the episode seen', () => {
  const rows = rowsOf(OLD_SHOW);
  assert.deepEqual(
    rows.map((row) => [row.season_number, row.episode_number, row.episode_title, row.seen_at]),
    [
      [1, 1, 'Dummy Old Episode 1', '2026-01-05 10:00:00'],
      [1, 2, 'Episode 2', null],
      [1, 3, 'Dummy Old Episode 3', '2026-01-06 10:00:00'],
      [2026, 0, 'Dummy 2026-01-01', null],
      [2026, 0, 'Dummy 2026-01-02', null],
    ]
  );
  assert.equal(rows.every((row) => typeof row.episode_key === 'string' && row.episode_key.length > 0), true, 'every row has its key');
  // The earliest row of each episode is the one kept.
  assert.deepEqual(rows.map((row) => row.id), [1, 4, 6, 7, 8]);
});

test('a show with more alerts on file than it may keep is cut back to its newest', () => {
  const rows = rowsOf(LONG_SHOW);
  assert.equal(rows.length, 500);
  assert.equal(rows[0].episode_number, 11);
  assert.equal(rows.at(-1).episode_number, 510);
});

test('the log says how many stored alerts were changed and removed, and never a title', () => {
  const said = startLines.filter((line) => line.startsWith('[subscriptions]'));
  assert.equal(said.length, 1, 'one line');
  assert.match(said[0], /515 given an episode key, 4 repeats removed, 10 removed beyond the newest 500/);
  assert.equal(said[0].includes('Dummy'), false);
});

test('tidying the stored alerts again changes nothing, and a row an older version adds later is folded in at the next start', async () => {
  const before = db.prepare('SELECT * FROM episode_alerts ORDER BY id').all();
  // The module runs its tidy-up when it is loaded; loading a second copy of
  // it is a second start on the same database.
  await import('../src/subscriptions.js?second-start');
  assert.deepEqual(db.prepare('SELECT * FROM episode_alerts ORDER BY id').all(), before);

  // An older version, run again for a while, stores rows with no key.
  db.prepare("INSERT INTO episode_alerts (subscription_id, episode_title, season_number, episode_number, added_at, seen_at) VALUES (?, 'Dummy Old Episode 2', 1, 2, '2026-02-01T00:00:00.000Z', '2026-02-02 09:00:00')").run(OLD_SHOW);
  db.prepare("INSERT INTO episode_alerts (subscription_id, episode_title, season_number, episode_number, added_at) VALUES (?, 'Dummy Old Episode 4', 1, 4, '2026-02-01T00:00:00.000Z')").run(OLD_SHOW);
  await import('../src/subscriptions.js?third-start');
  const rows = rowsOf(OLD_SHOW);
  assert.deepEqual(rows.map((row) => row.episode_number), [1, 2, 3, 0, 0, 4]);
  assert.equal(rows[1].id, 4, 'the earlier row of episode 2 is kept');
  assert.equal(rows[1].seen_at, '2026-02-02 09:00:00', 'and is seen now, because its copy was');
  assert.equal(rows.every((row) => row.episode_key), true);
});

// ---------- New alerts ----------

let show21;

test('an episode list that gets shorter and longer again stores each episode once', async () => {
  show21 = await follow('21');
  const reported = [];
  for (const length of [20, 0, 20, 0, 20]) {
    setAnswer('21', episodesOf(21, length));
    reported.push((await check()).filter((s) => s.id === show21).map((s) => s.newCount));
  }
  assert.equal(rowsOf(show21).length, 20);
  assert.deepEqual(reported, [[20], [], [], [], []], 'only the first check announces anything');
});

test('an episode that drops out of the list and comes back, even under a new title, is not announced twice', async () => {
  setAnswer('21', episodesOf(21, 19));
  await check();
  setAnswer('21', episodesOf(21, 20, { retitleLast: true }));
  const withNew = await check();
  assert.deepEqual(withNew.filter((s) => s.id === show21), []);
  assert.equal(rowsOf(show21).length, 20);
});

test('an alert that was marked seen stays on file, so its episode is not announced again', async () => {
  const marked = await call('POST', `/api/subscriptions/${show21}/alerts/seen-all`);
  assert.equal(marked.body.markedCount, 20);
  setAnswer('21', []);
  await check();
  setAnswer('21', episodesOf(21, 20));
  await check();
  const rows = rowsOf(show21);
  assert.equal(rows.length, 20);
  assert.equal(rows.every((row) => row.seen_at !== null), true);
});

test('two checks started at the same moment are one check: the server is asked once and each episode is stored once', async () => {
  const show22 = await follow('22');
  setAnswer('22', episodesOf(22, 20));
  const askedBefore = asked('22');
  const [first, second] = await Promise.all([check(), check()]);
  assert.equal(asked('22') - askedBefore, 1);
  assert.equal(rowsOf(show22).length, 20);
  assert.deepEqual(first.filter((s) => s.id === show22).map((s) => s.newCount), [20]);
  assert.equal(second, first, 'the second caller is given the first check\'s answer');

  // And the next check is a new one, not the old answer again.
  setAnswer('22', episodesOf(22, 21));
  assert.deepEqual((await check()).filter((s) => s.id === show22).map((s) => s.newCount), [1]);
});

test('entries with no episode number are told apart by their titles', async () => {
  const show23 = await follow('23');
  const byDate = (day) => ({ ratingKey: `2300${day}`, type: 'episode', title: `Dummy 2026-03-0${day}`, parentIndex: 2026, addedAt: 1700000000 + day });
  setAnswer('23', [byDate(1), byDate(2)]);
  await check();
  setAnswer('23', []);
  await check();
  setAnswer('23', [byDate(1), byDate(2), byDate(3)]);
  await check();
  assert.deepEqual(rowsOf(show23).map((row) => row.episode_title), ['Dummy 2026-03-01', 'Dummy 2026-03-02', 'Dummy 2026-03-03']);
});

test('one check adds only the newest few alerts for a show, and a show keeps only its newest', async () => {
  const show24 = await follow('24');
  subscriptions.setAlertLimitsForTests({ perCheck: 5, perSubscription: 8 });
  try {
    setAnswer('24', episodesOf(24, 12));
    assert.deepEqual((await check()).filter((s) => s.id === show24).map((s) => s.newCount), [5]);
    assert.deepEqual(rowsOf(show24).map((row) => row.episode_number), [8, 9, 10, 11, 12]);

    setAnswer('24', episodesOf(24, 17));
    await check();
    assert.deepEqual(rowsOf(show24).map((row) => row.episode_number), [10, 11, 12, 13, 14, 15, 16, 17]);
  } finally {
    subscriptions.setAlertLimitsForTests({ perCheck: 50, perSubscription: 500 });
  }
});

// ---------- Reading the alerts ----------

test('the alert list hands out the newest few and says how many there are in all', async () => {
  const unseen = db.prepare('SELECT COUNT(*) AS c FROM episode_alerts WHERE seen_at IS NULL').get().c;
  assert.equal(unseen > 3, true);
  subscriptions.setAlertLimitsForTests({ returned: 3 });
  try {
    const list = await call('GET', '/api/subscriptions/alerts', { lookOnly: true });
    assert.equal(list.status, 200);
    assert.equal(list.body.alerts.length, 3);
    assert.equal(list.body.count, 3);
    assert.equal(list.body.total, unseen);
    const badge = await call('GET', '/api/subscriptions/alerts/count', { lookOnly: true });
    assert.equal(badge.body.count, unseen);
  } finally {
    subscriptions.setAlertLimitsForTests({ returned: 200 });
  }
});

test('the unseen list and the unseen count read through an index instead of the whole table', () => {
  const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => row.detail);
  // The two statements of subscriptions.js.
  const list = plan(
    `SELECT a.*, s.title as show_title, s.thumb as show_thumb, s.plex_key as show_plex_key
     FROM episode_alerts a JOIN show_subscriptions s ON a.subscription_id = s.id
     WHERE a.seen_at IS NULL ORDER BY a.created_at DESC LIMIT ?`,
    200
  );
  assert.equal(list.some((line) => line.includes('idx_episode_alerts_unseen')), true, list.join(' | '));
  assert.equal(list.some((line) => line.includes('TEMP B-TREE')), false, list.join(' | '));
  const count = plan('SELECT COUNT(*) as count FROM episode_alerts WHERE seen_at IS NULL');
  assert.equal(count.some((line) => line.includes('idx_episode_alerts_unseen')), true, count.join(' | '));
});

test('a device that may only look cannot start a check', async () => {
  const res = await call('POST', '/api/subscriptions/check-episodes', { lookOnly: true });
  assert.equal(res.status, 403);
});

test('no row of any show is stored twice, and nothing in these checks left this computer', () => {
  const repeated = db.prepare('SELECT subscription_id, episode_key, COUNT(*) AS c FROM episode_alerts GROUP BY subscription_id, episode_key HAVING c > 1').all();
  assert.deepEqual(repeated, []);
  assert.equal(countAll() > 0, true);
  assert.deepEqual(refused, []);
});
